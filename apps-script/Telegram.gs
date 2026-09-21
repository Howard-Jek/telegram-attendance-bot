/**
 * Telegram Bot API helpers: membership and admin lookups, and the messages the bot posts.
 * Updates from Telegram arrive through the webhook (Webhook.gs).
 */

const TELEGRAM_API_ = 'https://api.telegram.org/bot';

// How long a role answer is reused. Short, so joins, removals and promotions take effect quickly
// (chat_member updates also clear it at once); long enough that repeated attempts can't burn the
// UrlFetch quota or the bot's rate limit.
const ROLE_CACHE_SEC_ = { ADMIN: 300, MEMBER: 300, NOT_MEMBER: 60 };

/** Calls a Bot API method and returns its JSON body ({ok, result} or {ok: false, error_code, description}). */
function tgCall_(token, method, params) {
  let resp;
  try {
    resp = UrlFetchApp.fetch(TELEGRAM_API_ + token + '/' + method, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(params),
      muteHttpExceptions: true,
    });
  } catch (err) {
    // UrlFetchApp error messages can include the request URL, which contains the token.
    throw new Error('Telegram ' + method + ' request failed: ' + redactSecrets_(String(err && err.message)));
  }
  let body = null;
  try {
    body = JSON.parse(resp.getContentText());
  } catch (err) {
    // handled below
  }
  if (!body || typeof body.ok !== 'boolean') {
    return { ok: false, error_code: resp.getResponseCode(), description: 'Unexpected response from Telegram' };
  }
  return body;
}

function roleCacheKey_(chatId, userId) {
  return 'role:' + chatId + ':' + userId;
}

/**
 * The user's role in the configured group, behind a short cache: 'ADMIN', 'MEMBER',
 * 'NOT_MEMBER' or 'BUSY' (rate-limited; never cached). If Telegram reports that the group was
 * upgraded to a supergroup, GROUP_CHAT_ID follows it (cfg is updated) and the lookup is retried.
 */
function cachedGroupRole_(token, cfg, userId) {
  const cache = CacheService.getScriptCache();
  const key = roleCacheKey_(cfg.groupChatId, userId);
  const hit = cache.get(key);
  if (ROLE_CACHE_SEC_[hit]) return hit;
  let result = groupRole_(token, cfg.groupChatId, userId);
  if (typeof result === 'object') {
    adoptGroup_(cfg, cfg.groupChatId, result.migratedTo);
    result = groupRole_(token, cfg.groupChatId, userId);
    if (typeof result === 'object') throw new SetupError_('The group moved and could not be followed. Please tell an admin.');
  }
  if (ROLE_CACHE_SEC_[result]) cache.put(roleCacheKey_(cfg.groupChatId, userId), result, ROLE_CACHE_SEC_[result]);
  return result;
}

/**
 * @return {string|{migratedTo: string}} 'ADMIN', 'MEMBER', 'NOT_MEMBER' or 'BUSY', or the new
 *   chat id if the group became a supergroup. Throws for setup problems (bad token, bot not in
 *   the group) so they surface as errors instead of silently turning every member away.
 */
function groupRole_(token, chatId, userId) {
  const res = tgCall_(token, 'getChatMember', { chat_id: chatId, user_id: Number(userId) });
  if (res.ok) {
    const m = res.result || {};
    if (m.status === 'creator' || m.status === 'administrator') return 'ADMIN';
    if (m.status === 'member') return 'MEMBER';
    if (m.status === 'restricted' && m.is_member === true) return 'MEMBER';
    return 'NOT_MEMBER';
  }
  const desc = String(res.description || '');
  const migratedTo = res.parameters && res.parameters.migrate_to_chat_id;
  if (migratedTo) return { migratedTo: String(migratedTo) };
  if (res.error_code === 429) return 'BUSY';
  // Undocumented strings Telegram uses for users it can't find in the chat.
  if (res.error_code === 400 && /user not found|member not found|participant_id_invalid|user_id_invalid|user_not_participant/i.test(desc)) {
    // Kept in the log: if real members get this, the bot is probably not a group admin.
    console.warn('getChatMember for user ' + userId + ': ' + desc);
    return 'NOT_MEMBER';
  }
  if (res.error_code === 401 || res.error_code === 403 || /chat not found|chat_id is empty|upgraded to a supergroup/i.test(desc)) {
    throw new SetupError_('The bot cannot see the group (' + desc + '). Please tell an admin.');
  }
  throw new Error('getChatMember failed: ' + res.error_code + ' ' + desc);
}

/**
 * Points GROUP_CHAT_ID at the group's new id after Telegram upgraded it to a supergroup. Only
 * moves it if it still holds fromId, so a stale or repeated notice can't change the group.
 * Telegram is the only source of fromId/toId here (a Bot API answer or a webhook update).
 */
function adoptGroup_(cfg, fromId, toId) {
  const moved = withScriptLock_(() => {
    if (loadConfig_().groupChatId !== String(fromId)) return false;
    setConfigValue_('GROUP_CHAT_ID', String(toId));
    return true;
  });
  if (moved === null) throw new Error('Could not update GROUP_CHAT_ID: the script lock was busy.');
  if (moved) console.info('The group became a supergroup; GROUP_CHAT_ID now points to it.');
  cfg.groupChatId = loadConfig_().groupChatId;
}

/** The inline keyboard with the one button that opens the Mini App. */
function checkinKeyboard_(cfg) {
  return { inline_keyboard: [[{ text: '📍 Check in', url: cfg.miniAppLink }]] };
}

/** Sends plain text (no parse_mode, so names and group names need no escaping). */
function sendText_(token, chatId, text, replyMarkup) {
  const params = { chat_id: chatId, text: text, link_preview_options: { is_disabled: true } };
  if (replyMarkup) params.reply_markup = replyMarkup;
  return tgCall_(token, 'sendMessage', params);
}

function deleteMessage_(token, chatId, messageId) {
  return tgCall_(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
}

/** Replaces a message's text. Without reply_markup, Telegram also removes its buttons. */
function editText_(token, chatId, messageId, text) {
  return tgCall_(token, 'editMessageText', {
    chat_id: chatId, message_id: messageId, text: text, link_preview_options: { is_disabled: true },
  });
}
