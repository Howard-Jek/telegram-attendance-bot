'use strict';
/**
 * October 2026: exact locations are never kept in the Sheet (only the distance from the check-in
 * point and the GPS accuracy), and every check-in gets its own tab listing who checked in.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./gas-emulator');
const {
  setup, TOKEN, SITE, SITE_FIX, T0, MIN, ADMIN, ADMIN2, MEMBER, MEMBER2, OUTSIDER, ONSITE, OFFSITE, BLURRY,
} = require('./helpers');

const TAB = '21 Sep 2026 1030'; // the tab of the session started at T0 (10:30:15 SGT)
const close = (env) => env.call('closeExpiredSessions');
const tab = (env, name = TAB) => env.sheet(name);
const tabRows = (env, name = TAB) => {
  const sheet = tab(env, name);
  const out = [];
  for (let r = 1; r <= sheet.getLastRow(); r++) out.push(sheet.getRange(r, 1, 1, 8).getValues()[0]);
  return out;
};
// [group, full name] per person; the columns are Group, Rank, Full name, Checked in at, Late by,
// Telegram name, Username, On nominal roll.
const people = (env, name = TAB) => tabRows(env, name).slice(5).map((r) => [r[0], r[2]]);

/** Every value in every tab, for searching. */
function everything(env) {
  const out = [];
  env.ss.getSheets().forEach((sheet) => {
    for (const v of sheet.cells.values()) out.push(v);
  });
  return out;
}
function assertNoCoordinates(env, points) {
  const values = everything(env);
  for (const p of points) {
    for (const x of [p.lat, p.lng]) {
      const hit = values.find((v) => (typeof v === 'number' && Math.abs(v - x) < 1e-6) ||
        (typeof v === 'string' && v.includes(String(x).slice(0, 6))));
      assert.equal(hit, undefined, `coordinate ${x} found in the Sheet`);
    }
  }
}

// ---------- no exact locations in the Sheet ----------

test('locations: after a whole check-in, no coordinates are anywhere in the Sheet', () => {
  const env = setup({ statuses: { [OUTSIDER.id]: 'left' }, groups: ['Alpha'] });
  const WRONG = { lat: SITE.lat + 0.02, lng: SITE.lng + 0.003, accuracy: 9 };
  env.start(ADMIN, WRONG);
  env.checkin(MEMBER, ONSITE); // too far from the wrong point
  env.req('moveSite', ADMIN, { location: SITE_FIX });
  env.checkin(MEMBER, BLURRY);
  env.checkin(MEMBER2, OFFSITE);
  env.checkin(OUTSIDER, ONSITE);
  env.checkin(MEMBER, ONSITE);
  env.checkin(ADMIN, { lat: SITE.lat - 0.0003, lng: SITE.lng + 0.0002, accuracy: 7 });
  env.saveProfile(MEMBER, 'CPL Cy Tan', 'Alpha');
  close(env);
  env.setNow(T0 + 60 * MIN);
  close(env);
  assertNoCoordinates(env, [WRONG, SITE_FIX, ONSITE, BLURRY, OFFSITE, { lat: SITE.lat - 0.0003, lng: SITE.lng + 0.0002 }]);
  // What is kept: the distance from the point and the accuracy.
  const log = env.records('Log');
  assert.equal(log.length, 2);
  assert.ok(log.every((r) => typeof r.distance_m === 'number' && typeof r.accuracy_m === 'number'));
});

test('locations: the check-in point is kept out of the Sheet, and deleted when the check-in closes', () => {
  const env = setup();
  const started = env.start(ADMIN);
  const id = started.data.sessionId;
  assert.deepEqual(env.siteOf(id), { lat: SITE_FIX.lat, lng: SITE_FIX.lng });
  assert.equal(env.checkin(MEMBER).code, 'CHECKED_IN');
  env.setNow(T0 + 30 * MIN);
  close(env);
  assert.ok(env.siteOf(id), 'still needed while it is open');
  env.setNow(T0 + 60 * MIN);
  close(env);
  assert.equal(env.siteOf(id), null, 'gone once it closes');
  assert.equal(env.checkin(MEMBER2).code, 'NO_ACTIVE_SESSION');
});

test('locations: a check-in point left behind (its session row deleted by hand) is cleaned up; other properties stay', () => {
  const env = setup();
  env.props['SITE:S-20200101-0000'] = JSON.stringify({ lat: 1, lng: 2 });
  env.start(ADMIN);
  close(env);
  assert.equal(env.props['SITE:S-20200101-0000'], undefined);
  assert.ok(env.siteOf('S-20260921-1030'), 'the open session keeps its point');
  assert.equal(env.props.BOT_TOKEN, TOKEN);
});

test('locations: distances are kept whole (accepted) or rounded up to 50 m (too far), never to the centimetre', () => {
  const env = setup();
  env.start(ADMIN);
  env.checkin(MEMBER, ONSITE); // ~55.6 m
  env.checkin(MEMBER2, { lat: SITE.lat + 0.001439, lng: SITE.lng, accuracy: 20 }); // ~160 m
  assert.equal(env.records('Log')[0].distance_m, 56);
  assert.equal(env.records('Rejected')[0].distance_m, 200);
});

test('locations: if the check-in point can\'t be saved, no check-in is left open without one', () => {
  const env = setup();
  env.setPropertyThrows = (k) => k.startsWith('SITE:');
  assert.equal(env.start(ADMIN).code, 'SERVER_ERROR');
  assert.equal(env.rows('Sessions').length, 0);
  env.setPropertyThrows = null;
  assert.equal(env.start(ADMIN).code, 'SESSION_STARTED');
  assert.equal(env.checkin(MEMBER).code, 'CHECKED_IN');
});

test('locations: a lost check-in point (properties cleared) says so instead of failing silently', () => {
  const env = setup();
  env.start(ADMIN);
  delete env.props['SITE:S-20260921-1030'];
  const r = env.checkin(MEMBER);
  assert.equal(r.code, 'NO_SITE');
  assert.equal(env.req('moveSite', ADMIN, { location: SITE_FIX }).code, 'SITE_MOVED');
  assert.equal(env.checkin(MEMBER).code, 'CHECKED_IN');
});

// ---------- updating an existing Sheet ----------

const SEPT = {
  Sessions: ['session_id', 'started_by_id', 'started_by_name', 'opens_at', 'closes_at', 'announcement_message_id', 'status',
    'checkin_count', 'site_lat', 'site_lng', 'site_accuracy_m'],
  Log: ['timestamp', 'session_id', 'user_id', 'first_name', 'last_name', 'username', 'latitude', 'longitude', 'accuracy_m',
    'distance_m', 'dedupe_key', 'full_name', 'group'],
  Rejected: ['timestamp', 'session_id', 'user_id', 'name', 'username', 'reason', 'latitude', 'longitude', 'accuracy_m', 'distance_m'],
};

/** A Sheet as the September version left it: one old closed session and one open one. */
function septemberSheet() {
  const env = setup({ groups: ['Alpha'] });
  const ss = env.ss;
  ['Sessions', 'Log', 'Rejected'].forEach((name) => ss.deleteSheet(env.sheet(name)));
  const add = (name, rows) => { const s = ss.insertSheet(name); rows.forEach((r) => s.appendRow(r)); return s; };
  add('Sessions', [SEPT.Sessions,
    ['S-20260920-0900', ADMIN.id, 'Ada Admin', new Date(T0 - 1500 * MIN), new Date(T0 - 1440 * MIN), 11, 'closed', 1, 1.1111, 103.1111, 9],
    ['S-20260921-1030', ADMIN.id, 'Ada Admin', new Date(T0), new Date(T0 + 60 * MIN), 12, 'open', 1, SITE_FIX.lat, SITE_FIX.lng, 12]]);
  add('Log', [SEPT.Log,
    [new Date(T0 - 1490 * MIN), 'S-20260920-0900', MEMBER.id, 'Cy', 'Member', 'cy', 1.1112, 103.1112, 15, 12.5, 'S-20260920-0900:' + MEMBER.id, 'Cy Tan', 'Alpha'],
    [new Date(T0 + MIN), 'S-20260921-1030', MEMBER.id, 'Cy', 'Member', 'cy', ONSITE.lat, ONSITE.lng, 20, 55.6, 'S-20260921-1030:' + MEMBER.id, 'Cy Tan', 'Alpha']]);
  add('Rejected', [SEPT.Rejected,
    [new Date(T0 + 2 * MIN), 'S-20260921-1030', MEMBER2.id, 'Di', '', 'OUT_OF_RANGE', OFFSITE.lat, OFFSITE.lng, 20, 1113.2],
    [new Date(T0 + 3 * MIN), 'S-20260921-1030', OUTSIDER.id, 'Ed', '', 'NOT_MEMBER', '', '', '', '']]);
  env.setNow(T0 + 5 * MIN);
  return env;
}

test('migration: until setup() runs, the bot asks for it (never "restore the header row")', () => {
  const env = septemberSheet();
  const r = env.checkin(MEMBER2);
  assert.equal(r.code, 'SERVER_ERROR');
  assert.match(r.message, /run setup\(\) once/);
  assert.doesNotMatch(r.message, /Restore its header row/);
});

test('migration: setup() deletes the old coordinates, keeps everything else, and the open check-in carries on', () => {
  const env = septemberSheet();
  env.call('setupSheets');
  assert.deepEqual(env.sheet('Sessions').getRange(1, 1, 1, 9).getValues()[0], SEPT.Sessions.slice(0, 8).concat(['site_accuracy_m']));
  assert.equal(env.sheet('Sessions').getLastColumn(), 10, 'site_accuracy_m, then late_until');
  assert.equal(env.sheet('Log').getLastColumn(), 13, '… group, then rank and minutes_late');
  assert.equal(env.sheet('Rejected').getLastColumn(), 8);
  assertNoCoordinates(env, [SITE_FIX, ONSITE, OFFSITE, { lat: 1.1111, lng: 103.1111 }, { lat: 1.1112, lng: 103.1112 }]);
  // Nothing else moved out of place.
  const log = env.records('Log');
  assert.deepEqual(log.map((r) => [r.session_id, r.accuracy_m, r.distance_m, r.full_name, r.group]),
    [['S-20260920-0900', 15, 12.5, 'Cy Tan', 'Alpha'], ['S-20260921-1030', 20, 55.6, 'Cy Tan', 'Alpha']]);
  assert.deepEqual(env.records('Rejected').map((r) => [r.reason, r.accuracy_m, r.distance_m]), [['OUT_OF_RANGE', 20, 1113.2], ['NOT_MEMBER', '', '']]);
  assert.deepEqual(env.records('Sessions').map((r) => [r.status, r.site_accuracy_m]), [['closed', 9], ['open', 12]]);
  // The open check-in keeps its point (now out of the Sheet); the closed one's is simply dropped.
  assert.deepEqual(env.siteOf('S-20260921-1030'), { lat: SITE_FIX.lat, lng: SITE_FIX.lng });
  assert.equal(env.siteOf('S-20260920-0900'), null);
  assert.equal(env.checkin(MEMBER2).code, 'CHECKED_IN');
  assert.equal(env.checkin(MEMBER).code, 'ALREADY_CHECKED_IN', 'the old Log row is still found');
  assert.ok(env.logs.some((l) => /Removed the latitude and longitude columns from Log/.test(l.text)));
});

test('migration: the old venue coordinates in Config (SITE_LAT, SITE_LNG) are deleted too', () => {
  const env = septemberSheet();
  const cfg = env.sheet('Config');
  cfg.appendRow(['SITE_LAT', '1.28340']);
  cfg.appendRow(['SITE_LNG', '103.86070']);
  cfg.appendRow(['ADMIN_IDS', '']);
  env.call('setupSheets');
  const keys = env.rows('Config').map((r) => r[0]);
  assert.equal(keys.includes('SITE_LAT') || keys.includes('SITE_LNG'), false);
  assert.ok(keys.includes('RADIUS_M') && keys.includes('GROUP_CHAT_ID'), 'other rows kept');
  assertNoCoordinates(env, [{ lat: 1.2834, lng: 103.8607 }]);
});

test('migration: columns the owner added on the right are kept, with their data', () => {
  const env = septemberSheet();
  const log = env.sheet('Log');
  log.getRange(1, 14).setValue('notes');
  log.getRange(2, 14).setValue('was late');
  env.call('setupSheets');
  assert.deepEqual(log.getRange(1, 9, 2, 4).getValues(),
    [['dedupe_key', 'full_name', 'group', 'notes'], ['S-20260920-0900:' + MEMBER.id, 'Cy Tan', 'Alpha', 'was late']]);
});

test('migration: if setup() fails part-way, check-ins stay stopped, and running it again finishes cleanly', () => {
  const env = septemberSheet();
  const real = env.sheet('Rejected').deleteColumns.bind(env.sheet('Rejected'));
  let failed = false;
  env.sheet('Rejected').deleteColumns = (...a) => { if (!failed) { failed = true; throw new Error('Service Spreadsheets timed out.'); } return real(...a); };
  // Whatever order the tabs are done in, a failure must leave the bot refusing to write.
  try { env.call('setupSheets'); } catch (e) { /* the owner sees the error */ }
  const r = env.checkin(MEMBER2, OFFSITE);
  assert.equal(r.code, 'SERVER_ERROR', 'no rows written into half-migrated tabs');
  env.call('setupSheets');
  assert.equal(env.checkin(MEMBER2, OFFSITE).code, 'OUT_OF_RANGE');
  assert.deepEqual(env.records('Rejected').map((x) => [x.reason, x.accuracy_m, x.distance_m]),
    [['OUT_OF_RANGE', 20, 1113.2], ['NOT_MEMBER', '', ''], ['OUT_OF_RANGE', 20, 1150]]);
});

test('migration: a tab with only one of the two old columns is "changed", not "run setup()" forever', () => {
  const env = septemberSheet();
  env.sheet('Log').deleteColumns(8, 1); // the owner deleted longitude by hand
  env.call('setupSheets'); // migrates the other tabs, and leaves a Log it doesn't recognise alone
  assert.equal(env.sheet('Log').getRange(1, 7).getValue(), 'latitude');
  const r = env.checkin(MEMBER2);
  assert.equal(r.code, 'SERVER_ERROR');
  assert.match(r.message, /columns were changed/);
});

test('migration: running setup() again changes nothing', () => {
  const env = septemberSheet();
  env.events.length = 0;
  env.call('setupSheets');
  assert.equal(env.events.filter((e) => e.type === 'deleteColumns').length, 3, 'the first run removes them');
  const before = JSON.stringify(['Sessions', 'Log', 'Rejected'].map((n) => env.sheet(n).rows()));
  env.events.length = 0;
  env.call('setupSheets');
  assert.equal(JSON.stringify(['Sessions', 'Log', 'Rejected'].map((n) => env.sheet(n).rows())), before);
  assert.equal(env.events.filter((e) => e.type === 'deleteColumns').length, 0);
});

test('migration: a busy lock stops setup() rather than deleting columns mid check-in', () => {
  const env = septemberSheet();
  env.lockHeldElsewhere = true;
  assert.throws(() => env.call('setupSheets'), /busy/i);
  assert.equal(env.sheet('Log').getLastColumn(), 13, 'nothing deleted');
});

// ---------- a tab for each check-in ----------

test('session tab: starting a check-in adds its tab, named by its start time, as the first tab', () => {
  const env = setup();
  env.start(ADMIN);
  const sheet = tab(env);
  assert.ok(sheet, 'tab "' + TAB + '" exists');
  assert.equal(sheet.getIndex(), 1, 'newest first');
  const rows = tabRows(env);
  assert.match(rows[0][0], /21 Sep 2026, 10:30 to 11:30 · started by Ada Admin/);
  assert.equal(rows[1][0], 'Nobody has checked in yet.');
  assert.match(rows[2][0], /Updates every 5 minutes until the check-in closes at 11:30/);
  assert.deepEqual(rows[4], ['Group', 'Rank', 'Full name', 'Checked in at', 'Late by', 'Telegram name', 'Username', 'On nominal roll']);
  assert.equal(sheet.getFrozenRows(), 5);
  assert.ok(sheet.getMaxColumns() <= 8 && sheet.getMaxRows() <= 10, 'kept small: a Sheet holds at most 10 million cells');
});

test('session tab: lists who checked in, by group in the Groups tab\'s order, refreshed by the close job and final at close', () => {
  const env = setup({ groups: ['Bravo', 'Alpha'] });
  env.start(ADMIN);
  env.setNow(T0 + MIN);
  env.checkin(MEMBER);
  env.saveProfile(MEMBER, 'CPL Cy Tan', 'Alpha');
  env.setNow(T0 + 2 * MIN);
  env.checkin(MEMBER2);
  env.saveProfile(MEMBER2, 'LCP Di Ong', 'Bravo');
  env.setNow(T0 + 3 * MIN);
  env.checkin(ADMIN);
  assert.equal(tabRows(env)[1][0], 'Nobody has checked in yet.', 'not rewritten by each check-in');

  close(env);
  const rows = tabRows(env);
  assert.equal(rows[1][0], '3 checked in · Bravo 1 · Alpha 1 · No group 1');
  assert.deepEqual(people(env), [['Bravo', 'LCP Di Ong'], ['Alpha', 'CPL Cy Tan'], ['', '']]);
  assert.deepEqual(rows[5].slice(5, 7), ['Di', '']);
  assert.deepEqual(rows[6].slice(5, 7), ['Cy Member', '@cy']);
  assert.deepEqual(rows[7].slice(5, 7), ['Ada Admin', '@ada']);
  assert.equal(rows[6][3].getTime(), T0 + MIN, 'the check-in time, as a time');

  env.setNow(T0 + 60 * MIN);
  close(env);
  assert.match(tabRows(env)[2][0], /Final list: the check-in closed at 11:30/);
  const final = JSON.stringify(tabRows(env));
  env.setNow(T0 + 70 * MIN);
  close(env);
  assert.equal(JSON.stringify(tabRows(env)), final, 'a closed check-in\'s tab is left alone');
});

test('session tab: everyone is listed once, however many times they tapped', () => {
  const env = setup();
  env.start(ADMIN);
  for (let i = 0; i < 3; i++) env.checkin(MEMBER);
  env.checkin(MEMBER, OFFSITE);
  close(env);
  assert.equal(people(env).length, 1);
});

test('session tab: names are written as text, never as formulas', () => {
  const env = setup({ groups: ["'+Alpha"] }); // typed with an apostrophe, as the owner would
  env.start(ADMIN);
  env.checkin({ ...MEMBER, first_name: '=HYPERLINK("http://evil.example","x")', username: 'x' });
  env.saveProfile(MEMBER, '+65 Tan', '+Alpha');
  close(env);
  assert.deepEqual(env.formulaWrites, []);
  const row = tabRows(env)[5];
  assert.deepEqual([row[0], row[2]], ['+Alpha', "'+65 Tan"]);
  assert.match(row[5], /^'=HYPERLINK/);
});

test('session tab: one per check-in, newest first; each lists only its own people', () => {
  const env = setup();
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.setNow(T0 + 60 * MIN);
  close(env);
  env.setNow(T0 + 120 * MIN);
  env.start(ADMIN2);
  env.checkin(MEMBER2);
  close(env);
  const names = env.ss.getSheets().map((s) => s.getName());
  assert.deepEqual(names.slice(0, 2), ['21 Sep 2026 1230', TAB]);
  assert.deepEqual(people(env, '21 Sep 2026 1230'), [['', '']]);
  assert.equal(tabRows(env, '21 Sep 2026 1230')[5][5], 'Di');
  assert.equal(tabRows(env)[5][5], 'Cy Member');
});

test('session tab: renamed by the owner, it is still the one kept up to date (no duplicate)', () => {
  const env = setup();
  env.start(ADMIN);
  tab(env).setName('Monday morning');
  env.checkin(MEMBER);
  close(env);
  assert.equal(tab(env), null);
  assert.equal(people(env, 'Monday morning').length, 1);
  assert.equal(env.ss.getSheets().filter((s) => s.metadata.length).length, 1);
});

test('session tab: an owner\'s own tab with the same name is never overwritten', () => {
  const env = setup();
  const mine = env.ss.insertSheet(TAB);
  mine.appendRow(['my notes']);
  env.start(ADMIN);
  assert.deepEqual(mine.rows(), [], 'row 1 only');
  assert.equal(mine.getRange(1, 1).getValue(), 'my notes');
  assert.ok(env.sheet(TAB + ' (check-in)'), 'the check-in got its own tab');
});

test('session tab: deleted while the check-in is open, the next close-job run puts it back', () => {
  const env = setup();
  env.start(ADMIN);
  env.ss.deleteSheet(tab(env));
  env.checkin(MEMBER);
  close(env);
  assert.equal(people(env).length, 1);
});

test('session tab: if it can\'t be made, the check-in still starts, and the close job makes it later', () => {
  const env = setup();
  env.insertSheetThrows = true;
  const r = env.start(ADMIN);
  assert.equal(r.code, 'SESSION_STARTED');
  assert.ok(env.logs.some((l) => /session tab/i.test(l.text)), JSON.stringify(env.logs));
  env.insertSheetThrows = false;
  assert.equal(env.checkin(MEMBER).code, 'CHECKED_IN');
  close(env);
  assert.equal(people(env).length, 1);
});

test('session tab: if the final update fails, the next run writes it (and only then leaves the tab alone)', () => {
  const env = setup();
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.setNow(T0 + 60 * MIN);
  env.eval('var realWrite_ = writeSessionTab_; writeSessionTab_ = function () { throw new Error("Service Spreadsheets timed out."); };');
  close(env);
  assert.match(tabRows(env)[2][0], /Updates every 5 minutes/, 'still the snapshot from the start');
  env.eval('writeSessionTab_ = realWrite_;');
  env.setNow(T0 + 65 * MIN);
  close(env);
  assert.match(tabRows(env)[2][0], /Final list/);
  assert.equal(people(env).length, 1);
  assert.equal(Object.keys(env.props).filter((k) => k.startsWith('TAB_PENDING:')).length, 0);
});

test('session tab: a final update still failing a day later is given up (logged), not retried forever', () => {
  const env = setup();
  env.start(ADMIN);
  env.setNow(T0 + 60 * MIN);
  env.eval('writeSessionTab_ = function () { throw new Error("broken"); };');
  close(env);
  env.setNow(T0 + 60 * MIN + 25 * 60 * MIN);
  close(env);
  assert.equal(Object.keys(env.props).filter((k) => k.startsWith('TAB_PENDING:')).length, 0);
  assert.ok(env.logs.some((l) => /gave up/i.test(l.text)), JSON.stringify(env.logs.map((l) => l.text)));
});

test('session tab: a check-in that closed before its tab could be made gets one, with the final list', () => {
  const env = setup();
  env.insertSheetThrows = true;
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.setNow(T0 + 60 * MIN);
  close(env);
  env.insertSheetThrows = false;
  env.setNow(T0 + 65 * MIN);
  close(env);
  assert.match(tabRows(env)[2][0], /Final list/);
  assert.equal(people(env).length, 1);
});

test('session tab: made while the check-in lock is held, so the close job and a start can\'t make two', () => {
  const env = setup();
  env.events.length = 0;
  env.start(ADMIN);
  const lockAt = env.events.findIndex((e) => e.type === 'lock');
  const insertAt = env.events.findIndex((e) => e.type === 'insertSheet');
  const unlockAt = env.events.findIndex((e, i) => i > lockAt && e.type === 'unlock');
  assert.ok(lockAt < insertAt && insertAt < unlockAt, JSON.stringify(env.events.map((e) => e.type)));
  // ...and before the group is told, so nobody is queueing behind it yet.
  const announceAt = env.events.findIndex((e) => e.type === 'fetch' && /sendMessage/.test(e.url));
  assert.ok(insertAt < announceAt);
});
