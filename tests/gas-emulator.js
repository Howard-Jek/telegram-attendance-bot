'use strict';
/**
 * Minimal Google Apps Script emulator for running apps-script/*.gs under Node.
 *
 * Only the services the backend uses are modelled. Where real Apps Script is
 * strict, this is strict too (signed Byte[] arguments, Sheets auto-parsing and
 * formula evaluation of written strings), so tests catch the classic mistakes.
 * It is not a substitute for running selfTest() in the real Apps Script editor.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const GS_DIR = path.join(__dirname, '..', 'apps-script');

// ---------- Sheets ----------

function isDate(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(this.sheet._get(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  getValue() { return this.sheet._get(this.row, this.col); }
  getDisplayValues() {
    return this.getValues().map((line) => line.map((v) => (isDate(v) ? v.toISOString() : String(v))));
  }
  setValues(values) {
    if (!Array.isArray(values) || values.length !== this.numRows || values.some((l) => l.length !== this.numCols)) {
      throw new Error(`The number of rows or columns in the data does not match the range (${this.numRows}x${this.numCols}).`);
    }
    values.forEach((line, r) => line.forEach((v, c) => this.sheet._set(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) {
    for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) this.sheet._set(this.row + r, this.col + c, v);
    return this;
  }
  setNumberFormat(fmt) {
    for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) this.sheet.formats.set(`${this.row + r}:${this.col + c}`, fmt);
    return this;
  }
  setFontWeight() { return this; }
  createTextFinder(text) {
    this.sheet.ss.env.events.push({ type: 'find', sheet: this.sheet.name });
    const range = this;
    const opts = { entire: false, matchCase: false };
    let cursor = -1;
    const cells = () => {
      const found = [];
      const vals = range.getDisplayValues();
      vals.forEach((line, r) =>
        line.forEach((v, c) => {
          const a = opts.matchCase ? v : v.toLowerCase();
          const b = opts.matchCase ? String(text) : String(text).toLowerCase();
          if (opts.entire ? a === b : a.includes(b)) found.push(new MockRange(range.sheet, range.row + r, range.col + c, 1, 1));
        }),
      );
      return found;
    };
    const finder = {
      matchEntireCell(v) { opts.entire = !!v; return finder; },
      matchCase(v) { opts.matchCase = !!v; return finder; },
      useRegularExpression(v) { if (v) throw new Error('regex not emulated'); return finder; },
      findNext() { const all = cells(); cursor++; return all[cursor] || null; },
      findAll() { return cells(); },
    };
    return finder;
  }
}

class MockSheet {
  constructor(ss, name) {
    this.ss = ss;
    this.name = name;
    this.cells = new Map(); // "r:c" -> value
    this.formats = new Map();
    this.frozenRows = 0;
    this.maxRows = 1000;
    this.maxCols = 26;
  }
  getName() { return this.name; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(after, n) { this.maxRows += n; return this; }
  insertColumnsAfter(after, n) { this.maxCols += n; return this; }
  getLastRow() {
    let last = 0;
    for (const [k, v] of this.cells) if (v !== '') last = Math.max(last, Number(k.split(':')[0]));
    return last;
  }
  getLastColumn() {
    let last = 0;
    for (const [k, v] of this.cells) if (v !== '') last = Math.max(last, Number(k.split(':')[1]));
    return last;
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    if (typeof row === 'string') throw new Error('A1 notation not emulated');
    if (numRows < 1) throw new Error('The number of rows in the range must be at least 1.');
    if (numCols < 1) throw new Error('The number of columns in the range must be at least 1.');
    if (row < 1 || col < 1 || row + numRows - 1 > this.maxRows || col + numCols - 1 > this.maxCols) {
      throw new Error(`The coordinates of the range are outside the dimensions of the sheet (${row},${col},${numRows},${numCols}).`);
    }
    return new MockRange(this, row, col, numRows, numCols);
  }
  getDataRange() {
    return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  }
  appendRow(values) {
    const row = this.getLastRow() + 1;
    this.maxRows = Math.max(this.maxRows, row); // appendRow grows the grid
    this.maxCols = Math.max(this.maxCols, values.length);
    values.forEach((v, c) => this._set(row, c + 1, v));
    return this;
  }
  setFrozenRows(n) { this.frozenRows = n; }
  rows() {
    // Test helper: all data rows below the header as arrays.
    const out = [];
    const lastCol = this.getLastColumn();
    for (let r = 2; r <= this.getLastRow(); r++) {
      const line = [];
      for (let c = 1; c <= lastCol; c++) line.push(this._get(r, c));
      out.push(line);
    }
    return out;
  }
  _get(r, c) {
    const v = this.cells.get(`${r}:${c}`);
    return v === undefined ? '' : v;
  }
  _set(r, c, v) {
    this.ss.env.events.push({ type: 'write', sheet: this.name, r, c });
    this.cells.set(`${r}:${c}`, this._coerce(v, r, c));
  }
  // Mimics how Sheets stores a value written from Apps Script.
  _coerce(v, r, c) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' || typeof v === 'boolean' || isDate(v)) return v;
    if (typeof v !== 'string') return String(v);
    // A plain-text cell takes the string as it is (pessimistically, an apostrophe stays part of
    // the value); elsewhere a leading apostrophe forces text and is not part of the value.
    if (this.formats.get(`${r}:${c}`) === '@') return v;
    if (v.startsWith("'")) return v.slice(1);
    if (v.startsWith('=') || v.startsWith('+') || (v.startsWith('-') && /[a-z(]/i.test(v))) {
      this.ss.env.formulaWrites.push({ sheet: this.name, r, c, v });
      return `#FORMULA(${v})`;
    }
    if (/^[+-]?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v.trim())) return Number(v);
    if (/^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true';
    if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(v.trim())) return `#AUTODATE(${v})`;
    return v;
  }
}

class MockSpreadsheet {
  constructor(env) {
    this.env = env;
    this.sheets = new Map();
    this.timeZone = 'America/Los_Angeles';
    this.id = '1FakeSpreadsheetId_emulator';
  }
  getId() { return this.id; }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) {
    if (this.sheets.has(name)) throw new Error(`A sheet with the name "${name}" already exists.`);
    const s = new MockSheet(this, name);
    this.sheets.set(name, s);
    return s;
  }
  getSheets() { return [...this.sheets.values()]; }
  setSpreadsheetTimeZone(tz) { this.timeZone = tz; }
  getSpreadsheetTimeZone() { return this.timeZone; }
}

// ---------- Utilities ----------

function toBuffer(value, argName) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (!Array.isArray(value)) throw new Error(`Invalid argument: ${argName}`);
  value.forEach((b) => {
    if (!Number.isInteger(b) || b < -128 || b > 127) throw new Error(`Cannot convert ${b} to byte.`);
  });
  return Buffer.from(Int8Array.from(value).buffer);
}

function signedBytes(buf) {
  return Array.from(new Int8Array(buf.buffer, buf.byteOffset, buf.length));
}

function formatDate(date, tz, pattern) {
  if (!isDate(date)) throw new Error('Invalid argument: date');
  const parts = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, (t) => ({
    yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second,
  })[t]);
}

// ---------- Environment ----------

function createEnv({ props = {}, telegram = {}, reverseFileOrder = false } = {}) {
  const env = {
    events: [],
    formulaWrites: [],
    logs: [],
    fetches: [],
    lockHeldElsewhere: false,
    cache: new Map(), // CacheService.getScriptCache(): key -> {value, expires}
    props: { ...props },
    telegram, // method name -> (params) => JSON body, or throws
    triggers: [],
    serviceUrl: null,
  };
  const ss = new MockSpreadsheet(env);
  env.ss = ss;
  env.manifest = JSON.parse(fs.readFileSync(path.join(GS_DIR, 'appsscript.json'), 'utf8'));
  env.inWebApp = false;

  const lock = {
    held: false,
    tryLock(ms) {
      env.events.push({ type: 'tryLock', ms });
      if (env.race) {
        // Simulate another request that runs to completion in the gap before this one gets the lock.
        const competitor = env.race;
        env.race = null;
        competitor();
      }
      if (env.lockHeldElsewhere) return false;
      lock.held = true;
      env.events.push({ type: 'lock' });
      return true;
    },
    waitLock(ms) { if (!lock.tryLock(ms)) throw new Error('Lock timeout: another process was holding the lock for too long.'); },
    hasLock() { return lock.held; },
    releaseLock() { if (lock.held) env.events.push({ type: 'unlock' }); lock.held = false; },
  };
  env.lock = lock;

  const log = (level) => (...a) => env.logs.push({ level, text: a.map(String).join(' ') });

  const globals = {
    SpreadsheetApp: {
      // Documented: getActive*() is not available when a bound script runs as a web app.
      getActiveSpreadsheet: () => (env.inWebApp ? null : ss),
      openById: (id) => {
        env.events.push({ type: 'open' });
        if (id !== ss.getId()) throw new Error(`Unexpected error while getting the method or property openById on object SpreadsheetApp.`);
        return ss;
      },
      flush: () => env.events.push({ type: 'flush' }),
    },
    LockService: { getScriptLock: () => lock },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => {
          const e = env.cache.get(k);
          if (!e || e.expires <= (env.nowMs || 0)) return null;
          return e.value;
        },
        put: (k, v, ttlSec = 600) => {
          if (!Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > 21600) throw new Error(`Invalid expiration ${ttlSec}`);
          env.cache.set(k, { value: String(v), expires: (env.nowMs || 0) + ttlSec * 1000 });
        },
        remove: (k) => env.cache.delete(k),
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => {
          if (env.propsThrow) throw new Error('Service invoked too many times for one day: properties.');
          return k in env.props ? env.props[k] : null;
        },
        setProperty: (k, v) => { env.props[k] = String(v); },
        deleteProperty: (k) => { delete env.props[k]; },
      }),
    },
    Utilities: {
      computeHmacSha256Signature(value, key, charset) {
        if (charset !== undefined && (typeof value !== 'string' || typeof key !== 'string')) {
          throw new Error('Cannot find method computeHmacSha256Signature(object,object,object).');
        }
        if (typeof value !== typeof key || (Array.isArray(value) !== Array.isArray(key))) {
          throw new Error('Cannot find method computeHmacSha256Signature(object,object).');
        }
        const mac = crypto.createHmac('sha256', toBuffer(key, 'key')).update(toBuffer(value, 'value')).digest();
        return signedBytes(mac);
      },
      formatDate,
      newBlob: (s) => ({ getBytes: () => signedBytes(Buffer.from(String(s), 'utf8')), getDataAsString: () => String(s) }),
      sleep: () => {},
      getUuid: () => crypto.randomUUID(),
    },
    UrlFetchApp: {
      fetch(url, opts = {}) {
        const allow = env.manifest.urlFetchWhitelist;
        if (allow && !allow.some((prefix) => url.startsWith(prefix))) {
          throw new Error(`UrlFetch calls to ${url} are not permitted by your admin`);
        }
        env.fetches.push({ url, opts });
        env.events.push({ type: 'fetch', url });
        const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
        if (!m) throw new Error(`Unexpected fetch: ${url}`);
        const handler = env.telegram[m[2]];
        if (!handler) throw new Error(`No mock for Telegram method ${m[2]}`);
        const params = opts.payload ? JSON.parse(opts.payload) : {};
        const body = handler(params, { token: m[1], url }); // may throw to simulate network failure
        const code = body.ok ? 200 : body.error_code || 400;
        if (code >= 400 && !opts.muteHttpExceptions) {
          throw new Error(`Request failed for https://api.telegram.org returned code ${code}. Truncated server response: ${JSON.stringify(body)}`);
        }
        return { getResponseCode: () => code, getContentText: () => JSON.stringify(body) };
      },
    },
    ContentService: {
      MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
      createTextOutput(content) {
        const out = { content, mimeType: 'TEXT' };
        out.setMimeType = (m) => { out.mimeType = m; return out; };
        out.getContent = () => out.content;
        return out;
      },
    },
    // doPost output that Apps Script serves directly with HTTP 200 (ContentService output is
    // served through a 302 redirect instead, which Telegram's webhook delivery treats as a failure).
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
      createHtmlOutput(content = '') {
        const out = { kind: 'html', content: String(content), xframe: 'DEFAULT' };
        out.getContent = () => out.content;
        out.setXFrameOptionsMode = (m) => { out.xframe = m; return out; };
        return out;
      },
    },
    ScriptApp: {
      getProjectTriggers: () => env.triggers.slice(),
      deleteTrigger: (t) => { env.triggers = env.triggers.filter((x) => x !== t); },
      newTrigger: (handler) => {
        const spec = { handler };
        const builder = {
          timeBased: () => builder,
          everyMinutes: (n) => {
            if (![1, 5, 10, 15, 30].includes(n)) throw new Error(`Invalid minutes ${n}`);
            spec.everyMinutes = n;
            return builder;
          },
          create: () => {
            const t = { ...spec, getHandlerFunction: () => handler };
            env.triggers.push(t);
            return t;
          },
        };
        return builder;
      },
      getService: () => ({ getUrl: () => env.serviceUrl }),
    },
    Logger: { log: log('log') },
    console: { log: log('log'), info: log('info'), warn: log('warn'), error: log('error') },
    Session: { getScriptTimeZone: () => 'Asia/Singapore' },
  };

  const context = vm.createContext(globals);
  const files = fs.readdirSync(GS_DIR).filter((f) => f.endsWith('.gs')).sort();
  // Apps Script's file order is not guaranteed; loading in reverse catches top-level cross-file references.
  if (reverseFileOrder) files.reverse();
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(GS_DIR, f), 'utf8'), context, { filename: f });
  }
  env.context = context;
  env.files = files;

  /** Pin the server clock used by now_() (ms since epoch). */
  const ContextDate = vm.runInContext('Date', context); // the realm's own Date, so isDate_/instanceof behave
  env.setNow = (ms) => {
    env.nowMs = ms;
    context.now_ = () => new ContextDate(ms);
  };
  env.call = (name, ...args) => context[name](...args);
  /** Run `competitor` (e.g. another env.post) just before the next tryLock, i.e. between a request's pre-lock work and its lock. */
  env.raceBeforeNextLock = (competitor) => { env.race = competitor; };
  env.eval = (code) => vm.runInContext(code, context);
  /** POST a JSON body to doPost and return the parsed JSON response. */
  env.post = (body) => {
    const contents = typeof body === 'string' ? body : JSON.stringify(body);
    const wasInWebApp = env.inWebApp;
    env.inWebApp = true;
    let out;
    try {
      out = context.doPost({ postData: { contents, type: 'text/plain' }, parameter: {} });
    } finally {
      env.inWebApp = wasInWebApp;
    }
    if (out.mimeType !== 'JSON') throw new Error(`doPost returned mime ${out.mimeType}`);
    return JSON.parse(out.getContent());
  };
  /** POST the way the Mini App's frame transport does: a form with payload, rid and origin. */
  env.postFrame = (body, { rid = 'r1', origin = 'https://howard-jek.github.io' } = {}) => {
    const wasInWebApp = env.inWebApp;
    env.inWebApp = true;
    try {
      return context.doPost({ parameter: { transport: 'frame', rid, origin, payload: JSON.stringify(body) },
        postData: { contents: 'payload=...', type: 'application/x-www-form-urlencoded' } });
    } finally {
      env.inWebApp = wasInWebApp;
    }
  };
  /** Deliver a Telegram update to doPost the way the webhook does (?hook=<secret>, JSON body). */
  env.webhook = (update, hook = env.props.WEBHOOK_SECRET) => {
    const wasInWebApp = env.inWebApp;
    env.inWebApp = true;
    let out;
    try {
      const contents = typeof update === 'string' ? update : JSON.stringify(update);
      out = context.doPost({ postData: { contents, type: 'application/json' }, parameter: hook === undefined ? {} : { hook } });
    } finally {
      env.inWebApp = wasInWebApp;
    }
    return out;
  };
  env.sheet = (name) => ss.getSheetByName(name);
  return env;
}

module.exports = { createEnv, formatDate, isDate };
