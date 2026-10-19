'use strict';
/**
 * Owner requests of 2026-10-15: late check-ins (accepted for LATE_MINUTES after the on-time window,
 * marked late; a new check-in ends the late window early), rank and full name saved separately,
 * and a Nominal Roll tab coloured by the latest check-in.
 * 2026-10-19: "i dont want to penalise the people checking-in late just say checked in when
 * confirmed and silently mark them late in the google sheet". Members, and the group, are never
 * told who is late: only the Log, the check-in's tab and the Nominal Roll say it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, SITE_FIX, T0, MIN, ADMIN, ADMIN2, MEMBER, MEMBER2, OUTSIDER, ONSITE, OFFSITE } = require('./helpers');

// SESSION_MINUTES 60 (default): on time 10:30-11:30; late until 12:30.
const lateSetup = (opts = {}) => setup({ ...opts, config: { LATE_MINUTES: '60', ...(opts.config || {}) } });
const close = (env) => env.call('closeExpiredSessions');
const at = (env, minutes) => env.setNow(T0 + minutes * MIN);
const MEMBER3 = { id: 666666, first_name: 'Fa', last_name: 'Lim', username: 'fa' };

// ---------- late check-ins ----------

// The answer a member gets says nothing about being late; only the Log does.
const assertSilent = (data, label) => {
  assert.ok(!('late' in data) && !('minutesLate' in data), label + ': no late flag or minutes late in ' + JSON.stringify(data));
};

test('late: after the on-time window, check-ins are accepted for LATE_MINUTES more, marked late in the Log only', () => {
  const env = lateSetup();
  env.start(ADMIN);
  at(env, 30);
  const onTime = env.checkin(MEMBER);
  assert.equal(onTime.code, 'CHECKED_IN');
  assert.equal(onTime.message, 'Checked in at 11:00.');
  assert.equal(onTime.data.openUntilText, '11:30');
  assertSilent(onTime.data, 'on time');
  at(env, 72);
  const late = env.checkin(MEMBER2);
  assert.equal(late.code, 'CHECKED_IN');
  assert.equal(late.message, 'Checked in at 11:42.', 'the same words as on time');
  assert.equal(late.data.openUntilText, '12:30', 'check-in now closes at the end of the late window');
  assert.equal(late.data.closesAtText, '12:30', 'an old copy of the app shows "Check-in closes at 12:30."');
  assertSilent(late.data, 'late');
  assert.deepEqual(env.records('Log').map((r) => r.minutes_late), ['', 12]);
  at(env, 120);
  assert.equal(env.checkin(MEMBER3).code, 'NO_ACTIVE_SESSION');
});

test('late: checking in at the very moment it closes is late by 1 minute, never 0', () => {
  const env = lateSetup();
  env.start(ADMIN);
  env.setNow(T0 + 60 * MIN);
  assert.equal(env.checkin(MEMBER).data.openUntilText, '12:30');
  env.setNow(T0 + 60 * MIN + 5000);
  env.checkin(MEMBER2);
  assert.deepEqual(env.records('Log').map((r) => r.minutes_late), [1, 1]);
});

test('late: admins get the phase; members see one plain window, so no app (even an old copy) can say late', () => {
  const env = lateSetup();
  env.start(ADMIN);
  at(env, 50);
  const before = env.req('status', MEMBER).data.activeSession;
  assert.deepEqual([before.late, before.closesAtText], [false, '11:30'], 'on time: the time the group was told');
  at(env, 65);
  const s = env.req('status', MEMBER).data;
  assert.deepEqual([s.activeSession.late, s.activeSession.closesAtText, s.activeSession.lateUntilText], [false, '12:30', '12:30']);
  assert.equal(s.activeSession.closesAt, s.activeSession.lateUntil);
  assert.doesNotMatch(JSON.stringify(s), /"late":true|minutesLate/);
  const a = env.req('status', ADMIN2).data;
  assert.deepEqual([a.activeSession.late, a.activeSession.closesAtText, a.activeSession.lateUntilText], [true, '11:30', '12:30']);
  assert.equal(a.lateMinutes, 60);
  env.checkin(MEMBER);
  const again = env.checkin(MEMBER);
  assert.equal(again.code, 'ALREADY_CHECKED_IN');
  assertSilent(again.data, 'repeat tap');
  env.cache.clear(); // reopened later: the Log decides
  const mine = env.req('status', MEMBER).data.myCheckin;
  assert.deepEqual(Object.keys(mine).sort(), ['at', 'atText']);
  assert.deepEqual(env.records('Log').map((r) => r.minutes_late), [5]);
});

test('late: an on-time check-in tapped again in the late window gives the time check-in now closes', () => {
  const env = lateSetup();
  env.start(ADMIN);
  at(env, 20);
  assert.equal(env.checkin(MEMBER).data.openUntilText, '11:30');
  at(env, 70);
  const again = env.checkin(MEMBER);
  assert.equal(again.code, 'ALREADY_CHECKED_IN');
  assert.equal(again.data.atText, '10:50');
  assert.equal(again.data.openUntilText, '12:30');
  env.cache.clear();
  assert.equal(env.checkin(MEMBER).data.openUntilText, '12:30', 'the same when the Log answers');
});

test('late: admins get the same answer as members (the Sheet is where lateness shows)', () => {
  const env = lateSetup();
  env.start(ADMIN);
  at(env, 75);
  const r = env.checkin(ADMIN2);
  assert.equal(r.message, 'Checked in at 11:45.');
  assert.deepEqual([r.data.closesAtText, r.data.lateUntilText], ['11:30', '12:30'], 'admins keep the real window');
  assertSilent(r.data, 'admin');
  assertSilent(env.req('status', ADMIN2).data.myCheckin, 'admin status');
});

test('late: LATE_MINUTES 0 means no late window', () => {
  const env = lateSetup({ config: { LATE_MINUTES: '0' } });
  env.start(ADMIN);
  at(env, 60);
  assert.equal(env.checkin(MEMBER).code, 'NO_ACTIVE_SESSION');
});

test('late: the late window is fixed when the check-in starts; a later change applies to the next one', () => {
  const env = lateSetup();
  env.start(ADMIN);
  env.req('saveSettings', ADMIN, { lateMinutes: 10 });
  at(env, 65);
  assert.equal(env.checkin(MEMBER).code, 'CHECKED_IN', 'still the 60 minutes it started with');
  at(env, 121);
  env.start(ADMIN);
  at(env, 121 + 69);
  assert.equal(env.checkin(MEMBER2).code, 'CHECKED_IN', '9 minutes late: inside the next one\'s 10');
  at(env, 121 + 71);
  assert.equal(env.checkin(MEMBER3).code, 'NO_ACTIVE_SESSION', '11 minutes late: outside it');
});

test('late: a new check-in can start during the late window, and ends it', () => {
  const env = lateSetup();
  env.start(ADMIN);
  at(env, 30);
  assert.equal(env.start(ADMIN2).code, 'SESSION_ACTIVE', 'not during the on-time window');
  at(env, 70);
  env.checkin(MEMBER); // late, to the first
  const next = env.start(ADMIN2);
  assert.equal(next.code, 'SESSION_STARTED');
  assert.equal(next.data.endedLateOf, 'Ada Admin');
  const [first] = env.records('Sessions');
  assert.equal(first.late_until.getTime(), T0 + 70 * MIN, 'its late window ends now');
  at(env, 71);
  const r = env.checkin(MEMBER2);
  assert.equal(r.data.sessionId, next.data.sessionId);
  assert.equal(r.data.openUntilText, '12:40', 'on time for the new one');
  assert.equal(env.checkin(MEMBER).data.sessionId, next.data.sessionId, 'a fresh check-in for the new one');
});

test('late: only the starter can change settings or move the point during the late window', () => {
  const env = lateSetup();
  env.start(ADMIN);
  at(env, 70);
  assert.equal(env.req('saveSettings', ADMIN2, { radiusM: 900 }).code, 'SETTINGS_LOCKED');
  assert.equal(env.req('moveSite', ADMIN2, { location: SITE_FIX }).code, 'NOT_STARTER');
  assert.equal(env.req('saveSettings', ADMIN, { radiusM: 900 }).code, 'SETTINGS_SAVED');
  at(env, 120);
  assert.equal(env.req('saveSettings', ADMIN2, { radiusM: 300 }).code, 'SETTINGS_SAVED');
});

test('late: the check-in point and the copy of who checked in last through the late window', () => {
  const env = lateSetup();
  const id = env.start(ADMIN).data.sessionId;
  env.checkin(MEMBER);
  at(env, 90);
  close(env);
  assert.ok(env.siteOf(id));
  env.events.length = 0;
  assert.equal(env.checkin(MEMBER).code, 'ALREADY_CHECKED_IN');
  assert.equal(env.events.filter((e) => e.type === 'tryLock').length, 0, 'answered from the copy');
  at(env, 120);
  close(env);
  assert.equal(env.siteOf(id), null);
});

test('late: the group never hears the word late: on time ends quietly, the button stays, the result just counts', () => {
  const env = lateSetup({ groups: ['Alpha'] });
  env.start(ADMIN);
  const open = env.visible()[0];
  assert.equal(open.text, '📍 Check-in is open until 11:30.\nTap the button when you arrive.');
  env.checkin(MEMBER);
  at(env, 60);
  close(env);
  assert.equal(env.records('Sessions')[0].status, 'late');
  const msg = env.visible()[0];
  assert.equal(msg.messageId, open.messageId, 'the same message, edited');
  assert.equal(msg.text, '📍 Check-in is still open until 12:30.\nTap the button when you arrive.');
  assert.equal(msg.buttons.length, 1, 'the button stays');
  at(env, 70);
  env.checkin(MEMBER2);
  env.saveProfile(MEMBER2, 'Di Ong', 'Alpha', 'LCP');
  at(env, 120);
  close(env);
  const [s] = env.records('Sessions');
  assert.deepEqual([s.status, s.checkin_count], ['closed', 2]);
  const done = env.visible()[0];
  assert.match(done.text, /^Check-in closed at 12:30 · 2 checked in\n/);
  assert.equal(done.buttons.length, 0);
  const said = env.calls('sendMessage').concat(env.calls('editMessageText')).map((m) => m.text);
  assert.ok(said.length >= 3);
  said.forEach((text) => assert.doesNotMatch(text, /late/i, 'everything the bot posted or edited'));
  assert.match(env.sheet('21 Sep 2026 1030').getRange(2, 1).getValue(), /2 checked in \(1 late\)/, 'the tab still counts them');
});

test('late: a check-in whose late window was ended by a new one gets its result posted', () => {
  const env = lateSetup();
  env.start(ADMIN);
  env.checkin(MEMBER);
  at(env, 70);
  env.start(ADMIN2);
  close(env);
  assert.equal(env.records('Sessions')[0].status, 'closed');
  assert.ok(env.visible().some((m) => /^Check-in closed at 11:40 · 1 checked in/.test(m.text)));
  assert.ok(env.visible().some((m) => m.buttons.length && /open until 12:40/.test(m.text)), 'the new one keeps its button');
});

test('late: /checkin during the late window posts the still-open message', () => {
  const env = lateSetup({ props: { WEBHOOK_SECRET: 'f'.repeat(64) } });
  env.start(ADMIN);
  at(env, 61);
  env.webhook({ update_id: 1, message: { message_id: 900, from: MEMBER, chat: { id: -1001234567890, type: 'supergroup' }, date: 0, text: '/checkin' } }, 'f'.repeat(64));
  assert.equal(env.visible().find((m) => m.buttons.length).text, '📍 Check-in is still open until 12:30.\nTap the button when you arrive.');
});

test('late: the app\'s settings include the late window, 0 to 720 minutes', () => {
  const env = lateSetup();
  const r = env.req('saveSettings', ADMIN, { lateMinutes: 30 });
  assert.equal(r.code, 'SETTINGS_SAVED');
  assert.equal(r.data.lateMinutes, 30);
  assert.equal(env.config('LATE_MINUTES'), '30');
  assert.equal(env.req('saveSettings', ADMIN, { lateMinutes: 0 }).code, 'SETTINGS_SAVED');
  for (const bad of [-1, 721, 1.5, '30']) assert.equal(env.req('saveSettings', ADMIN, { lateMinutes: bad }).code, 'INVALID_SETTINGS', String(bad));
  assert.equal(env.req('status', MEMBER).data.lateMinutes, 0);
});

// ---------- rank and full name ----------

test('profile: rank and full name are saved separately, rank in capitals, on Members and the Log', () => {
  const env = lateSetup({ groups: ['Alpha'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  const r = env.saveProfile(MEMBER, 'Tan Wei Ming', 'Alpha', ' cpl ');
  assert.equal(r.code, 'PROFILE_SAVED');
  assert.deepEqual(r.data.profile, { rank: 'CPL', fullName: 'Tan Wei Ming', group: 'Alpha' });
  assert.deepEqual([env.records('Members')[0].rank, env.records('Members')[0].full_name], ['CPL', 'Tan Wei Ming']);
  assert.deepEqual([env.records('Log')[0].rank, env.records('Log')[0].full_name], ['CPL', 'Tan Wei Ming']);
  env.cache.clear();
  assert.deepEqual(env.req('status', MEMBER).data.profile, { rank: 'CPL', fullName: 'Tan Wei Ming', group: 'Alpha' });
  at(env, 61 * 2);
  env.start(ADMIN);
  env.checkin(MEMBER);
  assert.equal(env.records('Log')[1].rank, 'CPL', 'copied onto later check-ins');
});

test('profile: an empty rank is refused; an older app that sends none keeps the saved rank', () => {
  const env = lateSetup({ groups: ['Alpha'] });
  assert.equal(env.saveProfile(MEMBER, 'Tan Wei Ming', 'Alpha', '').code, 'INVALID_RANK');
  assert.equal(env.saveProfile(MEMBER, 'Tan Wei Ming', 'Alpha', 'x'.repeat(13)).code, 'INVALID_RANK');
  env.saveProfile(MEMBER, 'Tan Wei Ming', 'Alpha', 'LCP');
  const r = env.saveProfile(MEMBER, 'Tan Wei Ming', 'Alpha');
  assert.equal(r.data.profile.rank, 'LCP');
});

// ---------- the Nominal Roll tab ----------

const GREEN = '#d9ead3';
const YELLOW = '#fff2cc';
const RED = '#f4cccc';

function addRoll(env, rows, name = 'Nominal Roll', header = ['S/N', 'Rank', 'Name', 'Vocation']) {
  const sheet = env.ss.insertSheet(name);
  sheet.appendRow(header);
  rows.forEach((r) => sheet.appendRow(r));
  return sheet;
}
const rollState = (sheet) => {
  const last = sheet.getLastRow();
  const width = sheet.getLastColumn();
  const values = sheet.getRange(1, 1, last, width).getValues();
  const colours = sheet.getRange(1, 1, last, width).getBackgrounds();
  return { header: values[0], rows: values.slice(1).map((v, i) => ({ name: v[2], status: v[width - 1], colour: colours[i + 1][0], same: new Set(colours[i + 1]).size === 1 })) };
};

test('roll: on time green, late yellow, not in red once the on-time window closes; one text column says which', () => {
  const env = lateSetup({ groups: ['Alpha'] });
  const roll = addRoll(env, [
    [1, 'CPL', 'TAN WEI MING', 'SIG'],
    [2, '3SG', 'CHEN FENG, MARCUS', 'SIG'],
    [3, 'PTE', 'LIM AH KOW', 'SIG'],
    [4, '', '', ''],
  ]);
  env.start(ADMIN);
  at(env, 5);
  env.checkin(MEMBER);
  env.saveProfile(MEMBER, 'Wei Ming Tan', 'Alpha', 'CPL');
  at(env, 30);
  close(env);
  let st = rollState(roll);
  assert.equal(st.header[4], 'Latest check-in: 21 Sep 2026 1030');
  assert.deepEqual(st.rows.map((r) => [r.status, r.colour]), [
    ['On time 10:35', GREEN], ['Not yet', '#ffffff'], ['Not yet', '#ffffff'], ['', '#ffffff']]);
  assert.ok(st.rows[0].same, 'the whole row is coloured');

  at(env, 65);
  close(env);
  st = rollState(roll);
  assert.deepEqual(st.rows.map((r) => r.colour), [GREEN, RED, RED, '#ffffff']);
  assert.equal(st.rows[1].status, 'Not checked in');

  at(env, 70);
  env.checkin(MEMBER2);
  env.saveProfile(MEMBER2, 'marcus chen feng', 'Alpha', '3sg');
  at(env, 120);
  close(env);
  st = rollState(roll);
  assert.deepEqual(st.rows.map((r) => [r.status, r.colour]), [
    ['On time 10:35', GREEN], ['Late 11:40 (10 min)', YELLOW], ['Not checked in', RED], ['', '#ffffff']]);
  assert.deepEqual(roll.getRange(2, 1, 1, 4).getValues()[0], [1, 'CPL', 'TAN WEI MING', 'SIG'], 'the owner\'s data is untouched');
});

test('roll: names match ignoring capitals, punctuation, spacing, word order and a rank typed into the name', () => {
  const env = lateSetup();
  const key = (s) => env.eval('nameKey_(' + JSON.stringify(s) + ')');
  assert.equal(key('CHEN FENG, MARCUS'), key('Marcus  Chen Feng'));
  assert.equal(key('TAN WEI MING'), key('CPL Tan Wei Ming'));
  assert.equal(key('PUVANESHWARAN S/O PANILIANDY'), key('Puvaneshwaran s/o Paniliandy'));
  assert.equal(key('Zoë O\'Neil'), key('ZOË ONEIL'.replace('ONEIL', 'O NEIL')));
  assert.notEqual(key('Tan Wei'), key('Tan Wei Ming'));
  assert.notEqual(key('Tan Wei Ming'), key('Tan Wei Meng'));
  assert.equal(key('   '), '');
  assert.equal(key('CPL'), 'cpl', 'a lone word is kept, even if it looks like a rank');
});

test('roll: a new check-in resets the colours and names itself in the header', () => {
  const env = lateSetup();
  const roll = addRoll(env, [[1, 'CPL', 'CY MEMBER', 'SIG']]);
  env.start(ADMIN);
  env.checkin(MEMBER); // no profile: matched by nothing (full name blank)
  env.saveProfile(MEMBER, 'Cy Member', '', 'CPL');
  close(env);
  assert.equal(rollState(roll).rows[0].colour, GREEN);
  at(env, 130);
  close(env);
  env.start(ADMIN2);
  const st = rollState(roll);
  assert.equal(st.header[4], 'Latest check-in: 21 Sep 2026 1240');
  assert.deepEqual([st.rows[0].status, st.rows[0].colour], ['Not yet', '#ffffff']);
});

test('roll: the status column is reused, never added twice; extra owner columns stay', () => {
  const env = lateSetup();
  const roll = addRoll(env, [[1, 'CPL', 'CY MEMBER', 'SIG', 'note']], 'nominal role', ['S/N', 'Rank', 'Full Name', 'Vocation', 'Remarks']);
  env.start(ADMIN);
  close(env);
  at(env, 10);
  close(env);
  const header = roll.getRange(1, 1, 1, roll.getLastColumn()).getValues()[0];
  assert.equal(header.filter((h) => /^Latest check-in/.test(h)).length, 1);
  assert.deepEqual(header.slice(0, 5), ['S/N', 'Rank', 'Full Name', 'Vocation', 'Remarks']);
  assert.equal(roll.getRange(2, 5).getValue(), 'note');
});

test('roll: no Nominal Roll tab, or one without a Name column, changes nothing and breaks nothing', () => {
  const env = lateSetup();
  env.start(ADMIN);
  env.checkin(MEMBER);
  close(env);
  const roll = addRoll(env, [['x']], 'Nominal Roll', ['Who']);
  close(env);
  assert.equal(roll.getLastColumn(), 1);
  assert.ok(env.logs.some((l) => /Nominal Roll.*Name/.test(l.text)), JSON.stringify(env.logs.map((l) => l.text)));
  assert.equal(env.checkin(MEMBER2).code, 'CHECKED_IN');
});

// ---------- the check-in's own tab ----------

test('session tab: rank and full name in their own columns, how late, and whether they are on the nominal roll', () => {
  const env = lateSetup({ groups: ['Alpha'] });
  addRoll(env, [[1, 'CPL', 'TAN WEI MING', 'SIG']]);
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.saveProfile(MEMBER, 'Tan Wei Ming', 'Alpha', 'CPL');
  at(env, 75);
  env.checkin(MEMBER2);
  env.saveProfile(MEMBER2, 'Di Ong', 'Alpha', 'LCP');
  close(env);
  const tab = env.sheet('21 Sep 2026 1030');
  const rows = tab.getRange(1, 1, tab.getLastRow(), 8).getValues();
  assert.match(rows[0][0], /10:30 to 11:30, late until 12:30/);
  assert.equal(rows[1][0], '2 checked in (1 late) · Alpha 2 · 1 not on the nominal roll');
  assert.match(rows[2][0], /On-time check-in closed at 11:30; late check-ins until 12:30/);
  assert.deepEqual(rows[4], ['Group', 'Rank', 'Full name', 'Checked in at', 'Late by', 'Telegram name', 'Username', 'On nominal roll']);
  assert.deepEqual(rows[5].slice(0, 3).concat(rows[5].slice(4)), ['Alpha', 'CPL', 'Tan Wei Ming', '', 'Cy Member', '@cy', 'Yes']);
  assert.deepEqual(rows[6].slice(0, 3).concat(rows[6].slice(4)), ['Alpha', 'LCP', 'Di Ong', '15 min', 'Di', '', 'No']);
});

// ---------- updating an existing Sheet ----------

test('setup: an existing Sheet gains late_until, rank, minutes_late and LATE_MINUTES 60; until then, "run setup()"', () => {
  const env = setup();
  // As the October version left it.
  const trim = (name, cols) => env.sheet(name).getRange(1, cols + 1, 1, env.sheet(name).getMaxColumns() - cols).setValue('');
  trim('Sessions', 9);
  trim('Log', 11);
  trim('Members', 6);
  const cfg = env.sheet('Config');
  for (let r = 2; r <= cfg.getLastRow(); r++) if (cfg.getRange(r, 1).getValue() === 'LATE_MINUTES') cfg.getRange(r, 1, 1, 2).setValues([['', '']]);
  const r = env.start(ADMIN);
  assert.equal(r.code, 'SERVER_ERROR');
  assert.match(r.message, /run setup\(\) once/);
  env.call('setupSheets');
  assert.equal(env.sheet('Sessions').getRange(1, 10).getValue(), 'late_until');
  assert.deepEqual(env.sheet('Log').getRange(1, 12, 1, 2).getValues()[0], ['rank', 'minutes_late']);
  assert.equal(env.sheet('Members').getRange(1, 7).getValue(), 'rank');
  assert.equal(env.config('LATE_MINUTES'), '60');
  assert.equal(env.start(ADMIN).code, 'SESSION_STARTED');
});

test('setup: sessions from before late check-ins (no late_until) simply have none', () => {
  const env = lateSetup();
  env.sheet('Sessions').appendRow(['S-20260921-1030', ADMIN.id, 'Ada Admin', new Date(T0), new Date(T0 + 60 * MIN), '', 'open', 0, 12, '']);
  env.props['SITE:S-20260921-1030'] = JSON.stringify({ lat: SITE_FIX.lat, lng: SITE_FIX.lng });
  at(env, 59);
  assert.equal(env.checkin(MEMBER).code, 'CHECKED_IN');
  at(env, 61);
  assert.equal(env.checkin(MEMBER2).code, 'NO_ACTIVE_SESSION');
});

// ---------- review fixes ----------

test('roll: a name corrected on the Members tab counts for the check-in in progress', () => {
  const env = lateSetup({ groups: ['Alpha'] });
  const roll = addRoll(env, [[1, 'CPL', 'TAN WEI MING', 'SIG']]);
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.saveProfile(MEMBER, 'Wei Ming', 'Alpha', 'CPL'); // a typo
  const members = env.sheet('Members');
  members.getRange(2, 2).setValue('Tan Wei Ming'); // the owner corrects it
  at(env, 65);
  close(env);
  assert.equal(rollState(roll).rows[0].colour, GREEN);
  const tab = env.sheet('21 Sep 2026 1030');
  assert.deepEqual(tab.getRange(6, 3).getValue(), 'Tan Wei Ming');
  assert.equal(tab.getRange(6, 8).getValue(), 'Yes');
});

test('roll: a first-timer who saves their name just after the late window still matches', () => {
  const env = lateSetup({ groups: ['Alpha'] });
  const roll = addRoll(env, [[1, 'CPL', 'TAN WEI MING', 'SIG']]);
  env.start(ADMIN);
  env.setNow(T0 + 120 * MIN - 20000);
  env.checkin(MEMBER); // 12:29:55, late
  env.setNow(T0 + 120 * MIN + 20000);
  assert.equal(env.saveProfile(MEMBER, 'Tan Wei Ming', 'Alpha', 'CPL').code, 'PROFILE_SAVED');
  close(env);
  assert.equal(rollState(roll).rows[0].colour, YELLOW);
});

test('close: a session stuck open for over a day doesn\'t stop the close job handling the live one', () => {
  const env = lateSetup();
  env.sheet('Sessions').appendRow(['S-20260920-0900', ADMIN.id, 'Ada Admin', new Date(T0 - 30 * 60 * MIN), new Date(T0 - 29 * 60 * MIN),
    '', 'open', 0, 12, new Date(T0 - 28 * 60 * MIN)]);
  env.start(ADMIN);
  env.checkin(MEMBER);
  close(env);
  assert.ok(!env.logs.some((l) => /closeExpiredSessions:/.test(l.text)), JSON.stringify(env.logs.map((l) => l.text)));
  const [old, live] = env.records('Sessions');
  assert.equal(old.status, 'closed');
  assert.equal(live.checkin_count, 1);
});

test('late: refusals during the late window name when late check-ins end', () => {
  const env = lateSetup();
  env.start(ADMIN);
  at(env, 70);
  assert.match(env.req('saveSettings', ADMIN2, { radiusM: 900 }).message, /until late check-ins end at 12:30/);
  assert.match(env.req('moveSite', ADMIN2, { location: SITE_FIX }).message, /until late check-ins end at 12:30/);
  at(env, 10); // on time, but the lock lasts through the late window
  assert.match(env.req('saveSettings', ADMIN2, { radiusM: 900 }).message, /until late check-ins end at 12:30/);
});

// Owner, 2026-10-19: "if names cannot be matched flag silently in the google sheets, still allow the user to check in".
test('roll: a name not on the roll still checks in; only the check-in tab flags it, with the count', () => {
  const env = lateSetup({ groups: ['42M'] });
  addRoll(env, [['LTA', 'JEK KAI ZHI, HOWARD', 'V42'], ['CPL', 'CHEN FENG, MARCUS', 'V41']], 'Nominal Role', ['Rank', 'Name', 'Group']);
  env.start(ADMIN);
  const a = env.checkin(MEMBER);
  env.saveProfile(MEMBER, 'Howard Jek Kai Zhi', '42M', 'LTA'); // any order: on the roll
  const b = env.checkin(MEMBER2);
  const saved = env.saveProfile(MEMBER2, 'Howard Jek', '42M', 'LTA'); // part of a name: not a match
  assert.deepEqual([a.code, b.code, saved.code], ['CHECKED_IN', 'CHECKED_IN', 'PROFILE_SAVED']);
  [a, b, saved].forEach((r) => assert.doesNotMatch(JSON.stringify(r), /roll|nominal/i, 'the member is told nothing'));
  close(env);
  const tab = env.sheet('21 Sep 2026 1030');
  const rows = tab.getRange(1, 1, tab.getLastRow(), 8).getValues();
  assert.equal(rows[1][0], '2 checked in · 42M 2 · 1 not on the nominal roll');
  assert.deepEqual(rows.slice(5).map((r) => [r[2], r[7]]), [['Howard Jek Kai Zhi', 'Yes'], ['Howard Jek', 'No']]);
  const colours = tab.getRange(6, 8, 2, 1).getBackgrounds().map((r) => r[0]);
  assert.deepEqual(colours, ['#ffffff', '#fce5cd'], 'the "No" stands out');
  // A correction on the Members tab (while the check-in is open) clears the flag on the next run.
  const members = env.sheet('Members');
  const row = members.getRange(1, 1, members.getLastRow(), 2).getValues().findIndex((r) => String(r[0]) === String(MEMBER2.id)) + 1;
  members.getRange(row, 2).setValue('Jek Kai Zhi Howard');
  close(env);
  assert.equal(tab.getRange(2, 1).getValue(), '2 checked in · 42M 2');
  assert.deepEqual(tab.getRange(6, 8, 2, 1).getBackgrounds().map((r) => r[0]), ['#ffffff', '#ffffff']);
});

test('roll: with no Nominal Roll tab the check-in tab has no flags at all', () => {
  const env = lateSetup();
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.saveProfile(MEMBER, 'Anyone At All', '', 'CPL');
  close(env);
  const tab = env.sheet('21 Sep 2026 1030');
  assert.equal(tab.getRange(2, 1).getValue(), '1 checked in');
  assert.equal(tab.getRange(6, 8).getValue(), '');
  assert.equal(tab.getRange(6, 8).getBackgrounds()[0][0], '#ffffff');
});

test('late: if the new check-in can\'t be saved, the old late window carries on', () => {
  const env = lateSetup();
  env.start(ADMIN);
  at(env, 70);
  env.setPropertyThrows = (k) => k.startsWith('SITE:');
  assert.equal(env.start(ADMIN2).code, 'SERVER_ERROR');
  env.setPropertyThrows = null;
  assert.equal(env.records('Sessions')[0].late_until.getTime(), T0 + 120 * MIN);
  assert.equal(env.checkin(MEMBER).data.openUntilText, '12:30');
});

test('roll: the same name twice is flagged, not coloured; rows with no name keep the owner\'s colours', () => {
  const env = lateSetup();
  const roll = addRoll(env, [[1, 'CPL', 'CY MEMBER', 'SIG'], [2, 'LCP', 'Cy Member', 'SIG'], ['', '', '', 'Remarks']]);
  roll.getRange(4, 1, 1, 4).setBackground('#cccccc');
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.saveProfile(MEMBER, 'Cy Member', '', 'CPL');
  close(env);
  const st = rollState(roll);
  assert.deepEqual(st.rows.slice(0, 2).map((r) => [r.status, r.colour]),
    [['Same name twice on the roll', '#ffffff'], ['Same name twice on the roll', '#ffffff']]);
  assert.equal(st.rows[2].colour, '#cccccc');
  assert.ok(env.logs.some((l) => /same name on more than one row/.test(l.text)));
});

test('roll: a new check-in started while the close job is writing keeps the roll on the new one', () => {
  const env = lateSetup();
  const roll = addRoll(env, [[1, 'CPL', 'CY MEMBER', 'SIG']]);
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.saveProfile(MEMBER, 'Cy Member', '', 'CPL');
  at(env, 70);
  env.context.__beforeRoll = () => env.start(ADMIN2); // lands after the close job let go of the lock
  env.eval('var realReadRoll_ = readRoll_; readRoll_ = function () { var h = globalThis.__beforeRoll; globalThis.__beforeRoll = null; if (h) h(); return realReadRoll_(); };');
  close(env);
  const st = rollState(roll);
  assert.equal(st.header[4], 'Latest check-in: 21 Sep 2026 1140');
  assert.deepEqual([st.rows[0].status, st.rows[0].colour], ['Not yet', '#ffffff']);
});

test('roll: reset at start happens after the check-in lock is let go', () => {
  const env = lateSetup();
  addRoll(env, [[1, 'CPL', 'CY MEMBER', 'SIG']]);
  env.events.length = 0;
  env.start(ADMIN);
  const unlockAt = env.events.findIndex((e) => e.type === 'unlock');
  const rollWriteAt = env.events.findIndex((e) => e.type === 'write' && e.sheet === 'Nominal Roll');
  assert.ok(rollWriteAt > unlockAt && unlockAt !== -1, JSON.stringify(env.events.map((e) => e.type + (e.sheet ? ':' + e.sheet : ''))));
});

// ---------- review fixes, round 2 ----------

test('roll: a duplicate Members row for someone doesn\'t replace the one the app saves to', () => {
  const env = lateSetup();
  const roll = addRoll(env, [[1, 'CPL', 'TAN WEI MING', 'SIG']]);
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.saveProfile(MEMBER, 'Tan Wei Ming', '', 'CPL');
  env.sheet('Members').appendRow(["'" + MEMBER.id, 'Old Wrong Name', '', 'Cy', 'cy', new Date(T0), 'CPL']);
  close(env);
  assert.equal(rollState(roll).rows[0].colour, GREEN);
});

test('roll: a row whose name the owner clears loses the bot\'s colour', () => {
  const env = lateSetup();
  const roll = addRoll(env, [[1, 'CPL', 'CY MEMBER', 'SIG']]);
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.saveProfile(MEMBER, 'Cy Member', '', 'CPL');
  close(env);
  assert.equal(rollState(roll).rows[0].colour, GREEN);
  roll.getRange(2, 3).setValue('');
  at(env, 5);
  close(env);
  assert.equal(rollState(roll).rows[0].colour, '#ffffff');
});

test('close: a session stuck for over a day is closed even when it is the only one', () => {
  const env = lateSetup();
  env.sheet('Sessions').appendRow(['S-20260920-0900', ADMIN.id, 'Ada Admin', new Date(T0 - 30 * 60 * MIN), new Date(T0 - 29 * 60 * MIN),
    '', 'open', 0, 12, new Date(T0 - 28 * 60 * MIN)]);
  close(env);
  assert.equal(env.records('Sessions')[0].status, 'closed');
});
