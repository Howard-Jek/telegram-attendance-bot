'use strict';
/**
 * Live run of 2026-10-19 (~120 people): "when selecting the groups or saving the rank and name to
 * finish check in, the loading button is stuck loading". Every save queued on one lock held through
 * about nine Sheets calls, and for about two minutes the lock was hardly ever granted. Now only a
 * person's first save takes the lock, and only around adding their Members row; changing a saved
 * row, and copying the details onto today's Log row, take no lock at all.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, ADMIN, MEMBER, MEMBER2 } = require('./helpers');

const members = (env) => env.records('Members');
const rowsFor = (env, user) => members(env).filter((r) => String(r.user_id) === String(user.id));
const between = (events, from, to) => {
  const a = events.findIndex((e) => e.type === from);
  const b = events.findIndex((e, i) => i > a && e.type === to);
  assert.ok(a !== -1 && b !== -1, 'saw ' + from + ' then ' + to);
  return events.slice(a + 1, b);
};

test('profile save: changing a saved name or group takes no lock, even while check-ins and first saves queue', () => {
  const env = setup({ groups: ['Alpha', 'Bravo'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  assert.equal(env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL').code, 'PROFILE_SAVED');
  env.lockHeldElsewhere = true; // a crowd is checking in
  env.userLockHeldElsewhere = true; // and first saves are queueing
  env.events.length = 0;
  const r = env.saveProfile(MEMBER, 'Cy Tan Wei', 'Bravo', 'LCP');
  assert.equal(r.code, 'PROFILE_SAVED');
  assert.equal(env.events.filter((e) => e.type === 'tryLock' || e.type === 'tryUserLock').length, 0, 'no lock at all');
  assert.equal(rowsFor(env, MEMBER).length, 1, 'the same row, updated in place');
  assert.deepEqual([rowsFor(env, MEMBER)[0].full_name, rowsFor(env, MEMBER)[0].group, rowsFor(env, MEMBER)[0].rank], ['Cy Tan Wei', 'Bravo', 'LCP']);
  const [log] = env.records('Log');
  assert.deepEqual([log.full_name, log.group, log.rank], ['Cy Tan Wei', 'Bravo', 'LCP'], 'today\'s Log row too');
});

test('profile save: a first save holds the profile lock only to add the Members row', () => {
  const env = setup({ groups: ['Alpha'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.events.length = 0;
  assert.equal(env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL').code, 'PROFILE_SAVED');
  const inside = between(env.events, 'userLock', 'userUnlock');
  assert.equal(inside.filter((e) => e.type === 'find').length, 0, 'no Log search under the lock');
  assert.equal(inside.filter((e) => e.type === 'write' && e.sheet === 'Log').length, 0, 'no Log write under the lock');
  assert.equal(inside.filter((e) => e.type === 'open').length, 0, 'the Sheet is opened before the lock');
  assert.equal(inside.filter((e) => e.type === 'flush').length, 1, 'one flush');
  assert.ok(inside.some((e) => e.type === 'write' && e.sheet === 'Members'), 'the row is added under the lock');
  const after = env.events.slice(env.events.findIndex((e) => e.type === 'userUnlock'));
  assert.ok(after.some((e) => e.type === 'write' && e.sheet === 'Log'), 'the Log row is written after the lock is let go');
  assert.equal(env.records('Log')[0].full_name, 'Cy Tan');
});

test('profile save: a first save waits at most 5 s for the lock, then answers BUSY and saves nothing', () => {
  const env = setup({ groups: ['Alpha'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.userLockHeldElsewhere = true;
  env.events.length = 0;
  const r = env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL');
  assert.equal(r.code, 'BUSY');
  assert.deepEqual(env.events.filter((e) => e.type === 'tryUserLock').map((e) => e.ms), [5000]);
  assert.equal(rowsFor(env, MEMBER).length, 0);
  assert.equal(env.records('Log')[0].full_name, '');
  assert.equal(env.req('status', MEMBER).data.profile, null, 'status doesn\'t claim it was saved');
  assert.ok(env.logs.some((l) => l.level === 'warn' && /got no lock in 5000 ms/.test(l.text)), 'the owner can see it on Executions');
});

test('profile save: two copies of one first save racing for the lock leave exactly one Members row', () => {
  const env = setup({ groups: ['Alpha'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  let copy;
  env.raceBeforeNextUserLock(() => { copy = env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL'); });
  const first = env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL');
  assert.deepEqual([first.code, copy.code], ['PROFILE_SAVED', 'PROFILE_SAVED']);
  assert.equal(rowsFor(env, MEMBER).length, 1);
});

test('profile save: two people\'s first saves at once get a row each', () => {
  const env = setup({ groups: ['Alpha', 'Bravo'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.checkin(MEMBER2);
  let other;
  env.raceBeforeNextUserLock(() => { other = env.saveProfile(MEMBER2, 'Di Ong', 'Bravo', 'LCP'); });
  assert.equal(env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL').code, 'PROFILE_SAVED');
  assert.equal(other.code, 'PROFILE_SAVED');
  assert.deepEqual(members(env).map((r) => [String(r.user_id), r.full_name]).sort(),
    [[String(MEMBER.id), 'Cy Tan'], [String(MEMBER2.id), 'Di Ong']].sort());
  assert.deepEqual(env.records('Log').map((r) => r.full_name), ['Cy Tan', 'Di Ong']);
});

test('profile save: the profile lock is let go even if the flush under it fails', () => {
  const env = setup({ groups: ['Alpha'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.checkin(MEMBER2);
  env.flushThrows = () => env.userLock.held; // Sheets times out while the Members row is being added
  const r = env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL');
  assert.equal(r.ok, false);
  assert.equal(env.userLock.held, false, 'released');
  assert.equal(env.req('status', MEMBER).data.profile, null, 'status doesn\'t claim the failed save');
  env.flushThrows = null;
  assert.equal(env.saveProfile(MEMBER2, 'Di Ong', 'Alpha', 'LCP').code, 'PROFILE_SAVED', 'the next save isn\'t blocked');
});

test('profile save: if copying onto today\'s Log row fails, the save still stands', () => {
  const env = setup({ groups: ['Alpha'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  const from = env.events.length;
  // Every flush after the Log row is written fails (both tries).
  env.flushThrows = () => env.events.slice(from).some((e) => e.type === 'write' && e.sheet === 'Log');
  const r = env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL');
  env.flushThrows = null;
  assert.equal(r.code, 'PROFILE_SAVED');
  assert.equal(rowsFor(env, MEMBER)[0].full_name, 'Cy Tan');
  assert.ok(env.logs.some((l) => l.level === 'warn' && /Log row/.test(l.text)), 'logged');
  assert.equal(env.req('status', MEMBER).data.profile.fullName, 'Cy Tan');
});

test('profile save: status shows the new details straight after either kind of save', () => {
  const env = setup({ groups: ['Alpha', 'Bravo'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL');
  assert.deepEqual(env.req('status', MEMBER).data.profile, { rank: 'CPL', fullName: 'Cy Tan', group: 'Alpha' });
  env.saveProfile(MEMBER, 'Cy Tan', 'Bravo', 'CPL');
  assert.deepEqual(env.req('status', MEMBER).data.profile, { rank: 'CPL', fullName: 'Cy Tan', group: 'Bravo' });
});

test('profile save: a save of the same details again is answered without a lock once the row exists', () => {
  const env = setup({ groups: ['Alpha'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL');
  env.userLockHeldElsewhere = true;
  env.events.length = 0;
  assert.equal(env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL').code, 'PROFILE_SAVED', 'a late copy of the same save');
  assert.equal(env.events.filter((e) => e.type === 'tryUserLock').length, 0);
  assert.equal(rowsFor(env, MEMBER).length, 1);
});

test('profile save: a copy of one first save arriving while the other holds the lock adds no second row', () => {
  const env = setup({ groups: ['Alpha'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  let copy;
  env.raceWhileUserLockHeld(() => { copy = env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL'); });
  assert.equal(env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL').code, 'PROFILE_SAVED');
  assert.equal(copy.code, 'BUSY', 'its wait runs out (the app then asks status)');
  assert.equal(rowsFor(env, MEMBER).length, 1);
});

test('profile save: a change to a saved row whose flush fails is not reported saved', () => {
  const env = setup({ groups: ['Alpha', 'Bravo'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  assert.equal(env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL').code, 'PROFILE_SAVED');
  env.flushThrows = () => true;
  const r = env.saveProfile(MEMBER, 'Cy Tan', 'Bravo', 'CPL');
  env.flushThrows = null;
  assert.equal(r.ok, false);
  assert.equal(env.req('status', MEMBER).data.profile.group, 'Alpha', 'status doesn\'t claim the failed change');
});

// After the "couldn't save" notice the person may pick again; a late copy of the earlier save must not win.
const saveAt = (env, user, fullName, group, rank, savedAt) => env.req('saveProfile', user, { fullName, group, rank, savedAt });

test('profile save: a late copy of an older save never overwrites a newer one', () => {
  const env = setup({ groups: ['Alpha', 'Bravo'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  assert.equal(saveAt(env, MEMBER, 'Cy Tan', 'Alpha', 'CPL', 1000).code, 'PROFILE_SAVED');
  assert.equal(saveAt(env, MEMBER, 'Cy Tan', 'Bravo', 'CPL', 2000).code, 'PROFILE_SAVED');
  const stale = saveAt(env, MEMBER, 'Cy Tan', 'Alpha', 'CPL', 1000); // a copy of the first, still queued
  assert.equal(stale.code, 'PROFILE_SAVED');
  assert.equal(stale.data.profile.group, 'Bravo', 'answered with what is saved');
  assert.equal(rowsFor(env, MEMBER)[0].group, 'Bravo');
  assert.equal(env.records('Log')[0].group, 'Bravo');
  assert.equal(env.req('status', MEMBER).data.profile.group, 'Bravo');
});

test('profile save: a stale copy of a first save that finds the row added by a newer save leaves it alone', () => {
  const env = setup({ groups: ['Alpha', 'Bravo'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  let stale;
  // The newer save (Bravo) adds the row while the older one (Alpha) waits for the lock.
  env.raceBeforeNextUserLock(() => { assert.equal(saveAt(env, MEMBER, 'Cy Tan', 'Bravo', 'CPL', 2000).code, 'PROFILE_SAVED'); });
  stale = saveAt(env, MEMBER, 'Cy Tan', 'Alpha', 'CPL', 1000);
  assert.equal(stale.data.profile.group, 'Bravo');
  assert.equal(rowsFor(env, MEMBER).length, 1);
  assert.equal(rowsFor(env, MEMBER)[0].group, 'Bravo');
});

test('profile save: an app without save times (an older copy) still saves every time', () => {
  const env = setup({ groups: ['Alpha', 'Bravo'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  saveAt(env, MEMBER, 'Cy Tan', 'Alpha', 'CPL', 5000);
  assert.equal(env.saveProfile(MEMBER, 'Cy Tan', 'Bravo', 'CPL').data.profile.group, 'Bravo');
  assert.equal(rowsFor(env, MEMBER)[0].group, 'Bravo');
});

test('profile save: a slow save is logged as a warning for the Executions page', () => {
  const env = setup({ groups: ['Alpha'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  const t = env.nowMs;
  let moved = false;
  env.flushThrows = () => { if (!moved) { moved = true; env.setNow(t + 6000); } return false; };
  assert.equal(env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL').code, 'PROFILE_SAVED');
  env.flushThrows = null;
  assert.ok(env.logs.some((l) => l.level === 'warn' && /saveProfile took 6\d{3} ms/.test(l.text)));
});

test('profile save: a failed copy onto today\'s Log row is tried once more', () => {
  const env = setup({ groups: ['Alpha'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  const from = env.events.length;
  let thrown = false; // only the first flush after the Log row is written fails
  env.flushThrows = () => !thrown && env.events.slice(from).some((e) => e.type === 'write' && e.sheet === 'Log') && (thrown = true);
  assert.equal(env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL').code, 'PROFILE_SAVED');
  env.flushThrows = null;
  assert.equal(env.records('Log')[0].full_name, 'Cy Tan');
  assert.ok(!env.logs.some((l) => /could not copy/.test(l.text)), 'the second try worked');
});

test('profile save: a setup problem is flagged as one, so the app can show its message', () => {
  const env = setup({ groups: ['Alpha'] });
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.sheet('Members').getRange(1, 2).setValue('name'); // the owner renamed a column
  env.cache.clear();
  const r = env.saveProfile(MEMBER, 'Cy Tan', 'Alpha', 'CPL');
  assert.equal(r.code, 'SERVER_ERROR');
  assert.match(r.message, /Members/);
  assert.equal(r.data && r.data.setup, true);
});
