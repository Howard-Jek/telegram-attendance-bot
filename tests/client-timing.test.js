'use strict';
/**
 * The Mini App's timing limits for saving rank, name and group, read from web/index.html. After the
 * live run of 2026-10-19 ("the loading button is stuck loading") the save's spinner has a hard cap,
 * and a save is copied only once its first copy should have answered.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const block = /var TIMING = (\{[\s\S]*?\});/.exec(html)[1];
const TIMING = vm.runInNewContext('(' + block + ')', Object.create(null)); // numbers and comments only; no globals
const config = fs.readFileSync(path.join(root, 'apps-script/Config.gs'), 'utf8');
const PROFILE_LOCK_WAIT_MS = Number(/const PROFILE_LOCK_WAIT_MS_ = (\d+);/.exec(config)[1]);

test('timing: the rank, name and group spinner is capped at 30 s', () => {
  assert.ok(TIMING.profileDeadline <= 30000, 'deadline ' + TIMING.profileDeadline);
  assert.ok(TIMING.profileBudget < TIMING.profileDeadline, 'retries stop before the deadline');
  assert.ok(TIMING.slowHint < TIMING.profileDeadline, 'it says why before then');
});

test('timing: a save is copied only after its first copy should have answered, and every copy can still be answered', () => {
  assert.ok(TIMING.profileHedges.length >= 1);
  TIMING.profileHedges.forEach((at) => {
    // The server waits up to PROFILE_LOCK_WAIT_MS for the lock; start-up and the reply take a few seconds more.
    assert.ok(at >= PROFILE_LOCK_WAIT_MS + 8000, 'a copy at ' + at + ' ms comes before the first could answer');
    // ...and a copy needs that long again (about 4.5 s for a frame reply) inside one attempt.
    assert.ok(at + PROFILE_LOCK_WAIT_MS + 4500 <= TIMING.request, 'a copy at ' + at + ' ms can\'t be answered in time');
  });
});

test('timing: the test harness overrides every timing key', () => {
  const harness = fs.readFileSync(path.join(root, 'tests/mini-app/harness.html'), 'utf8');
  const override = /html\.replace\(timing, '([\s\S]*?)\);/.exec(harness)[1];
  Object.keys(TIMING).forEach((k) => assert.ok(new RegExp('\\b' + k + ':').test(override), 'harness sets ' + k));
});
