/**
 * Check-in validation and writes. Steps follow the handoff's order exactly.
 * Rejected rows are written only for NOT_MEMBER, UNSUPPORTED_PLATFORM, LOW_ACCURACY
 * and OUT_OF_RANGE, and only while a session is open (no-session attempts are never logged).
 */

const EARTH_RADIUS_M_ = 6371008.8; // mean Earth radius

function handleCheckin_(ctx, body) {
  const cfg = ctx.cfg;
  const user = ctx.user;
  assertConfig_(cfg, ['SITE_LAT', 'SITE_LNG', 'RADIUS_M', 'MAX_ACCURACY_M', 'GROUP_CHAT_ID']);
  const loc = parseLocation_(body.location);

  // 2. Client-reported platform: a UX guard, not a security control.
  if (body.platform !== 'android' && body.platform !== 'ios') {
    logRejectedIfSessionOpen_(user, 'UNSUPPORTED_PLATFORM', loc, cfg);
    return reply_(false, 'UNSUPPORTED_PLATFORM', MESSAGES_.UNSUPPORTED_PLATFORM);
  }

  // 3. Group membership: a network call, so it happens before taking the lock.
  const membership = groupMembership_(ctx.token, cfg.groupChatId, user.id);
  if (membership === 'BUSY') return reply_(false, 'BUSY', MESSAGES_.BUSY);
  if (membership !== 'MEMBER') {
    logRejectedIfSessionOpen_(user, 'NOT_MEMBER', loc, cfg);
    return reply_(false, 'NOT_MEMBER', MESSAGES_.NOT_MEMBER);
  }

  // 4. Everything that reads-then-writes happens under the script lock.
  const result = withScriptLock_(() => {
    const now = now_();

    // 5. Active session by server time.
    const session = findActiveSession_(readSessions_(), now.getTime());
    if (!session) return reply_(false, 'NO_ACTIVE_SESSION', MESSAGES_.NO_ACTIVE_SESSION);

    // 6. One accepted check-in per person per session. Duplicates write nothing.
    const key = dedupeKey_(session.id, user.id);
    const prior = findCheckin_(key);
    if (prior) {
      return reply_(true, 'ALREADY_CHECKED_IN', 'You already checked in at ' + hhmm_(prior.at) + '.',
        checkinView_(session, prior.at));
    }

    if (!loc) return reply_(false, 'BAD_REQUEST', 'Could not read your location. Please try again.');

    // 7. GPS accuracy (a missing or invalid accuracy counts as too low).
    if (!(loc.accuracy <= cfg.maxAccuracyM)) {
      appendRejected_(now, session.id, user, 'LOW_ACCURACY', loc, null);
      const got = isFinite(loc.accuracy) ? ' (±' + Math.round(loc.accuracy) + ' m)' : '';
      return reply_(false, 'LOW_ACCURACY',
        'Your location is not precise enough' + got + '. Move outdoors or near a window and try again.',
        { accuracyM: isFinite(loc.accuracy) ? round1_(loc.accuracy) : null, maxAccuracyM: cfg.maxAccuracyM });
    }

    // 8. Distance to the site.
    const distance = haversineM_(loc.lat, loc.lng, cfg.siteLat, cfg.siteLng);
    if (distance > cfg.radiusM) {
      appendRejected_(now, session.id, user, 'OUT_OF_RANGE', loc, distance);
      return reply_(false, 'OUT_OF_RANGE',
        'You are ' + Math.round(distance) + ' m from the venue. Check-in works within ' + cfg.radiusM + ' m.',
        { distanceM: round1_(distance), radiusM: cfg.radiusM });
    }

    // 9. Accept.
    sheet_(SHEETS_.LOG).appendRow([now, session.id, Number(user.id), textCell_(user.firstName),
      textCell_(user.lastName), textCell_(user.username), loc.lat, loc.lng, round1_(loc.accuracy),
      round1_(distance), key]);
    sheet_(SHEETS_.SESSIONS).getRange(session.row, SESSION_COL_.COUNT).setValue(session.count + 1);
    return reply_(true, 'CHECKED_IN', 'Checked in at ' + hhmm_(now) + '.', checkinView_(session, now));
  });

  return result || reply_(false, 'BUSY', MESSAGES_.BUSY);
}

function dedupeKey_(sessionId, userId) {
  return sessionId + ':' + userId;
}

/** Looks up an accepted check-in by dedupe_key. Returns {at: Date} or null. */
function findCheckin_(key) {
  const sheet = sheet_(SHEETS_.LOG);
  assertHeaders_(SHEETS_.LOG, sheet.getRange(1, 1, 1, HEADERS_.Log.length).getValues()[0]);
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const cell = sheet.getRange(2, LOG_COL_.DEDUPE_KEY, last - 1, 1)
    .createTextFinder(key).matchEntireCell(true).matchCase(true).findNext();
  if (!cell) return null;
  return { at: toDate_(sheet.getRange(cell.getRow(), LOG_COL_.TIMESTAMP).getValue()) };
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

function appendRejected_(now, sessionId, user, reason, loc, distance) {
  sheet_(SHEETS_.REJECTED).appendRow([now, sessionId, Number(user.id), textCell_(user.name),
    textCell_(user.username), reason,
    loc ? loc.lat : '', loc ? loc.lng : '', loc && isFinite(loc.accuracy) ? round1_(loc.accuracy) : '',
    distance === null ? '' : round1_(distance)]);
}

/** For rejections decided before the session lookup (steps 2–3): log only if a session is open. */
function logRejectedIfSessionOpen_(user, reason, loc, cfg) {
  const now = now_();
  const session = findActiveSession_(readSessions_(), now.getTime());
  if (!session) return;
  const distance = loc ? haversineM_(loc.lat, loc.lng, cfg.siteLat, cfg.siteLng) : null;
  appendRejected_(now, session.id, user, reason, loc, distance);
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
