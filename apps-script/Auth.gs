/**
 * Telegram Mini App initData verification.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 *   data_check_string = every field except `hash` (so `signature` IS included),
 *                       sorted by key, "key=value", joined with "\n"
 *   secret_key        = HMAC_SHA256(key = "WebAppData", message = BOT_TOKEN)
 *   hash              = hex(HMAC_SHA256(key = secret_key, message = data_check_string))
 *
 * Identity is taken only from the signed `user` field, never from anything else the client sends.
 */

/**
 * @return {{ok: true, user: Object, authDate: number} | {ok: false, code: string}}
 *   code is AUTH_FAILED or AUTH_EXPIRED.
 */
function verifyInitData_(initData, botToken, maxAgeMin, nowMs) {
  const FAILED = { ok: false, code: 'AUTH_FAILED' };
  if (typeof initData !== 'string' || initData === '' || !botToken) return FAILED;

  let fields;
  try {
    fields = parseQueryString_(initData);
  } catch (e) {
    return FAILED; // malformed percent-encoding
  }
  if (!fields) return FAILED;

  const hash = fields.hash;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) return FAILED;

  const dataCheckString = Object.keys(fields)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => k + '=' + fields[k])
    .join('\n');
  if (!dataCheckString) return FAILED;

  // Byte[] overloads throughout, with explicit UTF-8, so names like "李" or emoji hash correctly.
  // computeHmacSha256Signature(value, key): the value comes first.
  const secretKey = Utilities.computeHmacSha256Signature(utf8Bytes_(botToken), utf8Bytes_('WebAppData'));
  const computed = bytesToHex_(Utilities.computeHmacSha256Signature(utf8Bytes_(dataCheckString), secretKey));
  if (!constantTimeEqual_(computed, hash.toLowerCase())) return FAILED;

  if (!/^\d+$/.test(fields.auth_date || '')) return FAILED;
  const authDate = Number(fields.auth_date);
  if (nowMs - authDate * 1000 > maxAgeMin * 60 * 1000) return { ok: false, code: 'AUTH_EXPIRED' };

  let u;
  try {
    u = JSON.parse(fields.user);
  } catch (e) {
    return FAILED;
  }
  if (!u || typeof u !== 'object' || !Number.isSafeInteger(u.id) || u.id <= 0) return FAILED;

  const user = {
    id: String(u.id),
    firstName: typeof u.first_name === 'string' ? u.first_name : '',
    lastName: typeof u.last_name === 'string' ? u.last_name : '',
    username: typeof u.username === 'string' ? u.username : '',
  };
  user.name = [user.firstName, user.lastName].join(' ').trim() ||
    (user.username ? '@' + user.username : 'user ' + user.id);
  return { ok: true, user: user, authDate: authDate };
}

/**
 * Manual query-string parser (Apps Script has no URLSearchParams), with the same
 * decoding rules: '+' is a space, then percent-decoding. Returns null on a
 * duplicate key. Throws URIError on malformed percent-encoding.
 */
function parseQueryString_(qs) {
  const out = Object.create(null);
  const parts = qs.split('&');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue;
    const eq = parts[i].indexOf('=');
    const key = decodeFormComponent_(eq === -1 ? parts[i] : parts[i].slice(0, eq));
    const value = eq === -1 ? '' : decodeFormComponent_(parts[i].slice(eq + 1));
    if (key in out) return null;
    out[key] = value;
  }
  return out;
}

function decodeFormComponent_(s) {
  return decodeURIComponent(s.replace(/\+/g, ' '));
}

/** UTF-8 bytes as a signed Byte[] (newBlob(String) is documented as UTF-8). */
function utf8Bytes_(s) {
  return Utilities.newBlob(s).getBytes();
}

/** Apps Script bytes are signed, so mask before hex-encoding. */
function bytesToHex_(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += (bytes[i] & 0xff).toString(16).padStart(2, '0');
  return hex;
}

function constantTimeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function botToken_() {
  const token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  if (!token) throw new SetupError_('The bot is not set up yet (BOT_TOKEN missing). Please tell an admin.');
  return token;
}

/**
 * Whether the user may start and move check-ins: an admin of the Telegram group (creator or
 * administrator), or listed in ADMIN_IDS. Returns true, false, or 'BUSY' if Telegram
 * rate-limited the lookup.
 */
function checkAdmin_(ctx) {
  if (ctx.cfg.adminIds.indexOf(ctx.user.id) !== -1) return true;
  if (!CONFIG_CHECKS_.GROUP_CHAT_ID(ctx.cfg)) return false;
  const role = cachedGroupRole_(ctx.token, ctx.cfg, ctx.user.id);
  return role === 'BUSY' ? 'BUSY' : role === 'ADMIN';
}
