/**
 * Check-in settings an admin can change in the Mini App: how long a check-in stays open, how close
 * members must be, and how precise their location must be. They are the Config tab's
 * SESSION_MINUTES, RADIUS_M and MAX_ACCURACY_M, so the owner can still edit them there too.
 * The distance and accuracy apply at once, including to a check-in that is open; the time applies
 * to the next check-in started.
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

  // All three or nothing: the app always sends the whole form.
  const values = {};
  const errors = {};
  Object.keys(SETTINGS_).forEach((name) => {
    const s = SETTINGS_[name];
    const v = body[name];
    if (Number.isInteger(v) && v >= s.min && v <= s.max) values[s.key] = v;
    else errors[name] = 'Enter a whole number from ' + s.min + ' to ' + s.max + '.';
  });
  if (Object.keys(errors).length) {
    return reply_(false, 'INVALID_SETTINGS', 'Some settings are out of range.', { errors: errors });
  }

  // Under the script lock, so two admins saving at once can't both add a missing Config row.
  const saved = withScriptLock_(() => {
    setConfigValues_(values);
    return true;
  });
  if (!saved) return reply_(false, 'BUSY', MESSAGES_.BUSY);
  console.info('Check-in settings changed by user ' + ctx.user.id + ': ' + JSON.stringify(values));
  return reply_(true, 'SETTINGS_SAVED', 'Saved.', settingsView_(loadConfig_(true)));
}

function settingsView_(cfg) {
  return { sessionMinutes: cfg.sessionMinutes, radiusM: cfg.radiusM, maxAccuracyM: cfg.maxAccuracyM };
}
