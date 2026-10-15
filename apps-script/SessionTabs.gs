/**
 * A tab for each check-in, named by its start time ("19 Oct 2026 0830") and listing who checked
 * in, grouped by the Groups tab's order. It is made when the check-in starts, refreshed by the
 * close job every 5 minutes while it is open (so check-ins never wait on it), and written a last
 * time when it closes; after that it is left alone. Until that last write succeeds the session is
 * marked TAB_PENDING:<id> in Script Properties, so a failed one is tried again on the next run. Each tab is tagged with its session's id, so
 * the owner can rename it, and a tab of their own with the same name is never written to.
 */

const SESSION_TAB_KEY_ = 'checkinSessionId';
const SESSION_TAB_COLUMNS_ = ['Group', 'Rank and full name', 'Checked in at', 'Telegram name', 'Username'];
const SESSION_TAB_HEAD_ROWS_ = 5; // title, count, status, blank, column names
const TAB_PENDING_PREFIX_ = 'TAB_PENDING:';
const TAB_PENDING_GIVE_UP_MS_ = 24 * 60 * 60 * 1000;

/**
 * Call with the script lock held. Marks the sessions closing now as needing their final tab, and
 * returns every closed session still needing one (a session deleted by hand, or closed more than
 * a day ago, is dropped, with a log line for the latter).
 */
function pendingFinalTabs_(sessions, closingNow, nowMs) {
  const props = PropertiesService.getScriptProperties();
  closingNow.forEach((s) => props.setProperty(TAB_PENDING_PREFIX_ + s.id, '1'));
  const byId = {};
  sessions.forEach((s) => { byId[s.id] = s; });
  const out = [];
  props.getKeys().forEach((k) => {
    if (k.indexOf(TAB_PENDING_PREFIX_) !== 0) return;
    const s = byId[k.slice(TAB_PENDING_PREFIX_.length)];
    if (s && nowMs - s.closesAt.getTime() <= TAB_PENDING_GIVE_UP_MS_) {
      out.push(s);
      return;
    }
    if (s) console.warn('Gave up writing the final list on the tab of ' + s.id + '; the Log has every check-in.');
    props.deleteProperty(k);
  });
  return out;
}

function finalTabWritten_(sessionId) {
  PropertiesService.getScriptProperties().deleteProperty(TAB_PENDING_PREFIX_ + sessionId);
}

function sessionTabName_(session) {
  return Utilities.formatDate(session.opensAt, TZ_, 'd MMM yyyy HHmm');
}

/** The session's tab, found by its tag (so renaming it is fine), or null. */
function findSessionTab_(sessionId) {
  const found = spreadsheet_().createDeveloperMetadataFinder()
    .withKey(SESSION_TAB_KEY_).withValue(String(sessionId)).find();
  for (let i = 0; i < found.length; i++) {
    const where = found[i].getLocation();
    if (String(where.getLocationType()) === 'SHEET') return where.getSheet();
  }
  return null;
}

/**
 * The session's tab, made as the first tab if it doesn't exist. Call with the script lock held,
 * so two callers can't both make one.
 */
function ensureSessionTab_(session) {
  const existing = findSessionTab_(session.id);
  if (existing) return existing;
  const ss = spreadsheet_();
  const base = sessionTabName_(session);
  let name = base;
  for (let n = 1; ss.getSheetByName(name); n++) name = base + (n === 1 ? ' (check-in)' : ' (check-in ' + n + ')');
  const sheet = ss.insertSheet(name, 0);
  sheet.addDeveloperMetadata(SESSION_TAB_KEY_, String(session.id), SpreadsheetApp.DeveloperMetadataVisibility.PROJECT);
  // A new tab has 26 columns and 1,000 rows; a spreadsheet holds at most 10 million cells in all.
  sheet.deleteColumns(SESSION_TAB_COLUMNS_.length + 1, sheet.getMaxColumns() - SESSION_TAB_COLUMNS_.length);
  sheet.setFrozenRows(SESSION_TAB_HEAD_ROWS_);
  sheet.getRange(1, 1).setFontWeight('bold');
  sheet.getRange(SESSION_TAB_HEAD_ROWS_, 1, 1, SESSION_TAB_COLUMNS_.length).setFontWeight('bold');
  sheet.setColumnWidths(1, SESSION_TAB_COLUMNS_.length, 170);
  return sheet;
}

/**
 * Rewrites the whole tab. people: rows from tallyLog_ ({at, userId, fullName, group, firstName,
 * lastName, username}); final: the check-in has closed. Text from members is written as text.
 */
function writeSessionTab_(sheet, session, people, groupOrder, final) {
  const seen = {};
  const unique = people.filter((p) => (seen[p.userId] ? false : (seen[p.userId] = true)));
  const counts = {};
  unique.forEach((p) => { counts[p.group] = (counts[p.group] || 0) + 1; });
  const order = groupBreakdownOrder_(counts, groupOrder);
  const rank = (g) => (g === '' ? order.length : order.indexOf(g));
  unique.sort((a, b) => rank(a.group) - rank(b.group) || a.at.getTime() - b.at.getTime());

  const breakdown = groupBreakdown_(counts, groupOrder);
  const count = unique.length;
  const summary = count
    ? count + ' checked in' + (breakdown.length ? ' · ' + breakdown.join(' · ') : '')
    : (final ? 'Nobody checked in.' : 'Nobody has checked in yet.');
  const status = final
    ? 'Final list: the check-in closed at ' + hhmm_(session.closesAt) + '.'
    : 'Updates every 5 minutes until the check-in closes at ' + hhmm_(session.closesAt) + '.';
  const title = 'Check-in on ' + Utilities.formatDate(session.opensAt, TZ_, 'd MMM yyyy') + ', ' +
    hhmm_(session.opensAt) + ' to ' + hhmm_(session.closesAt) + ' · started by ' + session.startedByName;
  const line = (text) => [text, '', '', '', ''];
  const block = [line(title), line(summary), line(status), line(''), SESSION_TAB_COLUMNS_.slice()]
    .concat(unique.map((p) => [
      groupCell_(p.group),
      textCell_(p.fullName),
      p.at,
      textCell_([p.firstName, p.lastName].filter(Boolean).join(' ')),
      // Telegram usernames are letters, digits and _ only, so "@name" can't be read as a formula.
      /^\w+$/.test(p.username) ? "'@" + p.username : textCell_(p.username),
    ]));

  // Exactly as many rows as needed, plus one (Sheets keeps at least one row below the frozen ones).
  const rows = block.length + 1;
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxRows() > rows) sheet.deleteRows(rows + 1, sheet.getMaxRows() - rows);
  sheet.clearContents();
  sheet.getRange(1, 1, block.length, SESSION_TAB_COLUMNS_.length).setValues(block);
  if (unique.length) sheet.getRange(SESSION_TAB_HEAD_ROWS_ + 1, 3, unique.length, 1).setNumberFormat('HH:mm');
}
