'use strict';
/**
 * The September 2026 additions: /checkin via the webhook, the group connecting itself, admins
 * taken from the Telegram group, each check-in centred on the admin who started it, the group's
 * single Check in button and closing result, members' groups and full names, and setup().
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./gas-emulator');
const {
  setup, TOKEN, GROUP, BOT, SITE, SITE_FIX, T0, MIN, ADMIN, ADMIN2, MEMBER, MEMBER2, OUTSIDER, ONSITE, OFFSITE, BLURRY,
} = require('./helpers');

const SECRET = 'f'.repeat(64);
const GROUP_CHAT = { id: Number(GROUP), type: 'supergroup', title: 'Choir' };
const OTHER_CHAT = { id: -1005555555555, type: 'supergroup', title: 'Someone else' };
const BASIC_GROUP = '-5295937917';

function hooked(opts = {}) {
  const env = setup({ ...opts, props: { WEBHOOK_SECRET: SECRET, BOT_USERNAME: BOT.username, ...(opts.props || {}) } });
  let nextUpdate = 1;
  let nextMessage = 5000;
  env.update = (body) => env.webhook({ update_id: nextUpdate++, ...body });
  env.say = (from, text, chat = GROUP_CHAT, extra = {}) =>
    env.update({ message: { message_id: nextMessage++, from, chat, date: Math.floor(env.nowMs / 1000), text, ...extra } });
  env.botJoins = (chat, newStatus = 'administrator', oldStatus = 'left', from = ADMIN) => env.update({
    my_chat_member: { chat, from, date: 0, old_chat_member: { status: oldStatus, user: BOT }, new_chat_member: { status: newStatus, user: BOT } },
  });
  return env;
}

const buttons = (env) => env.visible().filter((m) => m.buttons.length);

// ---------- webhook plumbing ----------

test('webhook: answers with HtmlService (HTTP 200, no redirect) whatever happens', () => {
  const env = hooked();
  for (const out of [
    env.webhook({ update_id: 1 }, 'wrong'),
    env.webhook({ update_id: 2 }, ''),
    env.webhook('not json'),
    env.webhook({ no_update_id: true }),
    env.say(MEMBER, '/checkin'),
  ]) {
    assert.equal(out.kind, 'html');
  }
  env.props.BOT_TOKEN = undefined;
  delete env.props.BOT_TOKEN;
  assert.equal(env.say(MEMBER, '/checkin').kind, 'html', 'even when handling throws');
});

test('webhook: a missing or wrong secret is ignored without touching Telegram or the Sheet', () => {
  const env = hooked();
  env.events.length = 0;
  for (const hook of ['wrong', '', SECRET.slice(1), SECRET + 'x']) {
    env.webhook({ update_id: 1, message: { message_id: 1, from: MEMBER, chat: GROUP_CHAT, text: '/checkin' } }, hook);
  }
  assert.equal(env.fetches.length, 0);
  assert.equal(env.events.filter((e) => e.type === 'open' || e.type === 'write').length, 0);
  assert.ok(env.logs.some((l) => l.level === 'warn' && /wrong secret/.test(l.text)));

  delete env.props.WEBHOOK_SECRET; // before setup() has run, nothing is accepted
  env.webhook({ update_id: 2, message: { message_id: 2, from: MEMBER, chat: GROUP_CHAT, text: '/checkin' } }, '');
  assert.equal(env.fetches.length, 0);
});

test('webhook: the Mini App path is unaffected (no hook parameter -> JSON)', () => {
  const env = hooked();
  assert.equal(env.req('status', MEMBER).code, 'OK');
});

test('webhook: a resent update is handled once', () => {
  const env = hooked();
  const u = { update_id: 77, message: { message_id: 9, from: MEMBER, chat: GROUP_CHAT, text: '/checkin' } };
  env.webhook(u);
  env.setNow(T0 + 30 * 1000); // past the button gap, so only de-duplication can stop a second post
  env.webhook(u);
  assert.equal(env.calls('sendMessage').length, 1);
});

test('webhook: ordinary chat messages leave nothing in the cache (it holds only 1,000 items)', () => {
  const env = hooked();
  const before = env.cache.size;
  for (let i = 0; i < 50; i++) env.say(MEMBER, 'chat message ' + i);
  assert.equal(env.cache.size, before);
});

test('webhook: ordinary chat messages return before opening the Sheet', () => {
  const env = hooked();
  env.events.length = 0;
  env.say(MEMBER, 'good morning everyone');
  env.say(MEMBER, '');
  env.update({ message: { message_id: 1, from: MEMBER, chat: GROUP_CHAT, photo: [] } });
  env.update({ edited_message: { message_id: 1, chat: GROUP_CHAT, text: '/checkin' } });
  assert.equal(env.events.filter((e) => e.type === 'open').length, 0);
  assert.equal(env.fetches.length, 0);
});

// ---------- /checkin ----------

test('/checkin in the group: the command is deleted and one Check in button is posted', () => {
  const env = hooked();
  env.say(MEMBER, '/checkin');
  const [cmdDelete] = env.calls('deleteMessage');
  assert.deepEqual(cmdDelete, { chat_id: Number(GROUP), message_id: 5000 });
  const [b] = buttons(env);
  assert.deepEqual(b.buttons, [{ text: '📍 Check in', url: 'https://t.me/test_checkin_bot/checkin' }]);
  assert.match(b.text, /No check-in is open/);

  env.start(ADMIN);
  env.setNow(T0 + 5 * MIN);
  env.say(MEMBER2, '/checkin@test_checkin_bot');
  const live = buttons(env);
  assert.equal(live.length, 1, 'only one button message is ever visible');
  assert.match(live[0].text, /open until 11:30/);
});

test('/checkin: a burst leaves one button and stays under Telegram\'s group rate limit', () => {
  const env = hooked();
  for (let i = 0; i < 30; i++) {
    env.setNow(T0 + i * 1000);
    env.say({ id: 800000 + i, first_name: 'P' + i }, '/checkin');
  }
  assert.equal(env.calls('deleteMessage').filter((p) => p.message_id >= 5000).length, 30, 'every command tidied away');
  assert.ok(env.calls('sendMessage').length <= 2, 'at most one post per 20 s');
  assert.equal(buttons(env).length, 1);
  env.setNow(T0 + 31 * 1000);
  env.say(MEMBER, '/checkin');
  assert.equal(buttons(env).length, 1, 'a later /checkin replaces the button at the bottom');
  assert.equal(env.visible().at(-1).buttons.length, 1);
});

test('/checkin: other bots\' commands, other groups and look-alikes are ignored', () => {
  const env = hooked();
  env.say(MEMBER, '/checkin@SomeOtherBot');
  env.say(MEMBER, '/checkinnow');
  env.say(MEMBER, 'please /checkin');
  env.say(MEMBER, '/checkin', OTHER_CHAT);
  assert.equal(env.calls('sendMessage').length, 0);
  assert.equal(env.calls('deleteMessage').length, 0);
});

test('/checkin before MINI_APP_LINK is set: the command stays and the group is told why', () => {
  const env = hooked({ config: { MINI_APP_LINK: '' } });
  env.say(MEMBER, '/checkin');
  assert.equal(env.calls('deleteMessage').length, 0, 'the member\'s message is not silently removed');
  const [msg] = env.visible();
  assert.match(msg.text, /isn’t fully set up/);
  assert.match(msg.text, /MINI_APP_LINK/);
  assert.deepEqual(msg.buttons, []);
  env.say(MEMBER2, '/checkin');
  assert.equal(env.visible().length, 1, 'rate-limited like the button');
  env.say(MEMBER, '/start', { id: MEMBER.id, type: 'private' });
  assert.match(env.visible(String(MEMBER.id))[0].text, /isn’t fully set up/);
});

test('start without MINI_APP_LINK: the warning does not tell the admin to share a link they don\'t have', () => {
  const env = setup({ config: { MINI_APP_LINK: '' } });
  const res = env.start(ADMIN);
  assert.equal(res.data.shareLink, undefined);
  assert.doesNotMatch(res.data.warning, /Share/);
});

test('/checkin still posts a button when the bot may not delete messages', () => {
  const env = hooked({ telegram: { deleteMessage: () => ({ ok: false, error_code: 400, description: "Bad Request: message can't be deleted" }) } });
  env.say(MEMBER, '/checkin');
  assert.equal(env.calls('sendMessage').length, 1);
  assert.ok(env.logs.some((l) => l.level === 'warn' && /allowed to delete/.test(l.text)));
});

test('/start or /checkin in a private chat replies with the button (rate-limited per chat)', () => {
  const env = hooked();
  const dm = { id: MEMBER.id, type: 'private', first_name: 'Cy' };
  env.say(MEMBER, '/start', dm);
  env.say(MEMBER, '/checkin', dm);
  const sent = env.calls('sendMessage');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, String(MEMBER.id));
  assert.deepEqual(sent[0].reply_markup.inline_keyboard[0][0].url, 'https://t.me/test_checkin_bot/checkin');
  env.setNow(T0 + 11 * 1000);
  env.say(MEMBER, '/checkin', dm);
  assert.equal(env.calls('sendMessage').length, 2);
});

// ---------- the group connects itself ----------

test('connect: with GROUP_CHAT_ID blank, a group the owner (ADMIN_IDS) adds the bot to is connected', () => {
  const env = hooked({ config: { GROUP_CHAT_ID: '', ADMIN_IDS: String(ADMIN.id) } });
  env.botJoins(GROUP_CHAT);
  assert.equal(env.config('GROUP_CHAT_ID'), GROUP);
  const [hello] = env.visible();
  assert.match(hello.text, /connected to this group/);
  assert.match(hello.text, /Type \/checkin/);
  assert.equal(env.req('status', ADMIN).data.isAdmin, true, 'its admins can now start check-ins');
});

test('connect: joined as a plain member -> asks to be made an admin, then thanks when promoted', () => {
  const env = hooked({ config: { GROUP_CHAT_ID: '', ADMIN_IDS: String(ADMIN.id) } });
  env.botJoins(GROUP_CHAT, 'member');
  assert.match(env.visible()[0].text, /make me an admin/);
  env.botJoins(GROUP_CHAT, 'administrator', 'member');
  assert.match(env.visible()[1].text, /I’m an admin now/);
  assert.equal(env.config('GROUP_CHAT_ID'), GROUP);
});

// Security scan F1: a stranger must not be able to claim the bot while GROUP_CHAT_ID is blank.
test('connect: a stranger adding the bot does not connect their group (they are told how it works)', () => {
  const env = hooked({ config: { GROUP_CHAT_ID: '', ADMIN_IDS: String(ADMIN.id) }, props: { CONNECT_CODE: 'c0ffee' + 'a'.repeat(26) } });
  env.botJoins(OTHER_CHAT, 'administrator', 'left', OUTSIDER);
  assert.equal(env.config('GROUP_CHAT_ID'), '');
  assert.equal(env.calls('leaveChat').length, 0, 'stays, in case the owner\'s connect link follows');
  assert.match(env.visible(OTHER_CHAT.id)[0].text, /connect link/);
  env.say(OUTSIDER, '/start@test_checkin_bot wrong-code', OTHER_CHAT);
  env.say(OUTSIDER, '/start@test_checkin_bot', OTHER_CHAT);
  assert.equal(env.config('GROUP_CHAT_ID'), '');
  // With no ADMIN_IDS at all, joining alone never connects either.
  const none = hooked({ config: { GROUP_CHAT_ID: '' } });
  none.botJoins(GROUP_CHAT, 'administrator', 'left', ADMIN);
  assert.equal(none.config('GROUP_CHAT_ID'), '');
});

test('connect: the one-time link from setup() connects the group it is used in', () => {
  const CODE = 'c0ffee' + 'a'.repeat(26);
  const env = hooked({ config: { GROUP_CHAT_ID: '' }, props: { CONNECT_CODE: CODE } });
  env.botJoins(GROUP_CHAT, 'administrator', 'left', ADMIN); // Telegram adds the bot, then sends /start <code>
  env.say(ADMIN, '/start@test_checkin_bot ' + CODE);
  assert.equal(env.config('GROUP_CHAT_ID'), GROUP);
  assert.equal(env.props.CONNECT_CODE, undefined, 'used up');
  assert.ok(env.visible().some((m) => /connected to this group/.test(m.text)));
  // Replaying the link elsewhere does nothing now.
  env.say(OUTSIDER, '/start@test_checkin_bot ' + CODE, OTHER_CHAT);
  assert.equal(env.config('GROUP_CHAT_ID'), GROUP);
});

test('connect: once connected, any other group is told and left; the setting is unchanged', () => {
  const env = hooked();
  env.botJoins(OTHER_CHAT);
  assert.equal(env.config('GROUP_CHAT_ID'), GROUP);
  const [msg] = env.visible(OTHER_CHAT.id);
  assert.match(msg.text, /already connected to another group/);
  assert.deepEqual(env.calls('leaveChat'), [{ chat_id: String(OTHER_CHAT.id) }]);
  // Channels and private chats never connect.
  const blank = hooked({ config: { GROUP_CHAT_ID: '', ADMIN_IDS: String(ADMIN.id) } });
  blank.botJoins({ id: -1001, type: 'channel', title: 'News' });
  assert.equal(blank.config('GROUP_CHAT_ID'), '');
});

test('connect: the bot being removed does not clear or change the connection', () => {
  const env = hooked();
  env.botJoins(GROUP_CHAT, 'left', 'administrator');
  assert.equal(env.config('GROUP_CHAT_ID'), GROUP);
  assert.equal(env.calls('sendMessage').length, 0);
});

test('connect: the stored id is text, so a basic group\'s negative id is not turned into a number', () => {
  const env = hooked({ config: { GROUP_CHAT_ID: '', ADMIN_IDS: String(ADMIN.id) } });
  env.botJoins({ id: Number(BASIC_GROUP), type: 'group', title: 'Small group' });
  assert.equal(env.config('GROUP_CHAT_ID'), BASIC_GROUP);
  assert.equal(typeof env.config('GROUP_CHAT_ID'), 'string');
});

// ---------- following a supergroup upgrade ----------

const NEW_SUPERGROUP = '-1009876543210';

test('migration: the old group\'s "migrated to" notice moves GROUP_CHAT_ID', () => {
  const env = hooked({ config: { GROUP_CHAT_ID: BASIC_GROUP } });
  env.say(ADMIN, undefined, { id: Number(BASIC_GROUP), type: 'group' }, { migrate_to_chat_id: Number(NEW_SUPERGROUP) });
  assert.equal(env.config('GROUP_CHAT_ID'), NEW_SUPERGROUP);
});

test('migration: the new supergroup\'s "migrated from" notice moves it too; notices about other groups do not', () => {
  const env = hooked({ config: { GROUP_CHAT_ID: BASIC_GROUP } });
  env.say(ADMIN, undefined, OTHER_CHAT, { migrate_from_chat_id: -4444 });
  env.say(ADMIN, undefined, OTHER_CHAT, { migrate_to_chat_id: -1001111 });
  assert.equal(env.config('GROUP_CHAT_ID'), BASIC_GROUP);
  env.say(ADMIN, undefined, { id: Number(NEW_SUPERGROUP), type: 'supergroup' }, { migrate_from_chat_id: Number(BASIC_GROUP) });
  assert.equal(env.config('GROUP_CHAT_ID'), NEW_SUPERGROUP);
});

test('migration: the bot "joining" the upgraded supergroup is recognised, not left', () => {
  const env = hooked({
    config: { GROUP_CHAT_ID: BASIC_GROUP },
    telegram: {
      getChat: (p) => (p.chat_id === BASIC_GROUP
        ? { ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: Number(NEW_SUPERGROUP) } }
        : { ok: true, result: { id: Number(p.chat_id), type: 'supergroup' } }),
    },
  });
  env.botJoins({ id: Number(NEW_SUPERGROUP), type: 'supergroup', title: 'Choir' });
  assert.equal(env.config('GROUP_CHAT_ID'), NEW_SUPERGROUP);
  assert.equal(env.calls('leaveChat').length, 0);
});

test('migration: a membership lookup that reports the upgrade follows it and retries', () => {
  const env = hooked({
    config: { GROUP_CHAT_ID: BASIC_GROUP },
    statuses: {
      [MEMBER.id]: (p) => (p.chat_id === BASIC_GROUP
        ? { ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: Number(NEW_SUPERGROUP) } }
        : { ok: true, result: { status: 'member' } }),
    },
  });
  env.props.ADMIN_IDS = undefined;
  env.start(ADMIN); // ADMIN's lookup (default mock) doesn't report the move
  assert.equal(env.checkin(MEMBER).code, 'CHECKED_IN');
  assert.equal(env.config('GROUP_CHAT_ID'), NEW_SUPERGROUP);
});

// ---------- admins are the group's admins ----------

test('admins: the group\'s creator and administrators can start; members cannot', () => {
  const env = setup();
  assert.equal(env.req('status', ADMIN).data.isAdmin, true);
  assert.equal(env.req('status', ADMIN2).data.isAdmin, true);
  assert.equal(env.req('status', MEMBER).data.isAdmin, false);
  assert.equal(env.start(MEMBER).code, 'NOT_ADMIN');
  assert.equal(env.start(ADMIN2).code, 'SESSION_STARTED');
});

test('admins: ADMIN_IDS adds people who are not Telegram admins', () => {
  const env = setup({ config: { ADMIN_IDS: String(MEMBER.id) } });
  assert.equal(env.req('status', MEMBER).data.isAdmin, true);
  assert.equal(env.start(MEMBER).code, 'SESSION_STARTED');
  assert.equal(env.req('status', MEMBER2).data.isAdmin, false);
});

test('admins: one lookup covers opening the app, starting and checking in', () => {
  const env = setup();
  env.req('status', ADMIN);
  env.start(ADMIN);
  env.checkin(ADMIN, ONSITE);
  assert.equal(env.calls('getChatMember').filter((p) => p.user_id === ADMIN.id).length, 1);
});

test('admins: a promotion takes effect at once (the chat_member update clears the cached role)', () => {
  let status = 'member';
  const env = hooked({ statuses: { [MEMBER.id]: () => ({ ok: true, result: { status } }) } });
  assert.equal(env.req('status', MEMBER).data.isAdmin, false);
  status = 'administrator';
  assert.equal(env.req('status', MEMBER).data.isAdmin, false, 'still cached');
  env.update({ chat_member: { chat: GROUP_CHAT, from: ADMIN, date: 0,
    old_chat_member: { status: 'member', user: MEMBER }, new_chat_member: { status: 'administrator', user: MEMBER } } });
  assert.equal(env.req('status', MEMBER).data.isAdmin, true);
});

test('admins: a demoted admin loses Start once the cached role expires', () => {
  let status = 'administrator';
  const env = setup({ statuses: { [MEMBER.id]: () => ({ ok: true, result: { status } }) } });
  assert.equal(env.req('status', MEMBER).data.isAdmin, true);
  status = 'member';
  env.setNow(T0 + 5 * MIN + 1000);
  assert.equal(env.start(MEMBER).code, 'NOT_ADMIN');
});

test('admins: a rate-limited lookup -> BUSY (never a wrong yes or no)', () => {
  const env = setup({ statuses: { [ADMIN.id]: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 2' } } });
  assert.equal(env.req('status', ADMIN).code, 'BUSY');
  assert.equal(env.start(ADMIN).code, 'BUSY');
  assert.equal(env.rows('Sessions').length, 0);
});

test('admins: status for a non-member still works (they learn at check-in)', () => {
  const env = setup({ statuses: { [OUTSIDER.id]: 'left' } });
  const s = env.req('status', OUTSIDER);
  assert.equal(s.code, 'OK');
  assert.equal(s.data.isAdmin, false);
});

// ---------- each check-in is centred on the admin who started it ----------

test('location: starting needs the admin\'s location, precise enough', () => {
  const env = setup();
  for (const location of [undefined, null, {}, { lat: 'x', lng: 1, accuracy: 5 }, { lat: 95, lng: 0, accuracy: 5 }]) {
    assert.equal(env.req('startSession', ADMIN, { location }).code, 'BAD_REQUEST', String(JSON.stringify(location)));
  }
  const blurry = env.start(ADMIN, { ...SITE_FIX, accuracy: 150 });
  assert.equal(blurry.code, 'LOW_ACCURACY');
  assert.equal(blurry.data.accuracyM, 150);
  assert.match(blurry.message, /check-in point/);
  assert.equal(env.start(ADMIN, { lat: SITE.lat, lng: SITE.lng }).code, 'LOW_ACCURACY', 'no accuracy at all');
  assert.equal(env.rows('Sessions').length, 0);
  assert.equal(env.calls('sendMessage').length, 0, 'nothing announced');
});

test('location: check-ins are measured from wherever that session was started', () => {
  const env = setup();
  const ELSEWHERE = { lat: 1.3521, lng: 103.8198, accuracy: 8 }; // ~10 km from SITE
  env.start(ADMIN, ELSEWHERE);
  assert.equal(env.checkin(MEMBER, ONSITE).code, 'OUT_OF_RANGE');
  assert.equal(env.checkin(MEMBER, { ...ELSEWHERE, accuracy: 30 }).code, 'CHECKED_IN');

  env.setNow(T0 + 61 * MIN);
  env.start(ADMIN2, SITE_FIX);
  assert.equal(env.checkin(MEMBER, ONSITE).code, 'CHECKED_IN');
  const log = env.rows('Log');
  assert.ok(log[0][9] < 1, 'distance from the first session\'s point');
  assert.ok(log[1][9] > 50 && log[1][9] < 60, 'distance from the second session\'s point');
});

test('location: an admin can move the check-in point to where they stand', () => {
  const env = setup();
  const WRONG = { lat: SITE.lat + 0.02, lng: SITE.lng, accuracy: 10 }; // started from the car park, 2 km off
  env.start(ADMIN, WRONG);
  assert.equal(env.checkin(MEMBER, ONSITE).code, 'OUT_OF_RANGE');

  assert.equal(env.req('moveSite', MEMBER, { location: SITE_FIX }).code, 'NOT_ADMIN');
  assert.equal(env.req('moveSite', ADMIN2, { location: BLURRY }).code, 'LOW_ACCURACY');
  assert.equal(env.req('moveSite', ADMIN2, { location: null }).code, 'BAD_REQUEST');
  const moved = env.req('moveSite', ADMIN2, { location: SITE_FIX });
  assert.equal(moved.code, 'SITE_MOVED');
  assert.equal(moved.data.closesAtText, '11:30');
  assert.deepEqual(env.rows('Sessions')[0].slice(8, 11), [SITE_FIX.lat, SITE_FIX.lng, SITE_FIX.accuracy]);
  assert.equal(env.checkin(MEMBER, ONSITE).code, 'CHECKED_IN');
});

test('location: moving needs an open check-in', () => {
  const env = setup();
  assert.equal(env.req('moveSite', ADMIN, { location: SITE_FIX }).code, 'NO_ACTIVE_SESSION');
  env.start(ADMIN);
  env.setNow(T0 + 60 * MIN);
  assert.equal(env.req('moveSite', ADMIN, { location: SITE_FIX }).code, 'NO_ACTIVE_SESSION');
});

test('location: a session from before this update (no point) explains itself, and Move fixes it', () => {
  const env = setup();
  env.sheet('Sessions').appendRow(['S-20260921-1030', ADMIN.id, 'Ada Admin', new Date(T0), new Date(T0 + 60 * MIN), '', 'open', 0]);
  const res = env.checkin(MEMBER);
  assert.equal(res.code, 'NO_SITE');
  assert.match(res.message, /Move check-in point here/);
  assert.equal(env.rows('Log').length, 0);
  env.req('moveSite', ADMIN, { location: SITE_FIX });
  assert.equal(env.checkin(MEMBER).code, 'CHECKED_IN');
});

// Security scan F2: distances must not let members pinpoint where an admin started a session.
test('distance: members get a rounded distance, or none beyond 1 km; admins get it exactly', () => {
  const env = setup();
  env.start(ADMIN);
  let res = env.checkin(MEMBER, { lat: SITE.lat + 0.001439, lng: SITE.lng, accuracy: 20 }); // ~160 m
  assert.equal(res.code, 'OUT_OF_RANGE');
  assert.deepEqual([res.data.distanceM, res.data.rounded], [200, true], 'rounded up to 50 m');
  assert.match(res.message, /about 200 m/);
  res = env.checkin(MEMBER, OFFSITE); // ~1.1 km
  assert.equal(res.data.distanceM, null);
  assert.equal(res.data.beyondM, 1000);
  assert.match(res.message, /more than 1 km/);
  assert.doesNotMatch(JSON.stringify(res), /111\d/);
  const admin = env.checkin(ADMIN2, OFFSITE);
  assert.ok(admin.data.distanceM > 1100 && admin.data.distanceM < 1120, 'admins may need it to move the point');
  assert.ok(env.rows('Rejected').every((r) => typeof r[9] === 'number'), 'the Sheet keeps exact distances');
});

test('distance: after 10 out-of-range answers in a session, a member only hears in or out', () => {
  const env = setup();
  env.start(ADMIN);
  const near = { lat: SITE.lat + 0.003, lng: SITE.lng, accuracy: 20 }; // ~330 m
  for (let i = 0; i < 10; i++) assert.equal(env.checkin(MEMBER, near).data.distanceM, 350);
  const res = env.checkin(MEMBER, near);
  assert.equal(res.code, 'OUT_OF_RANGE');
  assert.equal(res.data.distanceM, null);
  assert.equal(res.data.beyondM, undefined);
  assert.match(res.message, /not within 150 m/);
  assert.equal(env.checkin(MEMBER, ONSITE).code, 'CHECKED_IN', 'still able to check in');
  assert.equal(env.checkin(MEMBER2, near).data.distanceM, 350, 'counted per person');
});

// ---------- the group announcement ----------

test('start: announces in the group with the button, and records the message', () => {
  const env = setup();
  const res = env.start(ADMIN);
  assert.equal(res.code, 'SESSION_STARTED');
  assert.equal(res.data.warning, undefined);
  const [post] = env.visible();
  assert.match(post.text, /Check-in is open until 11:30/);
  assert.deepEqual(post.buttons, [{ text: '📍 Check in', url: 'https://t.me/test_checkin_bot/checkin' }]);
  assert.equal(env.rows('Sessions')[0][5], post.messageId);
});

test('start: the announcement replaces an earlier /checkin button', () => {
  const env = hooked();
  env.say(MEMBER, '/checkin');
  env.start(ADMIN);
  assert.equal(buttons(env).length, 1);
  assert.match(buttons(env)[0].text, /open until/);
});

test('start: MINI_APP_LINK without https:// still works', () => {
  const env = setup({ config: { MINI_APP_LINK: 't.me/test_checkin_bot/checkin' } });
  env.start(ADMIN);
  assert.equal(env.visible()[0].buttons[0].url, 'https://t.me/test_checkin_bot/checkin');
});

test('start: if the group can\'t be told, the check-in still opens and the admin gets the link to share', () => {
  const env = setup({ telegram: { sendMessage: () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' }) } });
  const res = env.start(ADMIN);
  assert.equal(res.code, 'SESSION_STARTED');
  assert.match(res.data.warning, /isn’t in the group/);
  assert.equal(res.data.shareLink, 'https://t.me/test_checkin_bot/checkin');
  assert.equal(env.rows('Sessions').length, 1);

  const noLink = setup({ config: { MINI_APP_LINK: '' } });
  const r2 = noLink.start(ADMIN);
  assert.equal(r2.code, 'SESSION_STARTED');
  assert.match(r2.data.warning, /MINI_APP_LINK/);
  assert.equal(r2.data.shareLink, undefined);
});

test('start: Telegram being unreachable does not fail the start', () => {
  const env = setup({ telegram: { sendMessage: () => { throw new Error('Address unavailable'); } } });
  const res = env.start(ADMIN);
  assert.equal(res.code, 'SESSION_STARTED');
  assert.ok(res.data.warning);
});

test('start: the announcement is sent outside the lock', () => {
  const env = setup();
  env.events.length = 0;
  env.start(ADMIN);
  let inLock = false;
  for (const e of env.events) {
    if (e.type === 'lock') inLock = true;
    if (e.type === 'unlock') inLock = false;
    if (e.type === 'fetch') assert.equal(inLock, false, 'network call while holding the lock: ' + e.url.replace(TOKEN, '<token>'));
  }
});

// ---------- the close job ----------

test('close: after closes_at the button becomes the result, counted by group', () => {
  const env = hooked({ groups: ['Alpha', 'Bravo', 'Charlie'] });
  env.start(ADMIN);
  env.saveProfile(MEMBER, 'Cy Tan', 'Bravo');
  env.saveProfile(MEMBER2, 'Di Lim', 'Alpha');
  env.checkin(MEMBER);
  env.checkin(MEMBER2);
  env.checkin(ADMIN);
  env.checkin({ id: 424242, first_name: 'Nameless' });
  env.saveProfile({ id: 434343, first_name: 'Late' }, 'Late Comer', 'Bravo');
  env.checkin({ id: 434343, first_name: 'Late' });

  env.setNow(T0 + 59 * MIN);
  env.call('closeExpiredSessions');
  assert.equal(env.rows('Sessions')[0][6], 'open', 'not before closes_at');

  env.setNow(T0 + 62 * MIN);
  env.call('closeExpiredSessions');
  const s = env.rows('Sessions')[0];
  assert.deepEqual([s[6], s[7]], ['closed', 5]);
  const [result] = env.visible();
  assert.equal(result.text, 'Check-in closed at 11:30 · 5 checked in\nAlpha 1 · Bravo 2 · No group 2');
  assert.deepEqual(result.buttons, [], 'the button is gone');

  env.call('closeExpiredSessions');
  assert.equal(env.calls('editMessageText').length, 1, 'closing is done once');
});

test('close: the count is recounted from the Log (a hand-edited count is corrected)', () => {
  const env = setup();
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.sheet('Sessions').getRange(2, 8).setValue(40);
  env.setNow(T0 + 61 * MIN);
  env.call('closeExpiredSessions');
  assert.equal(env.rows('Sessions')[0][7], 1);
  assert.equal(env.visible()[0].text, 'Check-in closed at 11:30 · 1 checked in');
});

test('close: back-to-back sessions — the old result never overwrites the new session\'s button', () => {
  const env = hooked();
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.setNow(T0 + 62 * MIN); // A closed at 11:30; B starts at 11:32, before the job has run
  assert.equal(env.start(ADMIN2).code, 'SESSION_STARTED');
  env.setNow(T0 + 64 * MIN);
  env.call('closeExpiredSessions');
  const live = buttons(env);
  assert.equal(live.length, 1, 'B\'s button survives');
  assert.match(live[0].text, /open until 12:32/);
  assert.ok(env.visible().some((m) => m.text === 'Check-in closed at 11:30 · 1 checked in'), 'A\'s result is posted separately');
  env.setNow(T0 + 125 * MIN);
  env.call('closeExpiredSessions');
  assert.equal(buttons(env).length, 0);
  assert.ok(env.visible().some((m) => m.text === 'Check-in closed at 12:32 · nobody checked in'));
});

test('close: a /checkin button posted while nothing was open is not taken as the result', () => {
  const env = hooked();
  env.start(ADMIN);
  env.setNow(T0 + 61 * MIN);
  env.say(MEMBER, '/checkin'); // after closes_at, before the job: "No check-in is open"
  env.setNow(T0 + 63 * MIN);
  env.call('closeExpiredSessions');
  assert.equal(buttons(env).length, 1, 'the /checkin button stays usable');
  assert.ok(env.visible().some((m) => /Check-in closed at 11:30/.test(m.text)));
});

test('close: nobody checked in / button deleted by someone -> a fresh result message', () => {
  const env = setup();
  env.start(ADMIN);
  env.chat[0].deleted = true;
  env.setNow(T0 + 61 * MIN);
  env.call('closeExpiredSessions');
  const [post] = env.visible();
  assert.equal(post.text, 'Check-in closed at 11:30 · nobody checked in');
  assert.deepEqual(post.buttons, []);
});

test('close: sessions that ended long ago (e.g. before the job existed) close quietly', () => {
  const env = setup();
  env.start(ADMIN);
  env.setNow(T0 + 3 * 60 * MIN);
  env.call('closeExpiredSessions');
  assert.equal(env.rows('Sessions')[0][6], 'closed');
  assert.equal(env.calls('editMessageText').length + env.calls('sendMessage').length, 1, 'only the original announcement');
});

test('close: a problem is logged, never thrown (a trigger failure would email the owner every 5 minutes)', () => {
  const env = setup();
  env.start(ADMIN);
  env.sheet('Sessions').cells.set('1:4', 'renamed');
  env.setNow(T0 + 61 * MIN);
  assert.doesNotThrow(() => env.call('closeExpiredSessions'));
  assert.ok(env.logs.some((l) => l.level === 'error' && /closeExpiredSessions/.test(l.text)));
});

// ---------- groups and full names ----------

test('profile: first check-in -> no profile yet; saving one fills the Members tab and today\'s Log row', () => {
  const env = setup({ groups: ['Alpha', 'Bravo'] });
  env.start(ADMIN);
  const res = env.checkin(MEMBER);
  assert.deepEqual([res.data.groups, res.data.profile], [['Alpha', 'Bravo'], null]);

  const saved = env.saveProfile(MEMBER, '  Cy   Tan ', 'Bravo');
  assert.equal(saved.code, 'PROFILE_SAVED');
  assert.deepEqual(saved.data.profile, { fullName: 'Cy Tan', group: 'Bravo' });
  const [m] = env.rows('Members');
  assert.deepEqual(m.slice(0, 5), [String(MEMBER.id), 'Cy Tan', 'Bravo', 'Cy Member', 'cy']);
  assert.equal(m[5].getTime(), T0);
  assert.deepEqual(env.rows('Log')[0].slice(11, 13), ['Cy Tan', 'Bravo']);
});

test('profile: remembered, so the next check-in is filed straight away', () => {
  const env = setup({ groups: ['Alpha', 'Bravo'] });
  env.saveProfile(MEMBER, 'Cy Tan', 'Alpha');
  env.start(ADMIN);
  const res = env.checkin(MEMBER);
  assert.deepEqual(res.data.profile, { fullName: 'Cy Tan', group: 'Alpha' });
  assert.deepEqual(env.rows('Log')[0].slice(11, 13), ['Cy Tan', 'Alpha']);
  assert.deepEqual(env.checkin(MEMBER).data.profile, { fullName: 'Cy Tan', group: 'Alpha' }, 'also on ALREADY_CHECKED_IN');
  // Changing it later updates the Members row, not a second one.
  env.saveProfile(MEMBER, 'Cy Tan', 'Bravo');
  assert.equal(env.rows('Members').length, 1);
  assert.deepEqual(env.rows('Log')[0].slice(11, 13), ['Cy Tan', 'Bravo']);
});

test('profile: status shows it to someone already checked in, and only then', () => {
  const env = setup({ groups: ['Alpha'] });
  env.saveProfile(MEMBER, 'Cy Tan', 'Alpha');
  env.start(ADMIN);
  assert.equal(env.req('status', MEMBER).data.profile, undefined);
  env.checkin(MEMBER);
  const s = env.req('status', MEMBER).data;
  assert.deepEqual([s.groups, s.profile], [['Alpha'], { fullName: 'Cy Tan', group: 'Alpha' }]);
});

test('profile: the group must be on the Groups tab; a removed group is asked for again', () => {
  const env = setup({ groups: ['Alpha', 'Bravo'] });
  for (const g of ['Delta', '', undefined, 3, 'alpha']) {
    const r = env.saveProfile(MEMBER, 'Cy Tan', g);
    assert.equal(r.code, 'INVALID_GROUP', String(g));
    assert.deepEqual(r.data.groups, ['Alpha', 'Bravo']);
  }
  assert.equal(env.rows('Members').length, 0);
  env.saveProfile(MEMBER, 'Cy Tan', 'Bravo');
  env.sheet('Groups').getRange(3, 1).setValue('Bravo Team'); // the owner renames it
  env.start(ADMIN);
  assert.deepEqual(env.checkin(MEMBER).data.profile, { fullName: 'Cy Tan', group: '' });
  assert.equal(env.rows('Log')[0][12], '');
});

test('profile: names must be real text of sensible length; odd characters are cleaned', () => {
  const env = setup({ groups: ['Alpha'] });
  for (const name of ['', '   ', undefined, 42, { a: 1 }, 'x'.repeat(61)]) {
    assert.equal(env.saveProfile(MEMBER, name, 'Alpha').code, 'INVALID_NAME', JSON.stringify(name));
  }
  assert.equal(env.saveProfile(MEMBER, 'x'.repeat(60), 'Alpha').code, 'PROFILE_SAVED');
  const r = env.saveProfile(MEMBER, 'Wei‮Ling\nTan  李', 'Alpha');
  assert.equal(r.data.profile.fullName, 'Wei Ling Tan 李');
  assert.equal(env.saveProfile(MEMBER, 'Zoë 🙂 O\'Neil', 'Alpha').data.profile.fullName, 'Zoë 🙂 O\'Neil');
});

test('profile: names and groups are stored as text (no formulas), and odd group names round-trip', () => {
  const env = setup({ groups: ["'-A team", "'=Leaders", '1'] }); // as the owner would type them (text)
  env.start(ADMIN);
  env.checkin(MEMBER);
  env.saveProfile(MEMBER, '=HYPERLINK("http://evil.example","x")', '-A team');
  env.saveProfile(MEMBER2, 'Di', '1');
  assert.deepEqual(env.formulaWrites, []);
  assert.deepEqual(env.rows('Log')[0].slice(11, 13), ["'=HYPERLINK(\"http://evil.example\",\"x\")", '-A team']);
  env.setNow(T0 + 61 * MIN);
  env.start(ADMIN);
  assert.equal(env.checkin(MEMBER).data.profile.group, '-A team', 'still matches the Groups tab');
  assert.equal(env.checkin(MEMBER2).data.profile.group, '1');
});

test('profile: only group members can save one', () => {
  const env = setup({ groups: ['Alpha'], statuses: { [OUTSIDER.id]: 'left' } });
  assert.equal(env.saveProfile(OUTSIDER, 'Ed Out', 'Alpha').code, 'NOT_MEMBER');
  assert.equal(env.rows('Members').length, 0);
});

test('profile: with no groups defined, only the name is kept', () => {
  const env = setup();
  const r = env.saveProfile(MEMBER, 'Cy Tan', 'Anything');
  assert.equal(r.code, 'PROFILE_SAVED');
  assert.deepEqual(r.data, { groups: [], profile: { fullName: 'Cy Tan', group: '' } });
});

test('profile: the Groups tab is read as the owner typed it (blanks, repeats, spaces)', () => {
  const env = setup();
  const g = env.sheet('Groups');
  ['Alpha', '', '  Bravo  ', 'Alpha', 'Charlie'].forEach((v) => g.appendRow([v]));
  assert.deepEqual(env.saveProfile(MEMBER, 'Cy', 'Nope').data.groups, ['Alpha', 'Bravo', 'Charlie']);
});

test('profile: a Members id the owner retyped as a number is still found', () => {
  const env = setup({ groups: ['Alpha'] });
  env.saveProfile(MEMBER, 'Cy Tan', 'Alpha');
  env.sheet('Members').getRange(2, 1).setValue(MEMBER.id);
  env.start(ADMIN);
  assert.deepEqual(env.checkin(MEMBER).data.profile, { fullName: 'Cy Tan', group: 'Alpha' });
});

// ---------- setup() ----------

test('setup(): webhook with a secret, command menu, one close job, bot username', () => {
  const env = setup();
  env.call('setup');
  const secret = env.props.WEBHOOK_SECRET;
  assert.match(secret, /^[0-9a-f]{64}$/);
  const [hook] = env.calls('setWebhook');
  assert.equal(hook.url, 'https://script.google.com/macros/s/AKfycbz9ACA6aEHOyvUXNp38ty_ANlMjeDucefyH_mXjXHTGU8AaRKxVBX6jTgnYE9Wahehz/exec?hook=' + secret);
  assert.deepEqual(hook.allowed_updates, ['message', 'my_chat_member', 'chat_member']);
  assert.deepEqual(env.calls('setMyCommands').map((c) => c.scope.type), ['all_group_chats', 'default']);
  assert.equal(env.calls('setMyCommands')[0].commands[0].command, 'checkin');
  assert.deepEqual(env.triggers.map((t) => [t.handler, t.everyMinutes]), [['closeExpiredSessions', 5]]);
  assert.equal(env.props.BOT_USERNAME, BOT.username);

  env.call('setup');
  assert.equal(env.props.WEBHOOK_SECRET, secret, 'the secret is kept');
  assert.equal(env.triggers.length, 1, 'still one close job');
  assert.equal(env.calls('setWebhook')[1].url, hook.url);
});

test('setup(): the webhook secret never appears in the logs', () => {
  const env = setup();
  env.call('setup');
  for (const l of env.logs) assert.ok(!l.text.includes(env.props.WEBHOOK_SECRET), l.text);
});

test('setup(): tells the owner what is left to do', () => {
  let env = setup({ config: { GROUP_CHAT_ID: '' } });
  env.call('setup');
  const text = env.logs.map((l) => l.text).join('\n');
  assert.match(env.props.CONNECT_CODE, /^[0-9a-f]{32}$/);
  assert.match(text, /open this link on your phone and pick your group/i);
  assert.ok(text.includes('https://t.me/test_checkin_bot?startgroup=' + env.props.CONNECT_CODE + '&admin=delete_messages'));
  assert.match(text, /Groups tab/);

  env = setup({ groups: ['Alpha', 'Bravo'] });
  env.call('setup');
  const ok = env.logs.map((l) => l.text).join('\n');
  assert.match(ok, /is connected and the bot is an admin/);
  assert.match(ok, /Alpha, Bravo/);
});

test('setup(): a rejected BOT_TOKEN or webhook fails loudly', () => {
  let env = setup({ telegram: { getMe: () => ({ ok: false, error_code: 401, description: 'Unauthorized' }) } });
  assert.throws(() => env.call('setup'), /BOT_TOKEN/);
  env = setup({ telegram: { setWebhook: () => ({ ok: false, error_code: 400, description: 'Bad Request: bad webhook' }) } });
  assert.throws(() => env.call('setup'), /refused the webhook/);
});

test('setupSheets(): an existing Sheet from the first version gains the new columns and tabs, data untouched', () => {
  const env = createEnv({ props: { BOT_TOKEN: TOKEN } });
  const ss = env.ss;
  const old = {
    Config: [['key', 'value'], ['SITE_LAT', '1.3'], ['GROUP_CHAT_ID', "'" + BASIC_GROUP], ['ADMIN_IDS', '159911700']],
    Sessions: [['session_id', 'started_by_id', 'started_by_name', 'opens_at', 'closes_at', 'announcement_message_id', 'status', 'checkin_count'],
      ['S-20260921-2205', 159911700, 'Howard', new Date(T0), new Date(T0 + 2 * MIN), '', 'open', 1]],
    Log: [['timestamp', 'session_id', 'user_id', 'first_name', 'last_name', 'username', 'latitude', 'longitude', 'accuracy_m', 'distance_m', 'dedupe_key'],
      [new Date(T0), 'S-20260921-2205', 159911700, 'Howard', '', 'Howiiee', 1.3176, 103.78, 11.1, 32.6, 'S-20260921-2205:159911700']],
    Rejected: [['timestamp', 'session_id', 'user_id', 'name', 'username', 'reason', 'latitude', 'longitude', 'accuracy_m', 'distance_m']],
  };
  for (const [name, rows] of Object.entries(old)) {
    const sheet = ss.insertSheet(name);
    rows.forEach((r) => sheet.appendRow(r));
  }
  // Before setupSheets runs, requests say what to do.
  env.props.SPREADSHEET_ID = ss.getId();
  env.setNow(T0);
  assert.throws(() => env.eval('readSessions_()'), /run setup\(\) once/);

  env.call('setupSheets');
  assert.deepEqual(env.sheet('Sessions').getRange(1, 1, 1, 11).getValues()[0].slice(8), ['site_lat', 'site_lng', 'site_accuracy_m']);
  assert.deepEqual(env.sheet('Log').getRange(1, 1, 1, 13).getValues()[0].slice(11), ['full_name', 'group']);
  assert.deepEqual(env.sheet('Sessions').rows()[0].slice(0, 8), old.Sessions[1]);
  assert.deepEqual(env.sheet('Log').rows()[0].slice(0, 11), old.Log[1]);
  assert.ok(env.sheet('Groups') && env.sheet('Members'));
  const cfg = env.sheet('Config').rows();
  assert.equal(cfg.find((r) => r[0] === 'GROUP_CHAT_ID')[1], BASIC_GROUP);
  assert.equal(String(cfg.find((r) => r[0] === 'ADMIN_IDS')[1]), '159911700');
  assert.ok(cfg.find((r) => r[0] === 'MINI_APP_LINK'), 'missing keys are added');
  assert.ok(env.logs.some((l) => /SITE_LAT is no longer used/.test(l.text)));
  assert.doesNotThrow(() => env.eval('readSessions_()'));
});
