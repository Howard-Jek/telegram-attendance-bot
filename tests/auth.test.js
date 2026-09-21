'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { createEnv } = require('./gas-emulator');
const signer = require('../tools/sign-initdata');

test('selfTest() passes in the emulator', () => {
  const env = createEnv();
  const n = env.call('selfTest');
  assert.ok(n >= 20, `expected at least 20 checks, got ${n}`);
  const failed = env.logs.filter((l) => l.text.startsWith('FAIL'));
  assert.deepEqual(failed, []);
});

test('selfTest() passes with .gs files loaded in reverse order (no top-level cross-file references)', () => {
  const env = createEnv({ reverseFileOrder: true });
  assert.ok(env.call('selfTest') >= 20);
});

test('SELFTEST_FIXTURE_ in Setup.gs matches `node tools/sign-initdata.js --fixture`', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'sign-initdata.js'), '--fixture'], { encoding: 'utf8' });
  const env = createEnv();
  const embedded = JSON.parse(env.eval('JSON.stringify(SELFTEST_FIXTURE_)'));
  assert.deepEqual(embedded, JSON.parse(out));
});

test('emulator is strict about signed Byte[] (so the byte handling is really exercised)', () => {
  const env = createEnv();
  assert.throws(() => env.context.Utilities.computeHmacSha256Signature([200], [1]), /Cannot convert 200 to byte/);
  assert.throws(() => env.context.Utilities.computeHmacSha256Signature('a', [1]), /Cannot find method/);
});

test('verifyInitData_ agrees with Node crypto for many random users', () => {
  const env = createEnv();
  const alphabet = ['a', 'Z', ' ', '李', '🙂', 'é', '&', '=', '+', '%', '"', '\\', '/', '\n', 'ß', 'ا'];
  let seed = 42;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const word = () => Array.from({ length: 1 + rand(12) }, () => alphabet[rand(alphabet.length)]).join('');
  for (let i = 0; i < 200; i++) {
    const user = { id: 1 + rand(2 ** 31), first_name: word(), last_name: word(), username: `u${i}` };
    const authDate = 1790000000 + i;
    const token = `${1000 + i}:tok_${word().replace(/[^\w]/g, 'x')}`;
    const fields = signer.buildFields({ ...signer.DEFAULTS, user, authDate });
    const initData = signer.encode(signer.sign(fields, token), { plusForSpace: i % 2 === 0 });
    const res = env.call('verifyInitData_', initData, token, 15, authDate * 1000);
    assert.equal(res.ok, true, `user ${i} rejected: ${JSON.stringify(user)}`);
    assert.equal(res.user.id, String(user.id));
    assert.equal(res.user.firstName, user.first_name);
    assert.equal(res.user.lastName, user.last_name);

    // Changing any signed value must fail.
    const tampered = signer.encode({ ...signer.sign(fields, token), chat_type: 'private' });
    assert.equal(env.call('verifyInitData_', tampered, token, 15, authDate * 1000).code, 'AUTH_FAILED');
  }
});

test('extra unsigned field or reordered fields', () => {
  const env = createEnv();
  const F = signer.fixture();
  const now = F.authDate * 1000;
  // Fields in a different order still verify (sorted before hashing).
  const reordered = F.valid.split('&').reverse().join('&');
  assert.equal(env.call('verifyInitData_', reordered, F.token, 15, now).ok, true);
  // An added field changes the check string and must fail.
  assert.equal(env.call('verifyInitData_', F.valid + '&is_admin=true', F.token, 15, now).code, 'AUTH_FAILED');
  // __proto__ must not be silently dropped.
  assert.equal(env.call('verifyInitData_', F.valid + '&__proto__=x', F.token, 15, now).code, 'AUTH_FAILED');
  // Missing user field, even with a valid hash for the rest -> AUTH_FAILED.
  const noUser = { ...signer.buildFields(signer.DEFAULTS) };
  delete noUser.user;
  assert.equal(env.call('verifyInitData_', signer.encode(signer.sign(noUser, F.token)), F.token, 15, now).code, 'AUTH_FAILED');
});

test('sign-initdata.js signs with $BOT_TOKEN when set (for smoke-testing a real deployment)', () => {
  const token = '424242:real-looking-token';
  const script = path.join(__dirname, '..', 'tools', 'sign-initdata.js');
  const out = execFileSync(process.execPath, [script, '--auth-date', '1790000000', '--user-id', '5'], {
    encoding: 'utf8', env: { ...process.env, BOT_TOKEN: token },
  }).trim();
  const env = createEnv();
  const res = env.call('verifyInitData_', out, token, 15, 1790000000 * 1000);
  assert.equal(res.ok, true);
  assert.equal(res.user.id, '5');
  // --fixture never uses the environment's token.
  const fixture = JSON.parse(execFileSync(process.execPath, [script, '--fixture'], {
    encoding: 'utf8', env: { ...process.env, BOT_TOKEN: token },
  }));
  assert.equal(fixture.token, signer.DEFAULTS.token);
});
