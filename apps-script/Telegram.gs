/**
 * Telegram Bot API helpers. Outbound calls only: there is no webhook.
 * Phase 3 adds sendMessage / editMessageText for announcements.
 */

const TELEGRAM_API_ = 'https://api.telegram.org/bot';

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

/**
 * @return {string} 'MEMBER', 'NOT_MEMBER' or 'BUSY' (rate-limited).
 * Throws for setup problems (bad token, wrong GROUP_CHAT_ID, bot not in group) so they
 * surface as errors instead of silently turning every member away.
 */
function groupMembership_(token, chatId, userId) {
  const res = tgCall_(token, 'getChatMember', { chat_id: chatId, user_id: Number(userId) });
  if (res.ok) {
    const m = res.result || {};
    if (m.status === 'creator' || m.status === 'administrator' || m.status === 'member') return 'MEMBER';
    if (m.status === 'restricted' && m.is_member === true) return 'MEMBER';
    return 'NOT_MEMBER';
  }
  const desc = String(res.description || '');
  const migratedTo = res.parameters && res.parameters.migrate_to_chat_id;
  if (migratedTo) {
    throw new SetupError_('The group was upgraded to a supergroup. Set GROUP_CHAT_ID to ' + migratedTo + ' in Config.');
  }
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
