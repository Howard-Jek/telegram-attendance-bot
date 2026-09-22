/**
 * One-off helpers the owner runs from the Apps Script editor (pick the function, press Run).
 *
 *   setup()     after installing or updating: prepares the Sheet, connects the bot's webhook,
 *               adds /checkin to the bot's command menu and installs the 5-minute close job.
 *               Safe to run again at any time.
 *   selfTest()  offline checks of initData verification and distance maths.
 */

function setup() {
  setupSheets();
  const token = botToken_();
  const me = tgCall_(token, 'getMe', {});
  if (!me.ok) throw new Error('Telegram rejected BOT_TOKEN (' + me.description + '). Check the BOT_TOKEN Script Property.');
  const username = me.result.username;
  PropertiesService.getScriptProperties().setProperty('BOT_USERNAME', username);
  connectWebhook_(token);
  bumpConfigCache_(); // the owner may have just edited Config
  if (!CONFIG_CHECKS_.GROUP_CHAT_ID(loadConfig_(true))) ensureConnectCode_();
  setBotCommands_(token);
  installTriggers_();
  setupReport_(token, me.result).forEach((line) => Logger.log(line));
}

/**
 * Creates any missing tabs and header cells (an update's new columns are appended; data is never
 * moved), seeds Config keys, and records this Sheet's id so the web app can open it.
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet(); // works here (editor), but not inside the web app
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  openedSpreadsheet_ = ss;
  ss.setSpreadsheetTimeZone(TZ_); // Sheets shows Date cells in the spreadsheet's zone, not the script's

  Object.keys(HEADERS_).forEach((name) => {
    const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    // A pre-existing tab may be smaller than the ranges formatted below.
    if (sheet.getMaxRows() < 2) sheet.insertRowsAfter(sheet.getMaxRows(), 999);
    const headers = HEADERS_[name];
    if (sheet.getMaxColumns() < headers.length) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
    }
    const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    headers.forEach((h, i) => {
      if (isBlank_(current[i])) sheet.getRange(1, i + 1).setValue(h).setFontWeight('bold');
    });
    sheet.setFrozenRows(1);
  });

  // Plain-text values, so "111,222" or "-100123..." are never reformatted as numbers.
  const config = ss.getSheetByName(SHEETS_.CONFIG);
  config.getRange(1, 2, config.getMaxRows(), 1).setNumberFormat('@');
  const existing = config.getDataRange().getValues().map((r) => String(r[0]).trim());
  Object.keys(CONFIG_DEFAULTS_).forEach((key) => {
    if (existing.indexOf(key) === -1) config.appendRow([key, String(CONFIG_DEFAULTS_[key])]);
  });
  ['SITE_LAT', 'SITE_LNG'].forEach((key) => {
    if (existing.indexOf(key) !== -1) Logger.log(key + ' is no longer used (each check-in is centred on the admin who starts it). You can delete that Config row.');
  });

  const stamp = 'yyyy-mm-dd hh:mm:ss';
  const sessions = ss.getSheetByName(SHEETS_.SESSIONS);
  sessions.getRange(2, SESSION_COL_.OPENS_AT, sessions.getMaxRows() - 1, 2).setNumberFormat(stamp);
  [SHEETS_.LOG, SHEETS_.REJECTED].forEach((name) => {
    const sheet = ss.getSheetByName(name);
    sheet.getRange(2, 1, sheet.getMaxRows() - 1, 1).setNumberFormat(stamp);
  });
  const members = ss.getSheetByName(SHEETS_.MEMBERS);
  members.getRange(2, MEMBER_COL_.UPDATED_AT, members.getMaxRows() - 1, 1).setNumberFormat(stamp);
}

/** Points the bot's webhook at this web app, with a secret only Telegram and this script know. */
function connectWebhook_(token) {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('WEBHOOK_SECRET');
  if (!secret) {
    secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('WEBHOOK_SECRET', secret);
  }
  const base = props.getProperty('WEBAPP_URL') || WEBAPP_URL_;
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(base)) {
    throw new Error('WEBAPP_URL must be the web app\'s /exec URL (Deploy → Manage deployments).');
  }
  const res = tgCall_(token, 'setWebhook', {
    url: base + '?hook=' + secret,
    allowed_updates: ['message', 'my_chat_member', 'chat_member'],
    max_connections: 10,
    drop_pending_updates: true,
  });
  if (!res.ok) throw new Error('Telegram refused the webhook: ' + res.description);
}

/** A one-time code for the connect link; used up when a group connects. */
function ensureConnectCode_() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CONNECT_CODE')) props.setProperty('CONNECT_CODE', Utilities.getUuid().replace(/-/g, ''));
}

function setBotCommands_(token) {
  const commands = [{ command: 'checkin', description: 'Check in' }];
  [{ type: 'all_group_chats' }, { type: 'default' }].forEach((scope) => {
    const res = tgCall_(token, 'setMyCommands', { commands: commands, scope: scope });
    if (!res.ok) Logger.log('Could not set the bot\'s command menu (' + scope.type + '): ' + res.description);
  });
}

/** Exactly one close job, however many times setup() runs. */
function installTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'closeExpiredSessions')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('closeExpiredSessions').timeBased().everyMinutes(5).create();
}

/** What setup() did, and what the owner still has to do. */
function setupReport_(token, bot) {
  const cfg = loadConfig_(true);
  const lines = ['Setup finished for @' + bot.username + '. Webhook connected; close job runs every 5 minutes.'];
  if (!CONFIG_CHECKS_.GROUP_CHAT_ID(cfg)) {
    lines.push('NEXT: open this link on your phone and pick your group. It adds the bot as an admin and connects it ' +
      '(one use only; run setup() again for a new one): https://t.me/' + bot.username + '?startgroup=' +
      PropertiesService.getScriptProperties().getProperty('CONNECT_CODE') + '&admin=delete_messages');
    if (cfg.adminIds.length) lines.push('(Anyone listed in ADMIN_IDS can also just add the bot to the group.)');
  } else {
    const res = tgCall_(token, 'getChatMember', { chat_id: cfg.groupChatId, user_id: bot.id });
    const m = res.ok ? res.result : null;
    if (!m) {
      lines.push('WARNING: the bot cannot see group ' + cfg.groupChatId + ' (' + res.description + '). ' +
        'Add it to your group as an admin, or clear GROUP_CHAT_ID and add it again.');
    } else if (m.status !== 'administrator') {
      lines.push('NEXT: make the bot an admin of the group, so it can check who is in the group.');
    } else {
      lines.push('Group ' + cfg.groupChatId + ' is connected and the bot is an admin.' +
        (m.can_delete_messages === false ? ' Allow it to delete messages so /checkin messages are tidied away.' : ''));
    }
  }
  if (!CONFIG_CHECKS_.MINI_APP_LINK(cfg)) lines.push('NEXT: put the Mini App link (https://t.me/<bot>/<app>) in Config → MINI_APP_LINK.');
  const groups = readGroups_();
  lines.push(groups.length
    ? 'Groups members can pick: ' + groups.join(', ') + '.'
    : 'Optional: list your groups on the Groups tab, one per row, and members will pick theirs after checking in.');
  return lines;
}

/**
 * Offline checks for initData verification and distance maths. Run this in the editor
 * before any real Telegram testing. Throws if any check fails.
 */
function selfTest() {
  const F = SELFTEST_FIXTURE_;
  const MAX_AGE_MIN = 15;
  const signedAt = F.authDate * 1000;
  const verify = (initData, opts) => {
    const o = opts || {};
    return verifyInitData_(initData, o.token || F.token, MAX_AGE_MIN, o.now || signedAt + 60 * 1000);
  };
  // Replace text in the sample, failing loudly if the text is not there (so no check is vacuous).
  const tamper = (s, from, to) => {
    if (s.indexOf(from) === -1) throw new Error('selfTest fixture does not contain ' + from);
    return s.replace(from, to);
  };
  const code = (res) => (res.ok ? 'OK' : res.code);

  const checks = [];
  const check = (name, pass) => checks.push({ name: name, pass: pass === true });

  const good = verify(F.valid);
  check('valid initData is accepted', good.ok);
  check('user id comes from the signed user JSON', good.ok && good.user.id === String(F.userId));
  check('non-ASCII names survive (UTF-8)', good.ok && good.user.firstName === F.firstName && good.user.lastName === F.lastName);
  check("'+' for spaces decodes like URLSearchParams", verify(F.validPlusForSpace).ok);
  check('accepted at exactly the max age', verify(F.valid, { now: signedAt + MAX_AGE_MIN * 60 * 1000 }).ok);

  const id = '%22id%22%3A' + F.userId;
  check('tampered user id -> AUTH_FAILED', code(verify(tamper(F.valid, id, '%22id%22%3A' + (F.userId + 1)))) === 'AUTH_FAILED');
  check('tampered auth_date -> AUTH_FAILED',
    code(verify(tamper(F.valid, 'auth_date=' + F.authDate, 'auth_date=' + (F.authDate + 600)))) === 'AUTH_FAILED');
  const hashAt = F.valid.indexOf('hash=') + 5;
  const flipped = F.valid.slice(0, hashAt) + (F.valid[hashAt] === '0' ? '1' : '0') + F.valid.slice(hashAt + 1);
  check('tampered hash -> AUTH_FAILED', code(verify(flipped)) === 'AUTH_FAILED');
  check('wrong bot token -> AUTH_FAILED', code(verify(F.valid, { token: F.token + 'x' })) === 'AUTH_FAILED');
  check('secret key with swapped HMAC arguments -> AUTH_FAILED', code(verify(F.signedWithSwappedKeyOrder)) === 'AUTH_FAILED');
  check('signature field is part of the check string', code(verify(F.signedWithoutSignatureField)) === 'AUTH_FAILED');
  check('missing hash -> AUTH_FAILED', code(verify(F.valid.replace(/&hash=[0-9a-f]+$/, ''))) === 'AUTH_FAILED');
  check('duplicate field -> AUTH_FAILED', code(verify(F.valid + '&auth_date=' + F.authDate)) === 'AUTH_FAILED');
  check('malformed percent-encoding -> AUTH_FAILED', code(verify(F.valid + '&x=%E0%A4%A')) === 'AUTH_FAILED');
  check('lone surrogate -> AUTH_FAILED', code(verify(F.valid + '&x=\ud800')) === 'AUTH_FAILED');
  check('empty or non-string initData -> AUTH_FAILED',
    code(verify('')) === 'AUTH_FAILED' && code(verify(undefined)) === 'AUTH_FAILED' && code(verify({})) === 'AUTH_FAILED');
  check('initData older than 15 min -> AUTH_EXPIRED',
    code(verify(F.valid, { now: signedAt + 16 * 60 * 1000 })) === 'AUTH_EXPIRED');

  // Reference values are analytic: R*pi/180 per degree, R*pi/2 pole to equator, R*pi antipodal.
  const R = EARTH_RADIUS_M_;
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  check('haversine: same point is 0 m', haversineM_(1.3521, 103.8198, 1.3521, 103.8198) === 0);
  check('haversine: 1 degree of latitude', near(haversineM_(0, 0, 1, 0), R * Math.PI / 180, 0.01));
  check('haversine: 1 degree of longitude on the equator', near(haversineM_(0, 0, 0, 1), R * Math.PI / 180, 0.01));
  check('haversine: 0.001 degree of latitude in Singapore is ~111 m', near(haversineM_(1.3521, 103.8198, 1.3531, 103.8198), 111.2, 0.1));
  check('haversine: equator to pole', near(haversineM_(0, 0, 90, 0), R * Math.PI / 2, 0.01));
  check('haversine: antipodal points', near(haversineM_(0, 0, 0, 180), R * Math.PI, 0.01));
  check('haversine: symmetric', haversineM_(1.30, 103.80, 1.31, 103.85) === haversineM_(1.31, 103.85, 1.30, 103.80));

  checks.forEach((c) => Logger.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name));
  const failed = checks.filter((c) => !c.pass).length;
  if (failed) throw new Error('selfTest: ' + failed + ' of ' + checks.length + ' checks failed');
  Logger.log('selfTest: all ' + checks.length + ' checks passed');
  return checks.length;
}

// Generated by `node tools/sign-initdata.js --fixture` (fake token; tests/ checks they stay in sync).
const SELFTEST_FIXTURE_ = {
  token: '1234567890:FAKE-token-for-selfTest-only',
  authDate: 1790000000,
  userId: 279058397,
  firstName: 'Wei Ling 李',
  lastName: 'Tan 🙂',
  valid: 'user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Wei%20Ling%20%E6%9D%8E%22%2C%22last_name%22%3A%22Tan%20%F0%9F%99%82%22%2C%22username%22%3A%22weiling_t%22%2C%22language_code%22%3A%22en%22%2C%22allows_write_to_pm%22%3Atrue%2C%22photo_url%22%3A%22https%3A%5C%2F%5C%2Ft.me%5C%2Fi%5C%2Fuserpic%5C%2F320%5C%2Fabc.svg%22%7D&chat_instance=-8123456789012345678&chat_type=supergroup&auth_date=1790000000&signature=fAkEsIgNaTuRe_selfTest-only_not-a-real-ed25519-signature&hash=76d99d1e31dfa3237a281ec585c8a6cb2d07400de2726354ea1677984d6bca17',
  validPlusForSpace: 'user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Wei+Ling+%E6%9D%8E%22%2C%22last_name%22%3A%22Tan+%F0%9F%99%82%22%2C%22username%22%3A%22weiling_t%22%2C%22language_code%22%3A%22en%22%2C%22allows_write_to_pm%22%3Atrue%2C%22photo_url%22%3A%22https%3A%5C%2F%5C%2Ft.me%5C%2Fi%5C%2Fuserpic%5C%2F320%5C%2Fabc.svg%22%7D&chat_instance=-8123456789012345678&chat_type=supergroup&auth_date=1790000000&signature=fAkEsIgNaTuRe_selfTest-only_not-a-real-ed25519-signature&hash=76d99d1e31dfa3237a281ec585c8a6cb2d07400de2726354ea1677984d6bca17',
  signedWithSwappedKeyOrder: 'user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Wei%20Ling%20%E6%9D%8E%22%2C%22last_name%22%3A%22Tan%20%F0%9F%99%82%22%2C%22username%22%3A%22weiling_t%22%2C%22language_code%22%3A%22en%22%2C%22allows_write_to_pm%22%3Atrue%2C%22photo_url%22%3A%22https%3A%5C%2F%5C%2Ft.me%5C%2Fi%5C%2Fuserpic%5C%2F320%5C%2Fabc.svg%22%7D&chat_instance=-8123456789012345678&chat_type=supergroup&auth_date=1790000000&signature=fAkEsIgNaTuRe_selfTest-only_not-a-real-ed25519-signature&hash=ea71d6c6c9726d8c28faef4f7d47a6f2355a4750b92d15dbcd090d36c59f115b',
  signedWithoutSignatureField: 'user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Wei%20Ling%20%E6%9D%8E%22%2C%22last_name%22%3A%22Tan%20%F0%9F%99%82%22%2C%22username%22%3A%22weiling_t%22%2C%22language_code%22%3A%22en%22%2C%22allows_write_to_pm%22%3Atrue%2C%22photo_url%22%3A%22https%3A%5C%2F%5C%2Ft.me%5C%2Fi%5C%2Fuserpic%5C%2F320%5C%2Fabc.svg%22%7D&chat_instance=-8123456789012345678&chat_type=supergroup&auth_date=1790000000&signature=fAkEsIgNaTuRe_selfTest-only_not-a-real-ed25519-signature&hash=ef05fb8526ab161b6ff7bf888fa1dfcdaac75502d8ab90377bea0a0a788a67a0',
};
