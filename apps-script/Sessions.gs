/**
 * Sessions: status, starting a session at the admin's location, moving that location, and
 * active-session lookup. Enforcement is always closes_at vs. server time; the `status` column
 * only records whether the close job has announced the result.
 */

function handleStatus_(ctx) {
  const admin = checkAdmin_(ctx);
  if (admin === 'BUSY') return reply_(false, 'BUSY', MESSAGES_.BUSY);
  // Served from the copies in Cache.gs when possible: this is the first call on every open.
  const session = findActiveSession_(sessionsForRead_(), now_().getTime());
  let mine = session ? knownCheckin_(session, ctx.user.id) : null;
  if (mine === undefined) mine = findCheckin_(dedupeKey_(session.id, ctx.user.id));
  const view = session ? sessionView_(session) : null;
  if (view && !admin) delete view.startedByName; // anyone with the link can call status
  if (view && admin) view.startedByMe = isStarter_(session, ctx.user); // only they may change it
  const data = {
    isAdmin: admin,
    sessionMinutes: ctx.cfg.sessionMinutes,
    radiusM: ctx.cfg.radiusM,
    maxAccuracyM: ctx.cfg.maxAccuracyM,
    activeSession: view,
    myCheckin: mine ? { at: mine.at.toISOString(), atText: hhmm_(mine.at) } : null,
  };
  // Only a checked-in member sees their group and name straight away; others get them with the check-in.
  if (mine) Object.assign(data, profileData_(ctx.user.id));
  return reply_(true, 'OK', '', data);
}

function handleStartSession_(ctx, body) {
  const cfg = ctx.cfg;
  const user = ctx.user;
  assertConfig_(cfg, ['GROUP_CHAT_ID', 'ADMIN_IDS']);
  const admin = checkAdmin_(ctx);
  if (admin === 'BUSY') return reply_(false, 'BUSY', MESSAGES_.BUSY);
  if (!admin) return reply_(false, 'NOT_ADMIN', MESSAGES_.NOT_ADMIN);
  assertConfig_(cfg, ['SESSION_MINUTES', 'MAX_ACCURACY_M']);
  const site = parseSite_(body.location, cfg);
  if (!site.ok) return site.reply;

  const result = withScriptLock_(() => {
    const now = now_();
    // Any session still running blocks every admin, including the one who started it.
    const sessions = readSessions_();
    const blocking = findBlockingSession_(sessions, now.getTime());
    if (blocking) {
      cacheSessions_(sessions, now.getTime());
      return { blocking: blocking };
    }

    const session = {
      id: 'S-' + Utilities.formatDate(now, TZ_, 'yyyyMMdd-HHmm'),
      startedById: user.id,
      startedByName: user.name,
      opensAt: now,
      closesAt: new Date(now.getTime() + cfg.sessionMinutes * 60 * 1000),
    };
    // The point first: if it can't be saved, no session is opened without one (a point left
    // behind by a failed row is removed by the close job).
    saveSite_(session.id, site);
    const sheet = sheet_(SHEETS_.SESSIONS);
    sheet.appendRow([session.id, Number(user.id), textCell_(user.name), session.opensAt, session.closesAt,
      '', 'open', 0, round1_(site.accuracy)]);
    session.row = sheet.getLastRow();
    session.status = 'open';
    session.count = 0;
    cacheSessions_(sessions.concat([session]), now.getTime());
    startCheckinsCopy_(session, now);
    // Its tab, made now (under the lock, so the close job can't make a second one) and before the
    // group is told, so nobody is queueing behind it yet. A failure must not stop the check-in.
    try {
      writeSessionTab_(ensureSessionTab_(session), session, [], readGroups_(), false);
      SpreadsheetApp.flush(); // Sheets applies writes later; any error surfaces here, inside the try
    } catch (err) {
      console.warn('Could not make the session tab for ' + session.id + ' (the close job will try again): ' +
        redactSecrets_(String(err && err.message)));
    }
    return { session: session };
  });

  if (!result) return reply_(false, 'BUSY', MESSAGES_.BUSY);
  if (result.blocking) {
    const b = result.blocking;
    const view = sessionView_(b);
    // The Mini App may send a request twice when replies are slow; its own earlier start comes back here.
    view.startedByMe = b.startedById === user.id;
    return reply_(false, 'SESSION_ACTIVE',
      'A check-in is already open until ' + hhmm_(b.closesAt) + ', started by ' + b.startedByName + '.', view);
  }

  // Announce in the group outside the lock: it is a network call, and a failure must not undo the session.
  const s = result.session;
  const data = sessionView_(s);
  data.startedByMe = true;
  // The rules it runs with, which another admin may have changed since this admin's app loaded.
  data.radiusM = cfg.radiusM;
  data.maxAccuracyM = cfg.maxAccuracyM;
  const posted = announceSession_(ctx, s);
  if (!posted.ok) {
    const canShare = CONFIG_CHECKS_.MINI_APP_LINK(cfg);
    data.warning = 'The group wasn’t told (' + posted.description + ').' + (canShare ? ' Share the check-in link instead.' : '');
    if (canShare) data.shareLink = cfg.miniAppLink;
  }
  return reply_(true, 'SESSION_STARTED', 'Check-in is open until ' + hhmm_(s.closesAt) + '.', data);
}

/** Moves the open check-in's centre to where the admin is standing now (e.g. it was started elsewhere). */
function handleMoveSite_(ctx, body) {
  const cfg = ctx.cfg;
  assertConfig_(cfg, ['GROUP_CHAT_ID', 'ADMIN_IDS']);
  const admin = checkAdmin_(ctx);
  if (admin === 'BUSY') return reply_(false, 'BUSY', MESSAGES_.BUSY);
  if (!admin) return reply_(false, 'NOT_ADMIN', MESSAGES_.NOT_ADMIN);
  assertConfig_(cfg, ['MAX_ACCURACY_M']);
  const site = parseSite_(body.location, cfg);
  if (!site.ok) return site.reply;

  const result = withScriptLock_(() => {
    const nowMs = now_().getTime();
    const sessions = readSessions_();
    const session = findActiveSession_(sessions, nowMs);
    if (!session) return reply_(false, 'NO_ACTIVE_SESSION', MESSAGES_.NO_ACTIVE_SESSION);
    if (!isStarter_(session, ctx.user)) return notStarter_('NOT_STARTER', session, 'move its check-in point');
    saveSite_(session.id, site);
    sheet_(SHEETS_.SESSIONS).getRange(session.row, SESSION_COL_.SITE_ACCURACY).setValue(round1_(site.accuracy));
    cacheSessions_(sessions, nowMs);
    console.info('Session ' + session.id + ' check-in point moved by user ' + ctx.user.id);
    return reply_(true, 'SITE_MOVED', 'The check-in point is now where you are.', Object.assign(sessionView_(session), { startedByMe: true }));
  });
  return result || reply_(false, 'BUSY', MESSAGES_.BUSY);
}

// ---------- the check-in point, kept out of the Sheet ----------

// Script Property per open session: SITE:<session id> -> {"lat": ..., "lng": ...}. Only the
// script (its owner) can read Script Properties; the close job deletes a point once its session
// can no longer take check-ins, so no record of where anyone stood is kept.
const SITE_PROP_PREFIX_ = 'SITE:';

/** Call with the script lock held. */
function saveSite_(sessionId, site) {
  PropertiesService.getScriptProperties().setProperty(SITE_PROP_PREFIX_ + sessionId,
    JSON.stringify({ lat: site.lat, lng: site.lng }));
}

/** {lat, lng}, or null if the session has no check-in point (or it can't be read). */
function readSite_(sessionId) {
  try {
    const v = JSON.parse(PropertiesService.getScriptProperties().getProperty(SITE_PROP_PREFIX_ + sessionId) || 'null');
    const ok = (x, max) => typeof x === 'number' && isFinite(x) && Math.abs(x) <= max;
    return v && ok(v.lat, 90) && ok(v.lng, 180) ? { lat: v.lat, lng: v.lng } : null;
  } catch (e) {
    return null;
  }
}

/** Call with the script lock held: deletes the points of sessions that can't take check-ins any more. */
function pruneSites_(sessions, nowMs) {
  const keep = {};
  sessions.forEach((s) => { if (s.closesAt.getTime() > nowMs) keep[SITE_PROP_PREFIX_ + s.id] = true; });
  const props = PropertiesService.getScriptProperties();
  props.getKeys().forEach((k) => {
    if (k.indexOf(SITE_PROP_PREFIX_) === 0 && !keep[k]) props.deleteProperty(k);
  });
}

/**
 * A check-in belongs to the admin who started it: while it is open, only they may move its point or
 * change the settings it runs under (other admins could otherwise undo their choices mid-session).
 * The owner can still edit the Sheet.
 */
function isStarter_(session, user) {
  return String(session.startedById) === String(user.id);
}

function notStarter_(code, session, what) {
  return reply_(false, code, session.startedByName + ' started this check-in, so only they can ' + what +
    ' until it closes at ' + hhmm_(session.closesAt) + '.',
  { startedByName: session.startedByName, closesAtText: hhmm_(session.closesAt) });
}

/**
 * The admin's own GPS fix becomes the session's centre, so it must be at least as precise as a
 * member's check-in has to be. Returns {ok, lat, lng, accuracy} or {ok: false, reply}.
 */
function parseSite_(location, cfg) {
  const loc = parseLocation_(location);
  if (!loc) {
    return { ok: false, reply: reply_(false, 'BAD_REQUEST', 'Could not read your location. Please try again.') };
  }
  if (!(loc.accuracy <= cfg.maxAccuracyM)) {
    const got = isFinite(loc.accuracy) ? ' (±' + Math.round(loc.accuracy) + ' m)' : '';
    return { ok: false, reply: reply_(false, 'LOW_ACCURACY',
      'Your location is not precise enough' + got + ' to set the check-in point. Move outdoors or near a window and try again.',
      { accuracyM: isFinite(loc.accuracy) ? round1_(loc.accuracy) : null, maxAccuracyM: cfg.maxAccuracyM }) };
  }
  return { ok: true, lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy };
}

/** Posts "Check-in is open" with the button, and records its message id on the session row. */
function announceSession_(ctx, session) {
  let posted;
  try {
    posted = postLiveMessage_(ctx, openText_(session), session.id);
  } catch (err) {
    console.error('announce: ' + redactSecrets_(String(err && err.stack ? err.stack : err)));
    return { ok: false, description: 'Telegram could not be reached' };
  }
  if (posted.ok) {
    sheet_(SHEETS_.SESSIONS).getRange(session.row, SESSION_COL_.MESSAGE_ID).setValue(posted.messageId);
  }
  return posted;
}

function openText_(session) {
  return '📍 Check-in is open until ' + hhmm_(session.closesAt) + '.\nTap the button when you arrive.';
}

/**
 * Reads every session. Fails closed (SetupError_) if the header row or a session's dates
 * were edited into something unreadable, because misreading them could let a second
 * session start.
 */
function readSessions_() {
  const sheet = sheet_(SHEETS_.SESSIONS);
  const values = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), HEADERS_.Sessions.length).getValues();
  assertHeaders_(SHEETS_.SESSIONS, values[0]);
  const sessions = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const id = String(r[SESSION_COL_.ID - 1]).trim();
    if (!id) continue;
    const opensAt = r[SESSION_COL_.OPENS_AT - 1];
    const closesAt = r[SESSION_COL_.CLOSES_AT - 1];
    if (!isDate_(opensAt) || !isDate_(closesAt) || isNaN(opensAt.getTime()) || isNaN(closesAt.getTime())) {
      throw new SetupError_('Sessions row ' + (i + 1) + ': opens_at and closes_at must be date-times.');
    }
    sessions.push({
      row: i + 1,
      id: id,
      startedById: String(r[SESSION_COL_.STARTED_BY_ID - 1]),
      startedByName: String(r[SESSION_COL_.STARTED_BY_NAME - 1]),
      opensAt: opensAt,
      closesAt: closesAt,
      status: String(r[SESSION_COL_.STATUS - 1]).trim(),
      count: Number(r[SESSION_COL_.COUNT - 1]) || 0,
    });
  }
  return sessions;
}

/** The session with opens_at <= now < closes_at (latest if, somehow, several). */
function findActiveSession_(sessions, nowMs) {
  return latest_(sessions.filter((s) => s.opensAt.getTime() <= nowMs && nowMs < s.closesAt.getTime()));
}

/** Any session with closes_at > now blocks starting a new one. */
function findBlockingSession_(sessions, nowMs) {
  return latest_(sessions.filter((s) => s.closesAt.getTime() > nowMs));
}

function latest_(sessions) {
  let best = null;
  sessions.forEach((s) => {
    if (!best || s.closesAt.getTime() > best.closesAt.getTime()) best = s;
  });
  return best;
}

function sessionView_(s) {
  return {
    sessionId: s.id,
    opensAt: s.opensAt.toISOString(),
    closesAt: s.closesAt.toISOString(),
    closesAtText: hhmm_(s.closesAt),
    startedByName: s.startedByName,
  };
}
