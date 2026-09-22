'use strict';
/**
 * Shared test setup: an emulated Apps Script project with the Sheet prepared by setupSheets(),
 * a Bot API mock that models the group chat (messages posted, edited and deleted), and helpers
 * to send Mini App requests signed like real initData.
 */
const { createEnv } = require('./gas-emulator');
const signer = require('../tools/sign-initdata');

const TOKEN = '999999:TEST-backend-token_abc';
const GROUP = '-1001234567890';
const BOT = { id: 7000000001, is_bot: true, first_name: 'Check-in', username: 'test_checkin_bot' };
const SITE = { lat: 1.2834, lng: 103.8607 };
const T0 = Date.parse('2026-09-21T02:30:15Z'); // 10:30:15 SGT
const MIN = 60 * 1000;

const ADMIN = { id: 111111, first_name: 'Ada', last_name: 'Admin', username: 'ada' }; // group administrator
const ADMIN2 = { id: 222222, first_name: 'Bo', username: 'bo' }; // group creator
const MEMBER = { id: 333333, first_name: 'Cy', last_name: 'Member', username: 'cy' };
const MEMBER2 = { id: 444444, first_name: 'Di' };
const OUTSIDER = { id: 555555, first_name: 'Ed' };

const SITE_FIX = { lat: SITE.lat, lng: SITE.lng, accuracy: 12 }; // where admins start sessions
const ONSITE = { lat: SITE.lat + 0.0005, lng: SITE.lng, accuracy: 20 }; // ~56 m away
const OFFSITE = { lat: SITE.lat + 0.01, lng: SITE.lng, accuracy: 20 }; // ~1.1 km away
const BLURRY = { ...ONSITE, accuracy: 250 };

/**
 * @param statuses user id -> 'member' | 'administrator' | ... | full getChatMember body | (params) => body
 * @param telegram extra or overriding Bot API method mocks
 * @param groups   rows for the Groups tab
 */
function setup({ statuses = {}, config = {}, telegram = {}, groups = [], props = {} } = {}) {
  const roles = { [ADMIN.id]: 'administrator', [ADMIN2.id]: 'creator', ...statuses };
  let nextId = 100;
  const chat = []; // every message the bot posted, in order: {chatId, messageId, text, buttons, deleted}
  const find = (chatId, messageId) => chat.find((m) => m.chatId === String(chatId) && m.messageId === messageId);
  const ok = (result) => ({ ok: true, result });
  const env = createEnv({
    props: { BOT_TOKEN: TOKEN, ...props },
    telegram: {
      getChatMember: (params) => {
        if (params.user_id === BOT.id) return ok({ status: 'administrator', user: BOT, can_delete_messages: true });
        const s = roles[params.user_id];
        if (typeof s === 'function') return s(params);
        if (s === undefined || typeof s === 'string') return ok({ status: s || 'member', user: { id: params.user_id } });
        return s;
      },
      sendMessage: (params) => {
        const m = { chatId: String(params.chat_id), messageId: nextId++, text: params.text,
          buttons: params.reply_markup ? params.reply_markup.inline_keyboard.flat() : [], deleted: false };
        chat.push(m);
        return ok({ message_id: m.messageId, chat: { id: Number(params.chat_id) }, text: m.text });
      },
      deleteMessage: (params) => {
        const m = find(params.chat_id, params.message_id);
        if (m) m.deleted = true;
        env.deletedIds.push(params.message_id);
        return ok(true);
      },
      editMessageText: (params) => {
        const m = find(params.chat_id, params.message_id);
        if (!m || m.deleted) return { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' };
        m.text = params.text;
        m.buttons = params.reply_markup ? params.reply_markup.inline_keyboard.flat() : [];
        return ok({ message_id: m.messageId });
      },
      leaveChat: () => ok(true),
      getChat: (params) => ok({ id: Number(params.chat_id), type: 'supergroup' }),
      getMe: () => ok(BOT),
      setWebhook: () => ok(true),
      setMyCommands: () => ok(true),
      ...telegram,
    },
  });
  env.chat = chat;
  env.deletedIds = [];
  /** Messages still visible in a chat (default: the group). */
  env.visible = (chatId = GROUP) => chat.filter((m) => m.chatId === String(chatId) && !m.deleted);
  env.calls = (method) => env.fetches.filter((f) => f.url.endsWith('/' + method)).map((f) => JSON.parse(f.opts.payload));

  env.setNow(T0);
  env.call('setupSheets');
  const values = {
    GROUP_CHAT_ID: GROUP,
    MINI_APP_LINK: 'https://t.me/test_checkin_bot/checkin',
    ...config,
  };
  const cfg = env.sheet('Config');
  for (let r = 2; r <= cfg.getLastRow(); r++) {
    const key = cfg.getRange(r, 1).getValue();
    if (key in values) cfg.getRange(r, 2).setValue(values[key]);
  }
  groups.forEach((g) => env.sheet('Groups').appendRow([g]));

  env.initData = (user, authDate = Math.floor(env.nowMs / 1000)) =>
    signer.encode(signer.sign(signer.buildFields({ ...signer.DEFAULTS, user, authDate }), TOKEN));
  env.req = (action, user, extra = {}) => env.post({ action, initData: env.initData(user), platform: 'android', ...extra });
  env.start = (user, location = SITE_FIX) => env.req('startSession', user, { location });
  env.checkin = (user, location = ONSITE, extra = {}) => env.req('checkin', user, { location, ...extra });
  env.saveProfile = (user, fullName, group) => env.req('saveProfile', user, { fullName, group });
  env.rows = (name) => env.sheet(name).rows();
  env.config = (key) => {
    const row = env.rows('Config').find((r) => r[0] === key);
    return row ? row[1] : undefined;
  };
  return env;
}

module.exports = {
  setup, TOKEN, GROUP, BOT, SITE, SITE_FIX, T0, MIN,
  ADMIN, ADMIN2, MEMBER, MEMBER2, OUTSIDER, ONSITE, OFFSITE, BLURRY,
};
