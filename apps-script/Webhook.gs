/**
 * Telegram's webhook: POST <exec-url>?hook=<WEBHOOK_SECRET> with one update as JSON.
 *
 * Apps Script can't read request headers, so Telegram's secret_token header can't be checked;
 * the secret travels in the URL instead (set by setup(); only Telegram and the owner know it).
 * Every answer is HtmlService output: Apps Script serves that with HTTP 200, whereas
 * ContentService output is served through a 302 redirect, which Telegram counts as a failed
 * delivery and resends. Updates are also de-duplicated by update_id in case of a resend.
 *
 * The bot is an admin, so it receives every message in the group. Only these matter:
 *   - /checkin (group or private chat) and /start (private chat): reply with the Check in button
 *   - the bot being added to a group: connect it if none is connected yet and the owner did it
 *     (someone in ADMIN_IDS, or the one-time connect link from setup()); leave other groups
 *   - the group becoming a supergroup: follow its new id
 *   - someone joining, leaving or changing role: forget their cached role
 */

// Telegram resends an update only after a failed or timed-out delivery, within minutes.
const UPDATE_SEEN_SEC_ = 60 * 60;
const GROUP_BUTTON_MIN_GAP_SEC_ = 20; // Telegram allows a bot about 20 messages a minute in a group
const PRIVATE_REPLY_MIN_GAP_SEC_ = 10;
const NOT_CONNECTED_TEXT_ = 'This check-in bot isn’t connected to a group yet. The owner connects it with the ' +
  'connect link that setup() shows in the Apps Script editor.';
const NOT_READY_TEXT_ = 'Check-in isn’t fully set up yet: the owner needs to put the Mini App link in the Config tab (MINI_APP_LINK).';

function handleWebhook_(e) {
  try {
    const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
    const given = String(e.parameter.hook);
    if (!secret || !constantTimeEqual_(given, secret)) {
      console.warn('Ignored a webhook call with a missing or wrong secret.');
      return webhookReply_();
    }
    let update = null;
    try {
      update = JSON.parse(e.postData ? e.postData.contents : '');
    } catch (err) {
      // ignored below
    }
    if (!update || typeof update !== 'object' || !Number.isSafeInteger(update.update_id)) return webhookReply_();
    handleUpdate_(update);
  } catch (err) {
    // Still answer 200: a resend of an update that fails every time would only fail again.
    console.error('webhook: ' + redactSecrets_(err && err.stack ? err.stack : String(err)));
  }
  return webhookReply_();
}

function webhookReply_() {
  return HtmlService.createHtmlOutput('ok');
}

function handleUpdate_(update) {
  const msg = update.message;
  if (msg) {
    // Nearly every update is an ordinary chat message: drop those before opening the Sheet, and
    // before remembering the update (the script cache holds only 1,000 items; flooding it would
    // push out the role cache and the rate limits).
    const isCommand = typeof msg.text === 'string' && msg.text.charAt(0) === '/';
    if (!isCommand && !msg.migrate_to_chat_id && !msg.migrate_from_chat_id) return;
  } else if (!update.my_chat_member && !update.chat_member) {
    return;
  }
  const cache = CacheService.getScriptCache();
  const seenKey = 'update:' + update.update_id;
  if (cache.get(seenKey)) return;
  cache.put(seenKey, '1', UPDATE_SEEN_SEC_);
  // Group membership changes and upgrades decide GROUP_CHAT_ID, so they read Config fresh.
  const fresh = !!update.my_chat_member || !!(msg && (msg.migrate_to_chat_id || msg.migrate_from_chat_id));
  const ctx = { cfg: loadConfig_(fresh), token: botToken_() };
  if (update.my_chat_member) return onBotMembership_(ctx, update.my_chat_member);
  if (update.chat_member) return onMemberChange_(ctx, update.chat_member);
  if (update.message && update.message.chat) return onMessage_(ctx, update.message);
}

function isGroupChat_(chat) {
  return chat && (chat.type === 'group' || chat.type === 'supergroup');
}

function isInChat_(member) {
  if (!member) return false;
  return member.status === 'creator' || member.status === 'administrator' || member.status === 'member' ||
    (member.status === 'restricted' && member.is_member === true);
}

/** The bot itself was added to, removed from, or promoted in a group. */
function onBotMembership_(ctx, change) {
  if (!isGroupChat_(change.chat)) return;
  const chatId = String(change.chat.id);
  const nowIn = isInChat_(change.new_chat_member);
  const wasIn = isInChat_(change.old_chat_member);
  const isAdminNow = change.new_chat_member && change.new_chat_member.status === 'administrator';
  const wasAdmin = change.old_chat_member && change.old_chat_member.status === 'administrator';

  if (!nowIn) {
    if (chatId === ctx.cfg.groupChatId) console.warn('The bot was removed from the connected group.');
    return;
  }

  if (!ctx.cfg.groupChatId) {
    // Only the owner may connect a group, or anyone who knows the bot's @username could claim it
    // while the setting is blank. Here that means being listed in ADMIN_IDS; the connect link
    // from setup() is the other way (onConnectLink_).
    const by = change.from && Number.isSafeInteger(change.from.id) ? String(change.from.id) : '';
    if (ctx.cfg.adminIds.indexOf(by) === -1) {
      if (!wasIn) sendText_(ctx.token, chatId, NOT_CONNECTED_TEXT_);
      return; // stay: the connect link's /start may be on its way
    }
    if (connectGroup_(ctx, chatId, isAdminNow)) return;
    ctx.cfg = loadConfig_(true);
  }

  if (chatId === ctx.cfg.groupChatId) {
    if (!wasIn) sendText_(ctx.token, chatId, connectedText_(isAdminNow));
    else if (isAdminNow && !wasAdmin) sendText_(ctx.token, chatId, '✅ Thanks, I’m an admin now. Type /checkin to check in.');
    return;
  }

  // Some other group. If it is ours after an upgrade to a supergroup, follow it; otherwise leave.
  if (change.chat.type === 'supergroup' && migratedTo_(ctx) === chatId) {
    adoptGroup_(ctx.cfg, ctx.cfg.groupChatId, chatId);
    return;
  }
  if (!wasIn) {
    sendText_(ctx.token, chatId, 'This check-in bot is already connected to another group, so it’s leaving. ' +
      'To move it here, clear GROUP_CHAT_ID in the Config tab of its Sheet, run setup() and use the connect link it shows.');
  }
  const left = tgCall_(ctx.token, 'leaveChat', { chat_id: chatId });
  console.info('Left group ' + chatId + ' (already connected to another group): ' + (left.ok ? 'ok' : left.description));
}

/**
 * Writes chatId into GROUP_CHAT_ID if it is still blank (under the lock, so two groups can't
 * both win) and uses up the connect code. Returns true if this group is now the connected one.
 */
function connectGroup_(ctx, chatId, isBotAdmin) {
  const won = withScriptLock_(() => {
    const current = loadConfig_(true).groupChatId;
    if (current) return current === chatId;
    setConfigValue_('GROUP_CHAT_ID', chatId);
    PropertiesService.getScriptProperties().deleteProperty('CONNECT_CODE');
    return true;
  });
  if (won === null) throw new Error('Could not connect the group: the script lock was busy.');
  if (!won) return false;
  console.info('Connected to group ' + chatId + '.');
  ctx.cfg.groupChatId = chatId;
  sendText_(ctx.token, chatId, connectedText_(isBotAdmin));
  return true;
}

/** "/start@bot <code>" arrives in the group chosen through the connect link from setup(). */
function onConnectLink_(ctx, msg, code) {
  const expected = PropertiesService.getScriptProperties().getProperty('CONNECT_CODE');
  if (!expected || !constantTimeEqual_(code, expected)) {
    console.warn('Ignored a connect link with a wrong or used-up code.');
    return;
  }
  const chatId = String(msg.chat.id);
  const botId = Number(String(ctx.token).split(':')[0]);
  const me = tgCall_(ctx.token, 'getChatMember', { chat_id: chatId, user_id: botId });
  connectGroup_(ctx, chatId, me.ok && me.result && me.result.status === 'administrator');
}

function connectedText_(isAdmin) {
  return '✅ Check-in is connected to this group.\n' +
    (isAdmin
      ? 'Type /checkin to check in. Admins start a check-in from the same button.'
      : 'One more step: make me an admin, so I can check who’s in the group.');
}

/** The connected group's new id if Telegram upgraded it to a supergroup, else null. */
function migratedTo_(ctx) {
  if (!ctx.cfg.groupChatId || /^-100/.test(ctx.cfg.groupChatId)) return null; // already a supergroup
  const res = tgCall_(ctx.token, 'getChat', { chat_id: ctx.cfg.groupChatId });
  const to = !res.ok && res.parameters && res.parameters.migrate_to_chat_id;
  return to ? String(to) : null;
}

/** Someone joined, left, or was promoted or demoted: their cached role is stale. */
function onMemberChange_(ctx, change) {
  if (!change.chat || String(change.chat.id) !== ctx.cfg.groupChatId) return;
  const user = change.new_chat_member && change.new_chat_member.user;
  if (user && Number.isSafeInteger(user.id)) CacheService.getScriptCache().remove(roleCacheKey_(ctx.cfg.groupChatId, user.id));
}

function onMessage_(ctx, msg) {
  const chatId = String(msg.chat.id);
  const groupId = ctx.cfg.groupChatId;
  // Telegram upgraded the group to a supergroup: both the old and the new chat say so.
  if (groupId && msg.migrate_to_chat_id && chatId === groupId) {
    return adoptGroup_(ctx.cfg, groupId, String(msg.migrate_to_chat_id));
  }
  if (groupId && msg.migrate_from_chat_id && String(msg.migrate_from_chat_id) === groupId) {
    return adoptGroup_(ctx.cfg, groupId, chatId);
  }

  const command = parseCommand_(msg.text, botUsername_(ctx.token));
  if (!command) return;
  if (msg.chat.type === 'private') return onPrivateCommand_(ctx, chatId);
  if (!isGroupChat_(msg.chat)) return;
  if (command.name === 'start' && !groupId && command.arg) return onConnectLink_(ctx, msg, command.arg);
  if (command.name === 'checkin' && chatId === groupId) return onGroupCheckin_(ctx, msg);
}

/**
 * {name: 'checkin' | 'start', arg} for "/checkin", "/start@ThisBot <arg>" and so on; null for
 * anything else, including commands addressed to another bot.
 */
function parseCommand_(text, botUsername) {
  const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?=\s|$)\s*(\S*)/.exec(typeof text === 'string' ? text : '');
  if (!m) return null;
  if (m[2] && (!botUsername || m[2].toLowerCase() !== botUsername.toLowerCase())) return null;
  const name = m[1].toLowerCase();
  return name === 'checkin' || name === 'start' ? { name: name, arg: m[3] } : null;
}

/** The bot's @username, from Script Properties (setup() stores it) or getMe once. */
function botUsername_(token) {
  const props = PropertiesService.getScriptProperties();
  let name = props.getProperty('BOT_USERNAME');
  if (!name) {
    const me = tgCall_(token, 'getMe', {});
    if (!me.ok) return '';
    name = me.result.username;
    props.setProperty('BOT_USERNAME', name);
  }
  return name;
}

/**
 * /checkin in the group: the command itself is deleted and one fresh button is posted at the
 * bottom (replacing the previous one), so a roomful of people typing it leaves one message.
 */
function onGroupCheckin_(ctx, msg) {
  const ready = CONFIG_CHECKS_.MINI_APP_LINK(ctx.cfg);
  // Without a button to post, the member's command stays, so they can see it was received.
  if (ready) {
    const deleted = deleteMessage_(ctx.token, msg.chat.id, msg.message_id);
    if (!deleted.ok) console.warn('Could not delete a /checkin message (is the bot allowed to delete messages?): ' + deleted.description);
  }
  const cache = CacheService.getScriptCache();
  if (cache.get('group-button')) return; // a fresh button went up moments ago
  cache.put('group-button', '1', GROUP_BUTTON_MIN_GAP_SEC_);
  if (!ready) {
    sendText_(ctx.token, msg.chat.id, NOT_READY_TEXT_);
    return;
  }
  const session = findActiveSession_(sessionsForRead_(), now_().getTime());
  const text = session ? openText_(session) : '📍 No check-in is open right now. Admins can start one from this button.';
  const posted = postLiveMessage_(ctx, text, session ? session.id : '');
  if (!posted.ok) console.warn('Could not post the Check in button: ' + posted.description);
}

/** /start or /checkin in a private chat with the bot. */
function onPrivateCommand_(ctx, chatId) {
  const cache = CacheService.getScriptCache();
  const key = 'private-reply:' + chatId;
  if (cache.get(key)) return;
  cache.put(key, '1', PRIVATE_REPLY_MIN_GAP_SEC_);
  if (!CONFIG_CHECKS_.MINI_APP_LINK(ctx.cfg)) {
    sendText_(ctx.token, chatId, NOT_READY_TEXT_);
    return;
  }
  sendText_(ctx.token, chatId, 'Tap the button to check in. It works when a check-in is open and you’re at the venue.',
    checkinKeyboard_(ctx.cfg));
}
