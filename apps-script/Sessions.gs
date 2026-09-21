/**
 * Sessions: status, starting a session, and active-session lookup.
 * Enforcement is always closes_at vs. server time; the `status` column is cosmetic.
 */

function handleStatus_(ctx) {
  const session = findActiveSession_(readSessions_(), now_().getTime());
  const mine = session ? findCheckin_(dedupeKey_(session.id, ctx.user.id)) : null;
  const isAdmin = isAdmin_(ctx.user, ctx.cfg);
  const view = session ? sessionView_(session) : null;
  if (view && !isAdmin) delete view.startedByName; // anyone with the link can call status
  return reply_(true, 'OK', '', {
    isAdmin: isAdmin,
    sessionMinutes: ctx.cfg.sessionMinutes,
    activeSession: view,
    myCheckin: mine ? { at: mine.at.toISOString(), atText: hhmm_(mine.at) } : null,
  });
}

function handleStartSession_(ctx) {
  const cfg = ctx.cfg;
  const user = ctx.user;
  assertConfig_(cfg, ['ADMIN_IDS']); // a typo here would otherwise look like NOT_ADMIN for everyone
  if (!isAdmin_(user, cfg)) return reply_(false, 'NOT_ADMIN', MESSAGES_.NOT_ADMIN);
  assertConfig_(cfg, ['SESSION_MINUTES']);

  const result = withScriptLock_(() => {
    const now = now_();
    // Any session still running blocks every admin, including the one who started it.
    const blocking = findBlockingSession_(readSessions_(), now.getTime());
    if (blocking) return { blocking: blocking };

    const session = {
      id: 'S-' + Utilities.formatDate(now, TZ_, 'yyyyMMdd-HHmm'),
      startedById: user.id,
      startedByName: user.name,
      opensAt: now,
      closesAt: new Date(now.getTime() + cfg.sessionMinutes * 60 * 1000),
    };
    sheet_(SHEETS_.SESSIONS).appendRow([session.id, Number(user.id), textCell_(user.name),
      session.opensAt, session.closesAt, '', 'open', 0]);
    return { session: session };
  });

  if (!result) return reply_(false, 'BUSY', MESSAGES_.BUSY);
  if (result.blocking) {
    const b = result.blocking;
    return reply_(false, 'SESSION_ACTIVE',
      'A check-in is already open until ' + hhmm_(b.closesAt) + ', started by ' + b.startedByName + '.',
      sessionView_(b));
  }
  // Phase 3: announce in the group here, outside the lock, and store the message_id.
  const s = result.session;
  return reply_(true, 'SESSION_STARTED', 'Check-in is open until ' + hhmm_(s.closesAt) + '.', sessionView_(s));
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
