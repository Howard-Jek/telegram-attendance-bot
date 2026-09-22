/**
 * Groups and full names. The owner lists the groups on the Groups tab; each member picks theirs
 * and gives their full name once in the Mini App. Both are kept on the Members tab (where an
 * admin can correct them) and copied onto every Log row, so the Log reads by real name and group.
 */

const MAX_NAME_CHARS_ = 60;
const MAX_GROUP_CHARS_ = 100;
const MAX_GROUPS_ = 50;

/**
 * {groups, profile} for the Mini App and the Log row. profile is null until the member saves one;
 * a group that is no longer on the Groups tab reads as '' (so they are asked again).
 */
function profileData_(userId) {
  const groups = readGroups_();
  const saved = savedProfile_(userId);
  const profile = saved
    ? { fullName: saved.fullName, group: groups.indexOf(saved.group) === -1 ? '' : saved.group }
    : null;
  return { groups: groups, profile: profile };
}

function handleSaveProfile_(ctx, body) {
  const cfg = ctx.cfg;
  const user = ctx.user;
  assertConfig_(cfg, ['GROUP_CHAT_ID']);
  // Only group members may write to the Members tab, so it can't grow beyond the group.
  const role = cachedGroupRole_(ctx.token, cfg, user.id);
  if (role === 'BUSY') return reply_(false, 'BUSY', MESSAGES_.BUSY);
  if (role !== 'MEMBER' && role !== 'ADMIN') return reply_(false, 'NOT_MEMBER', MESSAGES_.NOT_MEMBER);

  const fullName = cleanText_(body.fullName, MAX_NAME_CHARS_);
  if (!fullName) {
    return reply_(false, 'INVALID_NAME', 'Please enter your full name (up to ' + MAX_NAME_CHARS_ + ' characters).');
  }
  const groups = readGroups_();
  let group = cleanText_(body.group, MAX_GROUP_CHARS_);
  if (groups.length && groups.indexOf(group) === -1) {
    return reply_(false, 'INVALID_GROUP', 'That group isn’t on the list any more. Please pick one again.', { groups: groups });
  }
  if (!groups.length) group = '';

  const result = withScriptLock_(() => {
    const now = now_();
    upsertMember_(user, fullName, group, now);
    // Already checked in to the open session? That Log row gets the new details too.
    const sessions = readSessions_();
    cacheSessions_(sessions, now.getTime());
    const session = findActiveSession_(sessions, now.getTime());
    const mine = session ? findCheckin_(dedupeKey_(session.id, user.id)) : null;
    if (mine) {
      sheet_(SHEETS_.LOG).getRange(mine.row, LOG_COL_.FULL_NAME, 1, 2).setValues([[textCell_(fullName), groupCell_(group)]]);
    }
    return reply_(true, 'PROFILE_SAVED', 'Saved.', { groups: groups, profile: { fullName: fullName, group: group } });
  });
  return result || reply_(false, 'BUSY', MESSAGES_.BUSY);
}

/**
 * The Groups tab, top to bottom, as the owner typed it (display values, so "1" stays "1").
 * Row 1 is skipped only if it still reads "group", so a list typed from the top still counts.
 */
function readGroups_() {
  const copy = cacheGetJson_('groups');
  if (Array.isArray(copy)) return copy;
  const sheet = sheet_(SHEETS_.GROUPS);
  const last = sheet.getLastRow();
  const out = [];
  if (last < 1) {
    cachePutJson_('groups', out, CACHE_SEC_.GROUPS);
    return out;
  }
  sheet.getRange(1, 1, last, 1).getDisplayValues().forEach((r, i) => {
    const g = cleanText_(r[0], MAX_GROUP_CHARS_);
    if (!g || (i === 0 && g.toLowerCase() === HEADERS_.Groups[0])) return;
    if (out.indexOf(g) === -1 && out.length < MAX_GROUPS_) out.push(g);
  });
  cachePutJson_('groups', out, CACHE_SEC_.GROUPS);
  return out;
}

/** {fullName, group} as saved on the Members tab (from a copy up to 10 minutes old), or null. */
function savedProfile_(userId) {
  const key = 'member:' + userId;
  const copy = cacheGetJson_(key);
  if (copy && typeof copy === 'object') return copy.none ? null : copy;
  const found = findMember_(userId);
  const profile = found ? { fullName: found.fullName, group: found.group } : null;
  cachePutJson_(key, profile || { none: true }, CACHE_SEC_.MEMBER);
  return profile;
}

/** The member's saved row, or null. User ids are compared as text, whatever the cell format. */
function findMember_(userId) {
  const sheet = sheet_(SHEETS_.MEMBERS);
  const values = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), HEADERS_.Members.length).getValues();
  assertHeaders_(SHEETS_.MEMBERS, values[0]);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][MEMBER_COL_.USER_ID - 1]).trim() === String(userId)) {
      return {
        row: i + 1,
        fullName: String(values[i][MEMBER_COL_.FULL_NAME - 1]).trim(),
        group: String(values[i][MEMBER_COL_.GROUP - 1]).trim(),
      };
    }
  }
  return null;
}

/** Call with the script lock held. */
function upsertMember_(user, fullName, group, now) {
  const sheet = sheet_(SHEETS_.MEMBERS);
  const fields = [textCell_(fullName), groupCell_(group), textCell_(user.name), textCell_(user.username), now];
  const found = findMember_(user.id);
  if (found) {
    sheet.getRange(found.row, MEMBER_COL_.FULL_NAME, 1, fields.length).setValues([fields]);
  } else {
    sheet.appendRow(["'" + user.id].concat(fields)); // text, so the id is found whatever the column format
  }
  SpreadsheetApp.flush(); // copy only what is really saved
  cachePutJson_('member:' + user.id, { fullName: fullName, group: group }, CACHE_SEC_.MEMBER);
}

/**
 * A group name, stored exactly as it appears on the Groups tab so it matches again when read
 * back (textCell_ would add a visible apostrophe to names like "-A team"). Group names come
 * only from the owner's own tab.
 */
function groupCell_(group) {
  return group ? "'" + group : '';
}

/**
 * Text a person typed: NFC, control and bidi-override characters removed, whitespace collapsed.
 * Returns '' for a non-string or anything longer than max characters (not truncated: a cut-off
 * name is worse than asking again).
 */
function cleanText_(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).length <= max ? s : '';
}
