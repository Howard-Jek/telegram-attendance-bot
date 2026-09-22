/**
 * What the bot posts in the group. There is at most one live "📍 Check in" button message: each
 * new one (a session opening, or someone typing /checkin) replaces the previous one, and when the
 * session ends the close job turns it into the result ("Check-in closed at 11:02 · 23 checked in").
 */

// Script Property: {"chatId": "...", "messageId": 123, "sessionId": "S-..." or "" if none was open}
const LIVE_MESSAGE_PROP_ = 'LIVE_MESSAGE';
const ANNOUNCE_WINDOW_MS_ = 60 * 60 * 1000; // sessions that ended longer ago are closed without a post

/**
 * Posts text with the Check in button, makes it the live message and deletes the previous one.
 * sessionId is the session the text describes ('' if none is open), so the close job only ever
 * turns that session's own button into its result.
 * @return {{ok: true, messageId: number} | {ok: false, description: string}}
 */
function postLiveMessage_(ctx, text, sessionId) {
  const cfg = ctx.cfg;
  if (!CONFIG_CHECKS_.MINI_APP_LINK(cfg)) return { ok: false, description: 'MINI_APP_LINK is not set in Config' };
  const sent = sendText_(ctx.token, cfg.groupChatId, text, checkinKeyboard_(cfg, !!sessionId));
  if (!sent.ok) {
    console.warn('sendMessage to the group failed: ' + sent.error_code + ' ' + sent.description);
    return { ok: false, description: describeSendError_(sent) };
  }
  const mine = { chatId: String(sent.result.chat.id), messageId: sent.result.message_id, sessionId: sessionId || '' };
  // Swap under the lock so two posts at once still leave exactly one button behind.
  const previous = withScriptLock_(() => {
    const old = readLiveMessage_();
    PropertiesService.getScriptProperties().setProperty(LIVE_MESSAGE_PROP_, JSON.stringify(mine));
    return old || false;
  });
  if (previous) deleteMessage_(ctx.token, previous.chatId, previous.messageId);
  return { ok: true, messageId: mine.messageId };
}

function readLiveMessage_() {
  try {
    const v = JSON.parse(PropertiesService.getScriptProperties().getProperty(LIVE_MESSAGE_PROP_) || 'null');
    return v && v.chatId && Number.isSafeInteger(v.messageId) ? v : null;
  } catch (e) {
    return null;
  }
}

/**
 * Takes the live message out of service if it belongs to sessionId (call with the script lock
 * held). A newer session's button, or one posted while nothing was open, is left alone.
 */
function takeLiveMessage_(sessionId) {
  const live = readLiveMessage_();
  if (!live || live.sessionId !== sessionId) return null;
  PropertiesService.getScriptProperties().deleteProperty(LIVE_MESSAGE_PROP_);
  return live;
}

function describeSendError_(res) {
  const d = String(res.description || '');
  if (/not enough rights|have no rights|CHAT_WRITE_FORBIDDEN/i.test(d)) return 'the bot isn’t allowed to post there';
  if (/bot was kicked|not a member|chat not found/i.test(d)) return 'the bot isn’t in the group';
  if (res.error_code === 429) return 'Telegram asked the bot to slow down';
  return 'Telegram said: ' + d.slice(0, 80);
}

/**
 * Time-driven trigger (every 5 minutes, installed by setup()). Keeps checkin_count current for
 * open sessions (check-ins don't write it), marks ended sessions closed with the final count,
 * and turns the live message into the result, broken down by group.
 */
function closeExpiredSessions() {
  openedSpreadsheet_ = null;
  try {
    closeExpiredSessions_();
  } catch (err) {
    console.error('closeExpiredSessions: ' + redactSecrets_(err && err.stack ? err.stack : String(err)));
  }
}

function closeExpiredSessions_() {
  const cfg = loadConfig_();
  const now = now_();
  const done = withScriptLock_(() => {
    const sessions = readSessions_();
    cacheSessions_(sessions, now.getTime()); // every run refreshes the copy, picking up hand edits
    const open = sessions.filter((s) => s.status === 'open');
    if (!open.length) return { closed: [] };
    const tally = tallyLog_(open.map((s) => s.id));
    const due = open.filter((s) => s.closesAt.getTime() <= now.getTime());
    const sheet = sheet_(SHEETS_.SESSIONS);
    open.forEach((s) => {
      s.tally = tally[s.id];
      if (due.indexOf(s) !== -1) {
        sheet.getRange(s.row, SESSION_COL_.STATUS, 1, 2).setValues([['closed', s.tally.count]]);
      } else if (s.count !== s.tally.count) {
        sheet.getRange(s.row, SESSION_COL_.COUNT).setValue(s.tally.count);
      }
    });
    if (!due.length) return { closed: [] };
    // Only a session that just ended is announced; a backlog (e.g. the job was off) closes quietly.
    const recent = latest_(due.filter((s) => now.getTime() - s.closesAt.getTime() < ANNOUNCE_WINDOW_MS_));
    return { closed: due, recent: recent, live: recent ? takeLiveMessage_(recent.id) : null };
  });
  if (!done) return; // lock busy: the next run picks it up
  if (!done.recent || !CONFIG_CHECKS_.GROUP_CHAT_ID(cfg)) return;

  const token = botToken_();
  const text = closedText_(done.recent, readGroups_());
  if (done.live) {
    const edited = editText_(token, done.live.chatId, done.live.messageId, text);
    if (edited.ok) return;
    console.warn('Could not edit the live message (' + edited.description + '); posting the result instead.');
  }
  const sent = sendText_(token, cfg.groupChatId, text);
  if (!sent.ok) console.warn('Could not post the check-in result: ' + sent.error_code + ' ' + sent.description);
}

/** {sessionId: {count, groups: {name: n}}} for the given sessions, counted from the Log. */
function tallyLog_(sessionIds) {
  const tally = {};
  sessionIds.forEach((id) => { tally[id] = { count: 0, groups: {} }; });
  const sheet = sheet_(SHEETS_.LOG);
  const last = sheet.getLastRow();
  if (last < 1) return tally;
  const values = sheet.getRange(1, 1, last, HEADERS_.Log.length).getValues();
  assertHeaders_(SHEETS_.LOG, values[0]);
  for (let i = 1; i < values.length; i++) {
    const t = tally[String(values[i][LOG_COL_.SESSION_ID - 1]).trim()];
    if (!t) continue;
    const group = String(values[i][LOG_COL_.GROUP - 1]).trim();
    t.count++;
    t.groups[group] = (t.groups[group] || 0) + 1;
  }
  return tally;
}

/** "Check-in closed at 11:02 · 23 checked in" plus a line per group, in the Groups tab's order. */
function closedText_(session, groupOrder) {
  const t = session.tally;
  const head = 'Check-in closed at ' + hhmm_(session.closesAt) + ' · ' +
    (t.count ? t.count + ' checked in' : 'nobody checked in');
  const names = Object.keys(t.groups);
  if (!t.count || (names.length === 1 && names[0] === '')) return head;
  const order = groupOrder.filter((g) => t.groups[g])
    .concat(names.filter((g) => g && groupOrder.indexOf(g) === -1).sort());
  const parts = order.map((g) => g + ' ' + t.groups[g]);
  if (t.groups['']) parts.push('No group ' + t.groups['']);
  return head + '\n' + parts.join(' · ');
}
