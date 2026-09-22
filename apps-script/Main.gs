/**
 * Web app entry point. Two callers share doPost:
 *   - the Mini App: POST <exec-url>, text/plain body {action, initData, platform, ...}
 *     -> {ok, code, message, data?}. Apps Script always answers HTTP 200 (after a redirect),
 *     so the outcome is carried in `code`.
 *   - Telegram's webhook: POST <exec-url>?hook=<WEBHOOK_SECRET>, a JSON update (Webhook.gs).
 *
 * Keep top-level code to plain constants: Apps Script runs files in project order,
 * so a top-level reference to another file's function can fail at load time.
 */

const MESSAGES_ = {
  NO_ACTIVE_SESSION: 'No check-in is open right now.',
  NOT_ADMIN: 'Only admins of the group can start or move a check-in.',
  NOT_MEMBER: 'Only members of the group can check in. If you just joined, try again in a minute.',
  UNSUPPORTED_PLATFORM: 'Open this on your phone to check in.',
  AUTH_FAILED: 'Could not verify your Telegram account. Close this and tap the Check in button in the group again.',
  AUTH_EXPIRED: 'This page has been open too long. Close it and tap the Check in button in the group again.',
  BUSY: 'The server is busy. Please try again in a moment.',
  BAD_REQUEST: 'Invalid request.',
  SERVER_ERROR: 'Something went wrong. Please try again, or tell an admin.',
};

// Called with (ctx, body). Wrapped in functions so no other file is referenced at load time.
const ACTIONS_ = {
  status: (ctx) => handleStatus_(ctx),
  startSession: (ctx, body) => handleStartSession_(ctx, body),
  moveSite: (ctx, body) => handleMoveSite_(ctx, body),
  checkin: (ctx, body) => handleCheckin_(ctx, body),
  saveProfile: (ctx, body) => handleSaveProfile_(ctx, body),
};

/** Owner-fixable setup problem; its message is safe to show to users. */
class SetupError_ extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
  }
}

function doPost(e) {
  openedSpreadsheet_ = null;
  if (e && e.parameter && e.parameter.hook !== undefined) return handleWebhook_(e);
  // The frame transport (see frameReply_) posts a form: the request body is its payload field.
  const viaFrame = !!(e && e.parameter && e.parameter.transport === 'frame');
  let res;
  try {
    res = handleRequest_(viaFrame ? { postData: { contents: String(e.parameter.payload || '') } } : e);
  } catch (err) {
    console.error('doPost: ' + redactSecrets_(err && err.stack ? err.stack : String(err)));
    const isSetup = err && err.name === 'SetupError';
    res = reply_(false, 'SERVER_ERROR', isSetup ? err.message : MESSAGES_.SERVER_ERROR);
  }
  if (viaFrame) return frameReply_(res, e.parameter.rid, e.parameter.origin);
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

function handleRequest_(e) {
  let body = null;
  try {
    body = JSON.parse(e && e.postData ? e.postData.contents : '');
  } catch (err) {
    // falls through to BAD_REQUEST
  }
  const action = body && typeof body === 'object' ? body.action : null;
  if (!Object.prototype.hasOwnProperty.call(ACTIONS_, action)) {
    return reply_(false, 'BAD_REQUEST', MESSAGES_.BAD_REQUEST);
  }

  const cfg = loadConfig_();
  assertConfig_(cfg, ['INITDATA_MAX_AGE_MIN']);
  const token = botToken_();
  const auth = verifyInitData_(body.initData, token, cfg.initDataMaxAgeMin, now_().getTime());
  if (!auth.ok) return reply_(false, auth.code, MESSAGES_[auth.code]);

  const ctx = { cfg: cfg, token: token, user: auth.user };
  return ACTIONS_[action](ctx, body);
}

// Pages allowed to receive replies through the frame transport.
const FRAME_ORIGINS_ = ['https://howard-jek.github.io', 'http://127.0.0.1:8765'];

/**
 * The frame transport's answer. ContentService replies reach the browser only through a
 * redirect to Google's reply cache (script.googleusercontent.com), which was measured taking
 * 0.3-10 s and discarding replies that aren't collected within ~25 s. HtmlService output is
 * served directly, so the Mini App loads it in a hidden frame and this page hands the reply over
 * with postMessage, addressed only to an allowed origin. The JSON is made safe inside <script>.
 */
function frameReply_(res, rid, origin) {
  let html = '';
  if (FRAME_ORIGINS_.indexOf(String(origin)) !== -1) {
    const msg = JSON.stringify({ attendanceReply: true, rid: String(rid || '').slice(0, 40), res: res })
      .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    html = '<script>window.top.postMessage(' + msg + ', ' + JSON.stringify(String(origin)) + ');</script>';
  }
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function reply_(ok, code, message, data) {
  const res = { ok: ok, code: code, message: message };
  if (data !== undefined) res.data = data;
  return res;
}

/** Server clock. All time rules use this, never the phone's clock. */
function now_() {
  return new Date();
}

/**
 * Runs fn while holding the script lock. Returns null if the lock could not be
 * taken within LOCK_WAIT_MS_ (callers answer BUSY), so fn must not return null.
 */
function withScriptLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS_)) return null;
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush(); // commit writes before the next request can take the lock
    lock.releaseLock();
  }
}

/**
 * Like withScriptLock_, for saving names and groups. It uses a different lock (the owner's user
 * lock; the web app runs as its owner, so every request shares it), so saves never queue behind
 * check-ins when a crowd arrives, while saves still take turns among themselves.
 */
function withProfileLock_(fn) {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(LOCK_WAIT_MS_)) return null;
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

/**
 * User-supplied text for a cell. The leading apostrophe stops Sheets from treating it as a
 * formula or number. Formula-like text keeps a second, visible apostrophe so it stays inert
 * in a CSV export too.
 */
function textCell_(s) {
  if (!s) return '';
  return /^[=+\-@\t\r]/.test(s) ? "''" + s : "'" + s;
}

function hhmm_(date) {
  return Utilities.formatDate(date, TZ_, 'HH:mm');
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function toDate_(v) {
  return isDate_(v) ? v : new Date(v);
}

function round1_(x) {
  return Math.round(x * 10) / 10;
}

/**
 * Strips the bot token from text before it is logged (UrlFetchApp errors can include the
 * request URL). Never throws: it runs inside doPost's error handler.
 */
function redactSecrets_(text) {
  let s = String(text);
  try {
    const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
    if (token) s = s.split(token).join('<BOT_TOKEN>');
  } catch (e) {
    // Properties unavailable (e.g. quota); the pattern below still catches tokens in URLs.
  }
  return s.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<BOT_TOKEN>');
}
