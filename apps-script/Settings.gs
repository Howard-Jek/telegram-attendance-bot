/**
 * Check-in settings an admin can change in the Mini App: how long a check-in stays open, how close
 * members must be, and how precise their location must be. They are the Config tab's
 * SESSION_MINUTES, RADIUS_M and MAX_ACCURACY_M, so the owner can still edit them there too.
 * The distance and accuracy apply at once, including to a check-in that is open; the time applies
 * to the next check-in started. While a check-in is open, only the admin who started it may change
 * them (isStarter_ in Sessions.gs).
 */

// Name in the app -> Config key, and the whole numbers accepted from the app.
const SETTINGS_ = {
  sessionMinutes: { key: 'SESSION_MINUTES', min: 1, max: 720 },
  radiusM: { key: 'RADIUS_M', min: 10, max: 5000 },
  maxAccuracyM: { key: 'MAX_ACCURACY_M', min: 10, max: 500 },
};

function handleSaveSettings_(ctx, body) {
  assertConfig_(ctx.cfg, ['GROUP_CHAT_ID', 'ADMIN_IDS']);
  const admin = checkAdmin_(ctx);
  if (admin === 'BUSY') return reply_(false, 'BUSY', MESSAGES_.BUSY);
  if (!admin) return reply_(false, 'NOT_ADMIN', 'Only admins of the group can change check-in settings.');

  // The app sends only what the admin changed, so a screen opened before another admin's save
  // can't undo it. What is sent is checked as a whole: nothing is saved if any value is wrong.
  const values = {};
  const errors = {};
  Object.keys(SETTINGS_).forEach((name) => {
    if (body[name] === undefined) return;
    const s = SETTINGS_[name];
    const v = body[name];
    if (Number.isInteger(v) && v >= s.min && v <= s.max) values[s.key] = v;
    else errors[name] = 'Enter a whole number from ' + s.min + ' to ' + s.max + '.';
  });
  if (Object.keys(errors).length) {
    return reply_(false, 'INVALID_SETTINGS', 'Some settings are out of range.', { errors: errors });
  }
  if (!Object.keys(values).length) return reply_(false, 'INVALID_SETTINGS', 'Nothing to save.', { errors: {} });
  // Each save carries an id, reused by the app's backup copies of it. A copy that arrives after
  // its save was applied (possibly after a newer save) must not write again.
  const saveId = body.saveId;
  if (saveId !== undefined && !(typeof saveId === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(saveId))) {
    return reply_(false, 'INVALID_SETTINGS', 'Invalid request.', { errors: {} });
  }

  // Under the script lock, so two admins saving at once can't both add a missing Config row, and
  // so the check for an open check-in can't be overtaken by another admin starting one.
  const saved = withScriptLock_(() => {
    const cache = CacheService.getScriptCache();
    const seen = saveId ? 'settings-save:' + saveId : null;
    if (seen && cache.get(seen)) return 'repeat';
    const now = now_().getTime();
    const sessions = readSessions_();
    cacheSessions_(sessions, now);
    const open = findBlockingSession_(sessions, now);
    if (open && !isStarter_(open, ctx.user)) return notStarter_('SETTINGS_LOCKED', open, 'change the settings');
    setConfigValues_(values);
    if (seen) cache.put(seen, '1', 3600);
    return 'saved';
  });
  if (!saved) return reply_(false, 'BUSY', MESSAGES_.BUSY);
  if (typeof saved === 'object') return saved; // someone else's check-in is open
  if (saved === 'saved') console.info('Check-in settings changed by user ' + ctx.user.id + ': ' + JSON.stringify(values));
  return reply_(true, 'SETTINGS_SAVED', 'Saved.', settingsView_(loadConfig_(true)));
}

function settingsView_(cfg) {
  return { sessionMinutes: cfg.sessionMinutes, radiusM: cfg.radiusM, maxAccuracyM: cfg.maxAccuracyM };
}
