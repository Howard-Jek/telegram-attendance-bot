/**
 * Sheet layout and the Config tab (key | value), read once per request.
 * BOT_TOKEN is never stored here: it lives in Script Properties only.
 */

const TZ_ = 'Asia/Singapore';
const LOCK_WAIT_MS_ = 10000;

const SHEETS_ = {
  CONFIG: 'Config',
  SESSIONS: 'Sessions',
  LOG: 'Log',
  REJECTED: 'Rejected',
};

const HEADERS_ = {
  Config: ['key', 'value'],
  Sessions: ['session_id', 'started_by_id', 'started_by_name', 'opens_at', 'closes_at',
    'announcement_message_id', 'status', 'checkin_count'],
  Log: ['timestamp', 'session_id', 'user_id', 'first_name', 'last_name', 'username',
    'latitude', 'longitude', 'accuracy_m', 'distance_m', 'dedupe_key'],
  Rejected: ['timestamp', 'session_id', 'user_id', 'name', 'username', 'reason',
    'latitude', 'longitude', 'accuracy_m', 'distance_m'],
};

// 1-based column numbers.
const SESSION_COL_ = { ID: 1, STARTED_BY_ID: 2, STARTED_BY_NAME: 3, OPENS_AT: 4, CLOSES_AT: 5,
  MESSAGE_ID: 6, STATUS: 7, COUNT: 8 };
const LOG_COL_ = { TIMESTAMP: 1, DEDUPE_KEY: 11 };

// Blank means "must be filled in by the owner".
const CONFIG_DEFAULTS_ = {
  SITE_LAT: '',
  SITE_LNG: '',
  RADIUS_M: 150,
  MAX_ACCURACY_M: 100,
  SESSION_MINUTES: 60,
  INITDATA_MAX_AGE_MIN: 15,
  ADMIN_IDS: '',
  GROUP_CHAT_ID: '',
  MINI_APP_LINK: '',
};

const CONFIG_CHECKS_ = {
  SITE_LAT: (c) => isFinite(c.siteLat) && Math.abs(c.siteLat) <= 90,
  SITE_LNG: (c) => isFinite(c.siteLng) && Math.abs(c.siteLng) <= 180,
  RADIUS_M: (c) => c.radiusM > 0,
  MAX_ACCURACY_M: (c) => c.maxAccuracyM > 0,
  SESSION_MINUTES: (c) => c.sessionMinutes >= 1, // >= 1 keeps S-yyyyMMdd-HHmm ids unique
  INITDATA_MAX_AGE_MIN: (c) => c.initDataMaxAgeMin > 0,
  GROUP_CHAT_ID: (c) => /^-?\d+$/.test(c.groupChatId),
  ADMIN_IDS: (c) => c.adminIds.length > 0 && c.adminIds.every((id) => /^\d+$/.test(id)),
};

function loadConfig_() {
  const raw = {};
  sheet_(SHEETS_.CONFIG).getDataRange().getValues().forEach((row) => {
    const key = String(row[0]).trim();
    if (key) raw[key] = row[1];
  });
  const val = (key) => (isBlank_(raw[key]) ? CONFIG_DEFAULTS_[key] : raw[key]);
  return {
    siteLat: toNumber_(val('SITE_LAT')),
    siteLng: toNumber_(val('SITE_LNG')),
    radiusM: toNumber_(val('RADIUS_M')),
    maxAccuracyM: toNumber_(val('MAX_ACCURACY_M')),
    sessionMinutes: toNumber_(val('SESSION_MINUTES')),
    initDataMaxAgeMin: toNumber_(val('INITDATA_MAX_AGE_MIN')),
    adminIds: String(val('ADMIN_IDS')).split(',').map((s) => s.trim()).filter(Boolean),
    groupChatId: String(val('GROUP_CHAT_ID')).trim(),
    miniAppLink: String(val('MINI_APP_LINK')).trim(),
  };
}

/** Throws SetupError_ naming every listed Config key that is missing or invalid. */
function assertConfig_(cfg, keys) {
  const bad = keys.filter((k) => !CONFIG_CHECKS_[k](cfg));
  if (bad.length) {
    throw new SetupError_('Check-in is not set up yet (Config: ' + bad.join(', ') + '). Please tell an admin.');
  }
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
 * requests open the Sheet by the id that setupSheets() stored in Script Properties.
 */
function spreadsheet_() {
  if (!openedSpreadsheet_) {
    const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    openedSpreadsheet_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
    if (!openedSpreadsheet_) throw new SetupError_('The bot is not set up yet (SPREADSHEET_ID missing). The owner needs to run setupSheets().');
  }
  return openedSpreadsheet_;
}

/**
 * Rows are read and written by column position, so a changed header row (an inserted or
 * deleted column) must stop the request rather than silently misread the data.
 */
function assertHeaders_(name, headerRow) {
  const expected = HEADERS_[name];
  if (!expected.every((h, i) => String(headerRow[i]).trim() === h)) {
    throw new SetupError_('The "' + name + '" tab\'s columns were changed. Restore its header row to: ' +
      expected.join(', ') + '.');
  }
}

function sheet_(name) {
  const sheet = spreadsheet_().getSheetByName(name);
  if (!sheet) throw new SetupError_('The "' + name + '" tab is missing. The owner needs to run setupSheets().');
  return sheet;
}
