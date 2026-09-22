/**
 * Short-lived copies of Sheet data in CacheService, so most requests never open the Sheet.
 * Measured on the live deployment: opening the Sheet and reading one tab costs ~0.6 s, and each
 * further read ~0.1-0.2 s, on top of ~0.75 s of Apps Script start-up.
 *
 * What keeps the rules intact:
 *  - Decisions that write are made from the Sheet under the script lock: starting a session
 *    (one at a time), the session a check-in is recorded against, and whether that person is
 *    already in the Log. The copy of who has checked in only ever answers "yes, already".
 *  - Copies are updated after the Sheet write is committed (flushed), never before.
 *  - The copies of the current sessions and of who has checked in are only written while holding
 *    the lock, so a slow reader can never put back an older copy after a writer changed things.
 *  - Edits the owner makes directly in the Sheet show up once a copy is refreshed or expires:
 *    Config and Groups within a minute, a member's saved name and group within 10 minutes, and
 *    sessions at the next close-job run (every 5 minutes). A check-in row deleted by hand still
 *    reads as checked in until that session ends.
 */

const CACHE_SEC_ = { CONFIG: 60, GROUPS: 60, MEMBER: 600, SESSIONS: 600 };
const SESSIONS_CACHE_KEY_ = 'sessions:current';

function cacheGetJson_(key) {
  try {
    const v = CacheService.getScriptCache().get(key);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return null; // unreadable copy: read the Sheet instead
  }
}

/** A failed put (value over 100 KB, quota) removes the key, so nobody reads an older copy. */
function cachePutJson_(key, value, seconds) {
  const cache = CacheService.getScriptCache();
  try {
    cache.put(key, JSON.stringify(value), Math.max(1, Math.min(21600, Math.floor(seconds))));
  } catch (e) {
    try { cache.remove(key); } catch (e2) { /* nothing more to do */ }
  }
}

function cacheRemove_(key) {
  try { CacheService.getScriptCache().remove(key); } catch (e) { /* expires on its own */ }
}

// ---------- Config ----------

/**
 * The Config copy lives under a versioned key. setConfigValue_ moves the version on after
 * writing, so a slow reader that read the Sheet before the write puts its copy under the old key,
 * which nobody reads any more.
 */
function configCacheKey_() {
  const gen = CacheService.getScriptCache().get('config:gen') || '0';
  return 'config:' + gen;
}

function bumpConfigCache_() {
  try {
    CacheService.getScriptCache().put('config:gen', Utilities.getUuid().slice(0, 8), 21600);
  } catch (e) {
    cacheRemove_(configCacheKey_());
  }
}

// ---------- sessions ----------

/**
 * Call with the script lock held, with the sessions as they now are in the Sheet. Keeps only
 * sessions that haven't ended, which is all a status check needs.
 */
function cacheSessions_(sessions, nowMs) {
  const live = sessions.filter((s) => s.closesAt.getTime() > nowMs).map((s) => ({
    row: s.row, id: s.id, startedById: s.startedById, startedByName: s.startedByName,
    opensAt: s.opensAt.getTime(), closesAt: s.closesAt.getTime(), status: s.status, count: s.count, site: s.site,
  }));
  cachePutJson_(SESSIONS_CACHE_KEY_, live, CACHE_SEC_.SESSIONS);
}

/** For reads outside the lock: the lock holder's last copy, else the Sheet (not cached here). */
function sessionsForRead_() {
  const copy = cacheGetJson_(SESSIONS_CACHE_KEY_);
  if (!Array.isArray(copy)) return readSessions_();
  return copy.map((s) => Object.assign({}, s, { opensAt: new Date(s.opensAt), closesAt: new Date(s.closesAt) }));
}

// ---------- who has checked in ----------

function checkinsKey_(sessionId) {
  return 'checkins:' + sessionId;
}

/**
 * Call with the script lock held, right after the session row is written. "complete" means the
 * copy started empty with the session and every check-in since was added under the lock, so an
 * id that isn't in it really hasn't checked in.
 */
function startCheckinsCopy_(session, now) {
  cachePutJson_(checkinsKey_(session.id), { complete: true, at: {} }, secondsUntilClose_(session, now));
}

/** Call with the script lock held, after a check-in row is committed (or found in the Log). */
function rememberCheckin_(session, userId, at, now) {
  const key = checkinsKey_(session.id);
  const copy = cacheGetJson_(key) || { complete: false, at: {} }; // expired early: now only a partial list
  copy.at[userId] = at.getTime();
  cachePutJson_(key, copy, secondsUntilClose_(session, now));
}

/**
 * {at: Date} if the copy says the user checked in, null if a complete copy says they haven't,
 * undefined if the copy can't tell. Only the status screen may act on null; a check-in always
 * confirms "not yet" in the Log before writing.
 */
function knownCheckin_(session, userId) {
  const copy = cacheGetJson_(checkinsKey_(session.id));
  if (!copy || !copy.at || typeof copy.at !== 'object') return undefined;
  if (copy.at[userId]) return { at: new Date(copy.at[userId]) };
  return copy.complete === true ? null : undefined;
}
