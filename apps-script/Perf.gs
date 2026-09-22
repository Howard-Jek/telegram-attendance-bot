/**
 * TEMPORARY diagnostics (2026-09-22): where each request's time goes. Every Mini App request, the
 * relevant webhook updates and the close job append one row to a "Perf" tab: the step timings,
 * the result, and any failures the Mini App reported from its previous requests. Remove this
 * file and its perf*_ calls once the slowness is understood.
 */

let PERF_ON_ = true; // tests switch this off
let PERF_ = null;

function perfBegin_(label) {
  PERF_ = PERF_ON_ ? { label: label, t0: Date.now(), marks: [], extra: {} } : null;
}

/** Time since the request started, under a name. */
function perfMark_(name) {
  if (PERF_) PERF_.marks.push(name + '=' + (Date.now() - PERF_.t0));
}

function perfNote_(key, value) {
  if (PERF_) PERF_.extra[key] = value;
}

/** Appends the row; never throws (it runs on the way out of doPost). */
function perfEnd_(code) {
  const p = PERF_;
  PERF_ = null;
  if (!p) return;
  try {
    const total = Date.now() - p.t0;
    const ss = spreadsheet_();
    const sheet = ss.getSheetByName('Perf') || ss.insertSheet('Perf');
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['server_start', 'what', 'code', 'total_ms', 'steps (ms since start)', 'details']);
    }
    sheet.appendRow([new Date(p.t0), p.label, code || '', total, p.marks.join('  '),
      textCell_(JSON.stringify(p.extra).slice(0, 2000))]);
  } catch (e) {
    console.warn('perf: ' + redactSecrets_(String(e)));
  }
}
