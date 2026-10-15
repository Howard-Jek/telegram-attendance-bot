/**
 * The Nominal Roll: the owner's list of everyone whose attendance is taken, on a tab named
 * "Nominal Roll" (any capitals; "Nominal Role" works too) with a column headed "Name" or
 * "Full name". The close job (and a new check-in) colours each row by the newest check-in:
 * green on time, yellow late, red not checked in once the on-time window has closed, and no
 * colour before then. A column it adds on the right, headed "Latest check-in: <tab name>", says
 * the same in words, for anyone who can't tell the colours apart. Nothing else on the tab is
 * changed. Names match ignoring capitals, punctuation, spacing, word order and a rank typed in
 * front of the name (nameKey_).
 */

const ROLL_COLOURS_ = { onTime: '#d9ead3', late: '#fff2cc', absent: '#f4cccc' }; // Sheets' light green, yellow, red
const ROLL_STATUS_HEADER_ = 'Latest check-in';
// Singapore Armed Forces ranks, as people type them in front of their names.
const RANK_WORDS_ = ['rec', 'pte', 'pfc', 'lcp', 'cpl', 'cfc', '3sg', '2sg', '1sg', 'ssg', 'msg', '3wo', '2wo', '1wo',
  'mwo', 'swo', 'cwo', 'oct', '2lt', 'lta', 'cpt', 'maj', 'ltc', 'sltc', 'col', 'bg', 'mg', 'lg',
  'me1', 'me2', 'me3', 'me4', 'me5', 'me6', 'me7', 'me8', 'dxo'];

/** The words of a name, lower case, sorted, without punctuation or a leading rank ('' for none). */
function nameKey_(text) {
  const words = String(text || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    .split(' ').filter(Boolean);
  if (words.length > 1 && RANK_WORDS_.indexOf(words[0]) !== -1) words.shift();
  return words.sort().join(' ');
}

function findRollSheet_() {
  return spreadsheet_().getSheets().find((s) => /^nominal\s+rol[le]$/i.test(s.getName().trim())) || null;
}

/**
 * {sheet, statusCol, width, keys: [name key per data row], keySet: {key: true}}, or null when there
 * is no usable Nominal Roll tab (a missing Name column is logged, at most once an hour).
 */
function readRoll_() {
  const sheet = findRollSheet_();
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return null;
  const lastCol = sheet.getLastColumn();
  const values = sheet.getRange(1, 1, sheet.getLastRow(), lastCol).getValues();
  const header = values[0].map((h) => String(h).trim());
  const nameCol = header.findIndex((h) => /^(full\s*)?name$/i.test(h)) + 1;
  if (!nameCol) {
    warnOnce_('roll-no-name', 'The ' + sheet.getName() + ' tab has no column headed "Name" or "Full name", so it isn’t coloured.');
    return null;
  }
  const found = header.findIndex((h) => h.toLowerCase().indexOf(ROLL_STATUS_HEADER_.toLowerCase()) === 0) + 1;
  const statusCol = found || lastCol + 1;
  const keys = values.slice(1).map((r) => nameKey_(r[nameCol - 1]));
  const keySet = {};
  keys.forEach((k) => { if (k) keySet[k] = true; });
  return { sheet: sheet, statusCol: statusCol, width: Math.max(lastCol, statusCol), keys: keys, keySet: keySet };
}

/** Colours the roll and writes its status column for session, from its check-ins (tallyLog_ people). */
function writeRollColours_(roll, session, people, nowMs) {
  // Each name's check-in: on time beats late (someone could check in twice under one name).
  const best = {};
  people.forEach((p) => {
    const k = nameKey_(p.fullName);
    if (!k || !roll.keySet[k]) return;
    const cur = best[k];
    if (!cur || (cur.minutesLate && !p.minutesLate)) best[k] = p;
  });
  const onTimeOver = nowMs >= session.closesAt.getTime();
  const words = [];
  const colours = [];
  roll.keys.forEach((k) => {
    let text = '';
    let colour = null;
    if (k) {
      const p = best[k];
      if (p && !p.minutesLate) {
        text = 'On time ' + hhmm_(p.at);
        colour = ROLL_COLOURS_.onTime;
      } else if (p) {
        text = 'Late ' + hhmm_(p.at) + ' (' + p.minutesLate + ' min)';
        colour = ROLL_COLOURS_.late;
      } else if (onTimeOver) {
        text = 'Not checked in';
        colour = ROLL_COLOURS_.absent;
      } else {
        text = 'Not yet';
      }
    }
    words.push([text]);
    colours.push(Array(roll.width).fill(colour));
  });
  const sheet = roll.sheet;
  if (sheet.getMaxColumns() < roll.width) sheet.insertColumnsAfter(sheet.getMaxColumns(), roll.width - sheet.getMaxColumns());
  sheet.getRange(1, roll.statusCol).setValue(ROLL_STATUS_HEADER_ + ': ' + sessionTabName_(session));
  if (!roll.keys.length) return;
  sheet.getRange(2, roll.statusCol, roll.keys.length, 1).setValues(words);
  sheet.getRange(2, 1, roll.keys.length, roll.width).setBackgrounds(colours);
}

function warnOnce_(key, text) {
  const cache = CacheService.getScriptCache();
  if (cache.get('warned:' + key)) return;
  cache.put('warned:' + key, '1', 3600);
  console.warn(text);
}
