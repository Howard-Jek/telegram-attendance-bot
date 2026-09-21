#!/usr/bin/env node
'use strict';
/**
 * Generates validly signed Telegram Mini App initData with a FAKE bot token, so
 * Auth.gs can be tested (selfTest) before any real Telegram testing.
 *
 * Algorithm (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *   data_check_string = every field except `hash`, sorted by key, "key=value", joined by "\n"
 *   secret_key        = HMAC_SHA256(key = "WebAppData", message = bot_token)
 *   hash              = hex(HMAC_SHA256(key = secret_key, message = data_check_string))
 *
 * Usage:
 *   node tools/sign-initdata.js              # print the default sample initData
 *   node tools/sign-initdata.js --fixture    # print the fixture embedded in Setup.gs (SELFTEST_FIXTURE_)
 *   node tools/sign-initdata.js --token 123:ABC --auth-date now --user-id 42 --first-name "Ann" --username ann
 *   BOT_TOKEN=... node tools/sign-initdata.js --auth-date now --user-id 42   # sign for a real deployment
 */
const crypto = require('node:crypto');

const DEFAULTS = {
  token: '1234567890:FAKE-token-for-selfTest-only',
  authDate: 1790000000,
  user: {
    id: 279058397,
    first_name: 'Wei Ling 李',
    last_name: 'Tan 🙂',
    username: 'weiling_t',
    language_code: 'en',
    allows_write_to_pm: true,
    photo_url: 'https://t.me/i/userpic/320/abc.svg',
  },
  chatInstance: '-8123456789012345678',
  chatType: 'supergroup',
  signature: 'fAkEsIgNaTuRe_selfTest-only_not-a-real-ed25519-signature',
};

// Telegram serialises the user object with escaped slashes; the raw string is what gets signed.
function userJson(user) {
  return JSON.stringify(user).replace(/\//g, '\\/');
}

function hmac(key, message) {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest();
}

/** Returns fields plus `hash`. Options exist only to build known-bad fixtures. */
function sign(fields, token, { swapKeyOrder = false, exclude = [] } = {}) {
  const dataCheckString = Object.keys(fields)
    .filter((k) => k !== 'hash' && !exclude.includes(k))
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secretKey = swapKeyOrder ? hmac(token, 'WebAppData') : hmac('WebAppData', token);
  return { ...fields, hash: hmac(secretKey, dataCheckString).toString('hex') };
}

function encode(fields, { plusForSpace = false } = {}) {
  return Object.entries(fields)
    .map(([k, v]) => {
      let enc = encodeURIComponent(v);
      if (plusForSpace) enc = enc.replace(/%20/g, '+');
      return `${encodeURIComponent(k)}=${enc}`;
    })
    .join('&');
}

function buildFields({ user, authDate, chatInstance, chatType, signature }) {
  // Same key order a Telegram client uses; order does not matter for the hash.
  return {
    user: userJson(user),
    chat_instance: chatInstance,
    chat_type: chatType,
    auth_date: String(authDate),
    signature,
  };
}

function fixture() {
  const fields = buildFields(DEFAULTS);
  const t = DEFAULTS.token;
  return {
    token: t,
    authDate: DEFAULTS.authDate,
    userId: DEFAULTS.user.id,
    firstName: DEFAULTS.user.first_name,
    lastName: DEFAULTS.user.last_name,
    valid: encode(sign(fields, t)),
    validPlusForSpace: encode(sign(fields, t), { plusForSpace: true }),
    signedWithSwappedKeyOrder: encode(sign(fields, t, { swapKeyOrder: true })),
    signedWithoutSignatureField: encode(sign(fields, t, { exclude: ['signature'] })),
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    if (key === 'fixture') out.fixture = true;
    else out[key] = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.fixture) {
    process.stdout.write(JSON.stringify(fixture(), null, 2) + '\n');
    return;
  }
  const user = { ...DEFAULTS.user };
  if (args['user-id']) user.id = Number(args['user-id']);
  if (args['first-name']) user.first_name = args['first-name'];
  if (args['last-name'] !== undefined) user.last_name = args['last-name'];
  if (args.username !== undefined) user.username = args.username;
  const authDate =
    args['auth-date'] === 'now' ? Math.floor(Date.now() / 1000) : Number(args['auth-date'] || DEFAULTS.authDate);
  const fields = buildFields({ ...DEFAULTS, user, authDate });
  // Prefer $BOT_TOKEN over --token for a real token, so it stays out of shell history.
  process.stdout.write(encode(sign(fields, args.token || process.env.BOT_TOKEN || DEFAULTS.token)) + '\n');
}

if (require.main === module) main();

module.exports = { DEFAULTS, sign, encode, buildFields, fixture, userJson };
