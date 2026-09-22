/**
 * Check-in validation and writes. Steps follow the handoff's order exactly; the distance is
 * measured from the session's own check-in point (where the admin started it).
 * Rejected rows are written only for NOT_MEMBER, UNSUPPORTED_PLATFORM, LOW_ACCURACY
 * and OUT_OF_RANGE, and only while a session is open (no-session attempts are never logged).
 * NOT_MEMBER and UNSUPPORTED_PLATFORM rows carry no location: nobody outside the group, or on a
 * desktop, needs their whereabouts recorded.
 */

const EARTH_RADIUS_M_ = 6371008.8; // mean Earth radius
const DISTANCE_HINTS_PER_SESSION_ = 10;

function handleCheckin_(ctx, body) {
  const cfg = ctx.cfg;
  const user = ctx.user;
  assertConfig_(cfg, ['GROUP_CHAT_ID', 'RADIUS_M', 'MAX_ACCURACY_M']);
  const loc = parseLocation_(body.location);

  // 2. Client-reported platform: a UX guard, not a security control.
  if (body.platform !== 'android' && body.platform !== 'ios') {
    logRejectedIfSessionOpen_(user, 'UNSUPPORTED_PLATFORM');
    return reply_(false, 'UNSUPPORTED_PLATFORM', MESSAGES_.UNSUPPORTED_PLATFORM);
  }

  // 3. Group membership: a network call, so it happens before taking the lock.
  const role = cachedGroupRole_(ctx.token, cfg, user.id);
  const isAdmin = role === 'ADMIN' || cfg.adminIds.indexOf(user.id) !== -1;
  if (role === 'BUSY') return reply_(false, 'BUSY', MESSAGES_.BUSY);
  if (role !== 'MEMBER' && role !== 'ADMIN') {
    logRejectedIfSessionOpen_(user, 'NOT_MEMBER');
    return reply_(false, 'NOT_MEMBER', MESSAGES_.NOT_MEMBER);
  }

  // Their saved name and group go on the Log row. Read before the lock; it changes rarely.
  const profile = profileData_(user.id);

  // 4. Everything that reads-then-writes happens under the script lock.
  const result = withScriptLock_(() => {
    const now = now_();

    // 5. Active session by server time, read from the Sheet (and the copy refreshed while we hold the lock).
    const sessions = readSessions_();
    cacheSessions_(sessions, now.getTime());
    const session = findActiveSession_(sessions, now.getTime());
    if (!session) return reply_(false, 'NO_ACTIVE_SESSION', MESSAGES_.NO_ACTIVE_SESSION);

    // 6. One accepted check-in per person per session. Duplicates write nothing. The copy of who
    // has checked in may answer a repeat, but only the Log may say "not yet": it decides every write.
    const key = dedupeKey_(session.id, user.id);
    let prior = knownCheckin_(session, user.id);
    if (!prior) {
      prior = findCheckin_(key); // also checks the Log's header before step 9 writes by position
      if (prior) rememberCheckin_(session, user.id, prior.at, now);
    }
    if (prior) {
      return reply_(true, 'ALREADY_CHECKED_IN', 'You already checked in at ' + hhmm_(prior.at) + '.',
        Object.assign(checkinView_(session, prior.at), profile));
    }

    if (!loc) return reply_(false, 'BAD_REQUEST', 'Could not read your location. Please try again.');
    if (!session.site) {
      return reply_(false, 'NO_SITE', 'This check-in has no check-in point yet. An admin needs to open check-in and tap “Move check-in point here”.');
    }

    // 7. GPS accuracy (a missing or invalid accuracy counts as too low).
    if (!(loc.accuracy <= cfg.maxAccuracyM)) {
      appendRejected_(now, session.id, user, 'LOW_ACCURACY', loc, null);
      const got = isFinite(loc.accuracy) ? ' (±' + Math.round(loc.accuracy) + ' m)' : '';
      return reply_(false, 'LOW_ACCURACY',
        'Your location is not precise enough' + got + '. Move outdoors or near a window and try again.',
        { accuracyM: isFinite(loc.accuracy) ? round1_(loc.accuracy) : null, maxAccuracyM: cfg.maxAccuracyM });
    }

    // 8. Distance to the session's check-in point.
    const distance = haversineM_(loc.lat, loc.lng, session.site.lat, session.site.lng);
    if (distance > cfg.radiusM) {
      appendRejected_(now, session.id, user, 'OUT_OF_RANGE', loc, distance);
      return outOfRange_(session, user, distance, cfg, isAdmin, now);
    }

    // 9. Accept.
    const p = profile.profile;
    sheet_(SHEETS_.LOG).appendRow([now, session.id, Number(user.id), textCell_(user.firstName),
      textCell_(user.lastName), textCell_(user.username), loc.lat, loc.lng, round1_(loc.accuracy),
      round1_(distance), key, textCell_(p ? p.fullName : ''), groupCell_(p ? p.group : '')]);
    sheet_(SHEETS_.SESSIONS).getRange(session.row, SESSION_COL_.COUNT).setValue(session.count + 1);
    SpreadsheetApp.flush(); // the copy may only say "checked in" once the row is really there
    rememberCheckin_(session, user.id, now, now);
    return reply_(true, 'CHECKED_IN', 'Checked in at ' + hhmm_(now) + '.',
      Object.assign(checkinView_(session, now), profile));
  });

  return result || reply_(false, 'BUSY', MESSAGES_.BUSY);
}

/**
 * Members learn roughly how far away they are, never exactly: exact answers to a few made-up
 * locations would pinpoint the check-in point, which is where an admin stood (maybe at home).
 * After DISTANCE_HINTS_PER_SESSION_ answers they only hear "not within". Admins get the exact
 * figure, to decide whether to move the point. The Rejected tab always keeps it exactly.
 */
function outOfRange_(session, user, distance, cfg, isAdmin, now) {
  const within = ' Check-in works within ' + cfg.radiusM + ' m.';
  if (isAdmin) {
    return reply_(false, 'OUT_OF_RANGE', 'You are ' + Math.round(distance) + ' m from the check-in point.' + within,
      { distanceM: round1_(distance), radiusM: cfg.radiusM });
  }
  const cache = CacheService.getScriptCache();
  const key = 'distance-hints:' + session.id + ':' + user.id;
  const used = Number(cache.get(key)) || 0;
  if (used >= DISTANCE_HINTS_PER_SESSION_) {
    return reply_(false, 'OUT_OF_RANGE', 'You are not within ' + cfg.radiusM + ' m of the venue.',
      { distanceM: null, radiusM: cfg.radiusM });
  }
  cache.put(key, String(used + 1), secondsUntilClose_(session, now));
  if (distance > 1000) {
    return reply_(false, 'OUT_OF_RANGE', 'You are more than 1 km from the venue.' + within,
      { distanceM: null, beyondM: 1000, radiusM: cfg.radiusM });
  }
  const rounded = Math.ceil(distance / 50) * 50;
  return reply_(false, 'OUT_OF_RANGE', 'You are about ' + rounded + ' m from the venue.' + within,
    { distanceM: rounded, rounded: true, radiusM: cfg.radiusM });
}

/** A CacheService lifetime that lasts until the session closes (within the 6-hour maximum). */
function secondsUntilClose_(session, now) {
  return Math.min(21600, Math.max(1, Math.ceil((session.closesAt.getTime() - now.getTime()) / 1000)));
}

function dedupeKey_(sessionId, userId) {
  return sessionId + ':' + userId;
}

/** Looks up an accepted check-in by dedupe_key. Returns {at: Date, row} or null. */
function findCheckin_(key) {
  const sheet = sheet_(SHEETS_.LOG);
  assertHeaders_(SHEETS_.LOG, sheet.getRange(1, 1, 1, HEADERS_.Log.length).getValues()[0]);
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const cell = sheet.getRange(2, LOG_COL_.DEDUPE_KEY, last - 1, 1)
    .createTextFinder(key).matchEntireCell(true).matchCase(true).findNext();
  if (!cell) return null;
  return { at: toDate_(sheet.getRange(cell.getRow(), LOG_COL_.TIMESTAMP).getValue()), row: cell.getRow() };
}

/** Returns {lat, lng, accuracy} with accuracy NaN when missing/invalid, or null if lat/lng are unusable. */
function parseLocation_(loc) {
  if (!loc || typeof loc !== 'object') return null;
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  if (!isNum(loc.lat) || !isNum(loc.lng) || Math.abs(loc.lat) > 90 || Math.abs(loc.lng) > 180) return null;
  return { lat: loc.lat, lng: loc.lng, accuracy: isNum(loc.accuracy) && loc.accuracy >= 0 ? loc.accuracy : NaN };
}

function haversineM_(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * EARTH_RADIUS_M_ * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** loc and distance may be null (not measured, or deliberately not recorded). */
function appendRejected_(now, sessionId, user, reason, loc, distance) {
  sheet_(SHEETS_.REJECTED).appendRow([now, sessionId, Number(user.id), textCell_(user.name),
    textCell_(user.username), reason,
    loc ? loc.lat : '', loc ? loc.lng : '', loc && isFinite(loc.accuracy) ? round1_(loc.accuracy) : '',
    distance === null ? '' : round1_(distance)]);
}

/**
 * For rejections decided before the session lookup (steps 2–3): log only if a session is
 * open, and only once per person, session and reason. Anyone who can open the Mini App can
 * reach these branches, so repeats must not be able to flood the sheet.
 */
function logRejectedIfSessionOpen_(user, reason) {
  const now = now_();
  const session = findActiveSession_(readSessions_(), now.getTime());
  if (!session) return;
  const cache = CacheService.getScriptCache();
  const key = 'rejected:' + session.id + ':' + user.id + ':' + reason;
  if (cache.get(key)) return;
  cache.put(key, '1', secondsUntilClose_(session, now));
  appendRejected_(now, session.id, user, reason, null, null);
}

function checkinView_(session, at) {
  return {
    sessionId: session.id,
    at: at.toISOString(),
    atText: hhmm_(at),
    closesAt: session.closesAt.toISOString(),
    closesAtText: hhmm_(session.closesAt),
  };
}
