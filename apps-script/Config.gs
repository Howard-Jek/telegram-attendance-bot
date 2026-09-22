/**
 * Sheet layout and the Config tab (key | value), read once per request.
 * BOT_TOKEN is never stored here: it lives in Script Properties only.
 */

const TZ_ = 'Asia/Singapore';
const LOCK_WAIT_MS_ = 10000;

// The web app's /exec URL, used by setup() to point the bot's webhook here. Not a secret (the Mini
// App calls it too). A WEBAPP_URL Script Property overrides it, e.g. for a copy of this project.
const WEBAPP_URL_ = 'https://script.google.com/macros/s/AKfycbz9ACA6aEHOyvUXNp38ty_ANlMjeDucefyH_mXjXHTGU8AaRKxVBX6jTgnYE9Wahehz/exec';

const SHEETS_ = {
  CONFIG: 'Config',
  SESSIONS: 'Sessions',
  LOG: 'Log',
  REJECTED: 'Rejected',
  GROUPS: 'Groups',
  MEMBERS: 'Members',
};

const HEADERS_ = {
  Config: ['key', 'value'],
  Sessions: ['session_id', 'started_by_id', 'started_by_name', 'opens_at', 'closes_at',
    'announcement_message_id', 'status', 'checkin_count', 'site_lat', 'site_lng', 'site_accuracy_m'],
  Log: ['timestamp', 'session_id', 'user_id', 'first_name', 'last_name', 'username',
    'latitude', 'longitude', 'accuracy_m', 'distance_m', 'dedupe_key', 'full_name', 'group'],
  Rejected: ['timestamp', 'session_id', 'user_id', 'name', 'username', 'reason',
    'latitude', 'longitude', 'accuracy_m', 'distance_m'],
  Groups: ['group'],
  Members: ['user_id', 'full_name', 'group', 'telegram_name', 'username', 'updated_at'],
};

// 1-based column numbers.
const SESSION_COL_ = { ID: 1, STARTED_BY_ID: 2, STARTED_BY_NAME: 3, OPENS_AT: 4, CLOSES_AT: 5,
  MESSAGE_ID: 6, STATUS: 7, COUNT: 8, SITE_LAT: 9, SITE_LNG: 10, SITE_ACCURACY: 11 };
const LOG_COL_ = { TIMESTAMP: 1, SESSION_ID: 2, DEDUPE_KEY: 11, FULL_NAME: 12, GROUP: 13 };
const MEMBER_COL_ = { USER_ID: 1, FULL_NAME: 2, GROUP: 3, TELEGRAM_NAME: 4, USERNAME: 5, UPDATED_AT: 6 };

// Blank means "not set". GROUP_CHAT_ID is filled in by the bot when it is added to a group.
const CONFIG_DEFAULTS_ = {
  GROUP_CHAT_ID: '',
  MINI_APP_LINK: '',
  RADIUS_M: 150,
  MAX_ACCURACY_M: 100,
  SESSION_MINUTES: 60,
  INITDATA_MAX_AGE_MIN: 15,
  ADMIN_IDS: '', // optional: people who may start check-ins without being Telegram group admins
};

const CONFIG_CHECKS_ = {
  RADIUS_M: (c) => c.radiusM > 0,
  MAX_ACCURACY_M: (c) => c.maxAccuracyM > 0,
  SESSION_MINUTES: (c) => c.sessionMinutes >= 1, // >= 1 keeps S-yyyyMMdd-HHmm ids unique
  INITDATA_MAX_AGE_MIN: (c) => c.initDataMaxAgeMin > 0,
  GROUP_CHAT_ID: (c) => /^-\d+$/.test(c.groupChatId),
  ADMIN_IDS: (c) => c.adminIds.every((id) => /^\d+$/.test(id)),
  MINI_APP_LINK: (c) => /^https:\/\/t\.me\/[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)?\/?(\?[^\s]*)?$/.test(c.miniAppLink),
};

/**
 * The Config tab, from a copy up to a minute old (see Cache.gs). Pass fresh=true where a
 * decision must see the Sheet as it is now (e.g. under the lock before writing GROUP_CHAT_ID).
 */
function loadConfig_(fresh) {
  const cacheKey = configCacheKey_(); // read before the Sheet, so a concurrent change can't be masked
  let raw = fresh ? null : cacheGetJson_(cacheKey);
  if (!raw || typeof raw !== 'object') {
    raw = {};
    sheet_(SHEETS_.CONFIG).getDataRange().getValues().forEach((row) => {
      const key = String(row[0]).trim();
      if (key) raw[key] = row[1];
    });
    cachePutJson_(cacheKey, raw, CACHE_SEC_.CONFIG);
  }
  const val = (key) => (isBlank_(raw[key]) ? CONFIG_DEFAULTS_[key] : raw[key]);
  return {
    radiusM: toNumber_(val('RADIUS_M')),
    maxAccuracyM: toNumber_(val('MAX_ACCURACY_M')),
    sessionMinutes: toNumber_(val('SESSION_MINUTES')),
    initDataMaxAgeMin: toNumber_(val('INITDATA_MAX_AGE_MIN')),
    adminIds: String(val('ADMIN_IDS')).split(',').map((s) => s.trim()).filter(Boolean),
    groupChatId: String(val('GROUP_CHAT_ID')).trim(),
    miniAppLink: normalizeLink_(String(val('MINI_APP_LINK')).trim()),
  };
}

/** "t.me/bot/app" and "http://t.me/..." become "https://t.me/...", the only form Telegram buttons accept. */
function normalizeLink_(link) {
  return link.replace(/^(https?:\/\/)?(www\.)?t\.me\//i, 'https://t.me/');
}

/** Throws SetupError_ naming every listed Config key that is missing or invalid. */
function assertConfig_(cfg, keys) {
  const bad = keys.filter((k) => !CONFIG_CHECKS_[k](cfg));
  if (!bad.length) return;
  if (bad.length === 1 && bad[0] === 'GROUP_CHAT_ID' && !cfg.groupChatId) {
    throw new SetupError_('Check-in isn’t connected to a group yet. Add the bot to your group as an admin.');
  }
  throw new SetupError_('Check-in is not set up yet (Config: ' + bad.join(', ') + '). Please tell an admin.');
}

/**
 * Writes one Config value as plain text, adding the row if the key is missing. The cell is
 * formatted as plain text first, so "-100123..." stays text; no leading apostrophe, because a
 * plain-text cell may keep it as part of the value. Only for values the bot itself produces,
 * such as chat ids. Callers that decide based on the current value should hold the script lock.
 */
function setConfigValue_(key, value) {
  const sheet = sheet_(SHEETS_.CONFIG);
  const keys = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), 1).getValues();
  let row = 0;
  for (let i = 0; i < keys.length && !row; i++) {
    if (String(keys[i][0]).trim() === key) row = i + 1;
  }
  if (!row) {
    sheet.appendRow([key, '']);
    row = sheet.getLastRow();
  }
  sheet.getRange(row, 2).setNumberFormat('@').setValue(String(value));
  SpreadsheetApp.flush();
  bumpConfigCache_();
}

function isBlank_(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function toNumber_(v) {
  return isBlank_(v) ? NaN : Number(String(v).trim());
}

let openedSpreadsheet_ = null; // opened once per request; doPost resets it

/**
 * getActiveSpreadsheet() is not available when a bound script runs as a web app, so
 * requests open the Sheet by the id that setup() stored in Script Properties.
 */
function spreadsheet_() {
  if (!openedSpreadsheet_) {
    const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    openedSpreadsheet_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
    perfMark_('sheetOpen');
    if (!openedSpreadsheet_) throw new SetupError_('The bot is not set up yet (SPREADSHEET_ID missing). The owner needs to run setup().');
  }
  return openedSpreadsheet_;
}

/**
 * Rows are read and written by column position, so a changed header row (an inserted or
 * deleted column) must stop the request rather than silently misread the data.
 */
function assertHeaders_(name, headerRow) {
  const expected = HEADERS_[name];
  if (expected.every((h, i) => String(headerRow[i]).trim() === h)) return;
  // Columns added by an update are appended by setup(); until it runs, say that instead.
  const filled = expected.filter((h, i) => String(headerRow[i]).trim() !== '').length;
  if (filled > 0 && expected.slice(0, filled).every((h, i) => String(headerRow[i]).trim() === h)) {
    throw new SetupError_('The bot was updated. The owner needs to run setup() once in the Apps Script editor.');
  }
  throw new SetupError_('The "' + name + '" tab\'s columns were changed. Restore its header row to: ' +
    expected.join(', ') + '.');
}

function sheet_(name) {
  const sheet = spreadsheet_().getSheetByName(name);
  if (!sheet) {
    throw new SetupError_('The "' + name + '" tab is missing. The owner needs to run setup() in the Apps Script editor.');
  }
  return sheet;
}
