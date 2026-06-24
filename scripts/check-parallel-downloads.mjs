#!/usr/bin/env node
/**
 * scripts/check-parallel-downloads.mjs
 *
 * Static structural lint: verifies that batch-download call sites appear
 * inside a `Promise.all(…)` wrapper rather than running serially.
 *
 * This guard complements timing-sensitive perf tests that are skipped on CI.
 * A refactor from `Promise.all(keys.map(…))` to a serial `for...of` / `await`
 * loop would silently regress download performance; this check catches it
 * structurally without any timing assertions.
 *
 * ── Two complementary detection modes ────────────────────────────────────────
 *
 * 1. TARGETS-based mode (manual enrollment)
 *    Each entry in TARGETS names a specific (file, function) pair to check.
 *    By default (requireParallel: true), every `downloadCall` inside that
 *    function must have a `Promise.all(` opener within the preceding 20 lines.
 *
 *    Set requireParallel: false for single-download utility functions that are
 *    not batch callers.  The check then:
 *      • Verifies the function still exists and still has the download call
 *        (catches renames/removals).
 *      • If exactly 1 call is found → passes (single-item download is fine).
 *      • If ≥ 2 calls are found → enforces Promise.all on all of them, same
 *        as the default behaviour.  This fires the moment a second download
 *        is added without parallel wrapping.
 *    This gives explicit, always-on rename detection without forcing a
 *    semantically-wrong Promise.all wrapper onto a single-item helper.
 *
 *    To enrol a new surface add one entry to TARGETS:
 *      { file: 'path/to/file.js', fn: 'myBatchFunction', downloadCall: 'downloadAsBytes' }
 *    For a single-download utility:
 *      { file: '…', fn: 'myHelper', downloadCall: 'downloadAsBytes', requireParallel: false }
 *
 * 2. Auto-scan mode (zero enrollment)
 *    For every file listed in AUTO_SCAN_FILES the script finds all top-level
 *    functions and flags any that contain ≥ 2 `DOWNLOAD_CALL` invocations
 *    without a `Promise.all(` opener in the preceding 20-line window.
 *    Functions already covered by TARGETS are skipped to avoid double-reporting.
 *    This catches new serial-download functions the moment they are written,
 *    with no manual enrollment step.
 *
 * 3. Self-test
 *    Runs auto-scan against `scripts/fixtures/serial-downloads-fixture.js`
 *    and asserts that the scan detects the intentional serial-download pattern
 *    in that file.  This proves the detection logic works end-to-end.
 *
 * ── Detection logic (per function / target) ──────────────────────────────────
 *   1. Locate the start of the function in the source file.
 *   2. Locate the start of the next top-level `async function` / `function`
 *      after it (or end-of-file) to determine the function body range.
 *   3. For every line in that range that calls `downloadCall`, inspect a
 *      window of up to 20 preceding lines within the same range.  If
 *      `Promise.all(` does not appear in that window, the check fails.
 *
 * Run via:  npm run test:parallel-downloads
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ── TARGETS: manual enrollment ────────────────────────────────────────────────
// Add new batch-download surfaces here.  Each entry must specify:
//   file         — path relative to the project root
//   fn           — name of the top-level function to scan
//   downloadCall — the download helper call to look for (e.g. 'downloadAsBytes')
const TARGETS = [
  // customer-info email-attachments send path:
  // sendAdminNotificationEmail downloads all submitted customer photos in
  // parallel before attaching them to the admin notification email.
  // A regression to a serial for…of / await loop would multiply RTT by the
  // number of attachments (up to 14×).  The timing-sensitive companion is
  // test:customer-info-parallel-downloads; this structural check is the
  // CI-safe alternative enrolled in test:ci.
  {
    file:         'customer-info.js',
    fn:           'sendAdminNotificationEmail',
    downloadCall: 'downloadAsBytes',
  },
  // design-visit-uploads: downloadOpaqueKey is a single-item download helper
  // for visit-related media (room photos, sign-off images, etc.).  It currently
  // holds one downloadAsBytes call that is not batched (single key per call,
  // no Promise.all needed).  requireParallel: false tracks the function
  // explicitly so a rename or removal is caught immediately; if a second
  // downloadAsBytes call is ever added, the check automatically upgrades to
  // enforcing Promise.all on both calls rather than waiting for the auto-scan
  // ≥ 2 heuristic to fire (design-visit-uploads.js is excluded from auto-scan
  // for functions already covered by TARGETS).
  {
    file:            'design-visit-uploads.js',
    fn:              'downloadOpaqueKey',
    downloadCall:    'downloadAsBytes',
    requireParallel: false,
  },
  // design-visit-uploads: downloadOpaqueKeys is the batch download helper for
  // bulk-downloading visit images (e.g. for bulk re-signing or thumbnail
  // generation).  It uses Promise.all(keys.map(…)) to issue all downloadAsBytes
  // calls in parallel, keeping total latency ~1 × RTT regardless of batch size.
  // requireParallel: true enforces that the Promise.all wrapper is never removed
  // or refactored into a serial loop without the test catching it immediately.
  {
    file:            'design-visit-uploads.js',
    fn:              'downloadOpaqueKeys',
    downloadCall:    'downloadAsBytes',
    requireParallel: true,
  },
  // design-visits: resignVisitPhotos is the visit-level bulk re-sign helper.
  // It calls downloadOpaqueKeys exactly once (the batch helper already handles
  // parallelism internally), so requireParallel: false is correct here — we
  // track it only to catch renames/removals and to catch the moment a second
  // downloadOpaqueKeys call is added without wrapping.
  {
    file:            'design-visits.js',
    fn:              'resignVisitPhotos',
    downloadCall:    'downloadOpaqueKeys',
    requireParallel: false,
  },
];

// ── AUTO_SCAN_FILES: zero-enrollment auto-scan ────────────────────────────────
// Files to scan automatically for any top-level function that contains ≥ 2
// `DOWNLOAD_CALL` invocations.  Functions already listed in TARGETS are skipped
// to avoid duplicate output.
const AUTO_SCAN_FILES = [
  'customer-info.js',
  // design-visit-uploads.js has both a single-item helper (downloadOpaqueKey,
  // covered by TARGETS) and a batch helper (downloadOpaqueKeys, also covered by
  // TARGETS with requireParallel: true).  Keeping it in AUTO_SCAN_FILES catches
  // any future third function that gains ≥ 2 downloadAsBytes calls without
  // manual enrollment.
  'design-visit-uploads.js',
  // design-visits.js and photo-reviews.js have no downloadAsBytes calls today
  // but are the most likely modules to gain batch downloads in future; enrol
  // them now so the guard fires the moment a serial pattern is introduced.
  // (resignVisitPhotos is excluded from auto-scan because it is already
  // tracked in TARGETS above with downloadCall: 'downloadOpaqueKeys'.)
  'design-visits.js',
  'photo-reviews.js',
];

// The download helper name used in auto-scan and self-test.
const DOWNLOAD_CALL = 'downloadAsBytes';

// ─────────────────────────────────────────────────────────────────────────────

const TOPLEVEL_FN = /^(?:async\s+)?function\s+(\w+)/;

/**
 * Read a source file and return its lines, or null on error.
 * @param {string} filePath  Absolute path.
 * @param {string} label     Short label used in error messages.
 * @returns {string[]|null}
 */
function readLines(filePath, label) {
  try {
    return readFileSync(filePath, 'utf8').split('\n');
  } catch {
    console.error(
      `❌  parallel-downloads: cannot read \`${label}\`.\n` +
      `   Check that the path is correct.\n`,
    );
    return null;
  }
}

/**
 * Find the 0-based line index where `function <name>` starts, or -1.
 * @param {string[]} lines
 * @param {string}   name
 * @returns {number}
 */
function findFnStart(lines, name) {
  return lines.findIndex(l => l.includes(`function ${name}`));
}

/**
 * Find the 0-based line index (exclusive) of the end of the function that
 * starts at `startIdx`, using brace counting.  Returns `lines.length` if
 * the closing brace is never found (e.g. syntax error or end-of-file).
 *
 * Brace counting ignores string-literal content for simplicity — this is a
 * structural lint running against well-formed server-side JS, so edge cases
 * involving braces inside strings are unlikely to cause false positives in
 * practice.
 *
 * @param {string[]} lines
 * @param {number}   startIdx  0-based index of the function declaration line.
 * @returns {number}           First line index AFTER the closing `}`.
 */
function findFnEnd(lines, startIdx) {
  let depth   = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') depth--;
    }
    if (started && depth === 0) return i + 1;
  }
  return lines.length;
}

/**
 * Check that every line matching `downloadCall` within `fnLines` has a
 * `Promise.all(` opener in the preceding 20 lines.
 *
 * @param {object}   opts
 * @param {string[]} opts.fnLines        Lines of the function body.
 * @param {string}   opts.downloadCall   Token to search for.
 * @param {string}   opts.fnName         Function name (for error messages).
 * @param {string}   opts.file           File label (for error messages).
 * @param {number}   opts.fnStartIdx     0-based start line in the original file
 *                                       (for accurate line numbers in errors).
 * @param {boolean}  [opts.silent=false] Suppress console.error output (used
 *                                       by the self-test which expects failures).
 * @returns {{ failed: boolean, callsFound: number, callsWrapped: number }}
 */
function checkFnLines({ fnLines, downloadCall, fnName, file, fnStartIdx, silent = false }) {
  let failed       = false;
  let callsFound   = 0;
  let callsWrapped = 0;

  for (let i = 0; i < fnLines.length; i++) {
    if (!fnLines[i].includes(downloadCall)) continue;
    callsFound++;

    const windowStart = Math.max(0, i - 20);
    const window      = fnLines.slice(windowStart, i + 1).join('\n');

    if (window.includes('Promise.all(')) {
      callsWrapped++;
    } else {
      const absLine = fnStartIdx + i + 1;
      failed = true;
      if (!silent) {
        console.error(
          `❌  parallel-downloads: \`${downloadCall}\` on line ${absLine} of ${file} ` +
          `(inside \`${fnName}\`) does not appear inside a \`Promise.all()\` wrapper.\n` +
          `   Downloads would run serially, requiring N × RTT instead of ~1 × RTT.\n` +
          `   Fix: wrap the \`${downloadCall}\` calls with ` +
          `\`Promise.all(keys.map(async key => { … }))\`.\n`,
        );
      }
    }
  }

  return { failed, callsFound, callsWrapped };
}

// ── Mode 1: TARGETS-based checks ─────────────────────────────────────────────

let anyFailed = false;

for (const { file, fn, downloadCall, requireParallel = true } of TARGETS) {
  const filePath = join(ROOT, file);
  const lines    = readLines(filePath, file);
  if (!lines) { anyFailed = true; continue; }

  const fnStartIdx = findFnStart(lines, fn);
  if (fnStartIdx === -1) {
    console.error(
      `❌  parallel-downloads: \`${fn}\` not found in ${file}.\n` +
      `   If the function was renamed or removed, update TARGETS in this script.\n`,
    );
    anyFailed = true;
    continue;
  }

  const fnEndIdx = findFnEnd(lines, fnStartIdx);
  const fnLines  = lines.slice(fnStartIdx, fnEndIdx);

  // For requireParallel: false entries with exactly one download call we
  // silence the per-line ❌ because one non-batched call is acceptable.
  // If there are ≥ 2 calls the error IS actionable, so we let it print.
  const preCount = fnLines.filter(l => l.includes(downloadCall)).length;
  const { failed, callsFound, callsWrapped } = checkFnLines({
    fnLines, downloadCall, fnName: fn, file, fnStartIdx,
    silent: !requireParallel && preCount === 1,
  });

  if (callsFound === 0) {
    console.error(
      `❌  parallel-downloads: no \`${downloadCall}\` call found inside ` +
      `\`${fn}\` in ${file} (lines ${fnStartIdx + 1}–${fnEndIdx}).\n` +
      `   If the download logic was moved or renamed, update TARGETS in this script.\n`,
    );
    anyFailed = true;
  } else if (!requireParallel && callsFound === 1) {
    // Single-item download helper: no Promise.all required for one call.
    // If a second call is ever added, the failed flag will fire (it is still
    // computed by checkFnLines) and the branch below catches it normally.
    console.log(
      `✅  parallel-downloads [target]: 1 \`${downloadCall}\` call inside ` +
      `\`${fn}\` in ${file} tracked (single-item download — no Promise.all required).`,
    );
  } else if (failed) {
    anyFailed = true;
  } else {
    console.log(
      `✅  parallel-downloads [target]: ${callsWrapped} \`${downloadCall}\` ` +
      `${callsWrapped === 1 ? 'call' : 'calls'} inside \`${fn}\` in ${file} ` +
      `${callsWrapped === 1 ? 'is' : 'are'} all inside a \`Promise.all()\` wrapper.`,
    );
  }
}

// ── Mode 2: Auto-scan ─────────────────────────────────────────────────────────
// Scan every top-level function in AUTO_SCAN_FILES.  Skip functions already
// covered by TARGETS.  Flag any function with ≥ 2 DOWNLOAD_CALL invocations
// that are not wrapped in Promise.all().

const targetsSet = new Set(
  TARGETS.map(t => `${t.file}::${t.fn}`),
);

for (const file of AUTO_SCAN_FILES) {
  const filePath = join(ROOT, file);
  const lines    = readLines(filePath, file);
  if (!lines) { anyFailed = true; continue; }

  for (let i = 0; i < lines.length; i++) {
    const match = TOPLEVEL_FN.exec(lines[i]);
    if (!match) continue;

    const fnName     = match[1];
    const fnStartIdx = i;
    const fnEndIdx   = findFnEnd(lines, fnStartIdx);
    const fnLines    = lines.slice(fnStartIdx, fnEndIdx);

    if (targetsSet.has(`${file}::${fnName}`)) continue;

    const callCount = fnLines.filter(l => l.includes(DOWNLOAD_CALL)).length;
    if (callCount < 2) continue;

    const { failed, callsWrapped } = checkFnLines({
      fnLines, downloadCall: DOWNLOAD_CALL, fnName, file, fnStartIdx,
    });

    if (failed) {
      anyFailed = true;
    } else {
      console.log(
        `✅  parallel-downloads [auto-scan]: ${callsWrapped} \`${DOWNLOAD_CALL}\` ` +
        `${callsWrapped === 1 ? 'call' : 'calls'} inside \`${fnName}\` in ${file} ` +
        `${callsWrapped === 1 ? 'is' : 'are'} all inside a \`Promise.all()\` wrapper.`,
      );
    }
  }
}

// ── Mode 3: Self-test ─────────────────────────────────────────────────────────
// Run auto-scan against the intentionally bad fixture and assert that it
// detects the serial-download pattern.  The fixture must trigger at least one
// failure for the self-test to pass.

(function runSelfTest() {
  const FIXTURE_REL  = 'scripts/fixtures/serial-downloads-fixture.js';
  const fixturePath  = join(ROOT, FIXTURE_REL);
  const fixtureLines = readLines(fixturePath, FIXTURE_REL);

  if (!fixtureLines) {
    console.error(
      `❌  parallel-downloads [self-test]: fixture file not found: ${FIXTURE_REL}\n`,
    );
    anyFailed = true;
    return;
  }

  let detectedSerialCount = 0;

  for (let i = 0; i < fixtureLines.length; i++) {
    const match = TOPLEVEL_FN.exec(fixtureLines[i]);
    if (!match) continue;

    const fnName     = match[1];
    const fnStartIdx = i;
    const fnEndIdx   = findFnEnd(fixtureLines, fnStartIdx);
    const fnLines    = fixtureLines.slice(fnStartIdx, fnEndIdx);

    const callCount = fnLines.filter(l => l.includes(DOWNLOAD_CALL)).length;
    if (callCount < 2) continue;

    const { failed } = checkFnLines({
      fnLines, downloadCall: DOWNLOAD_CALL, fnName,
      file: FIXTURE_REL, fnStartIdx, silent: true,
    });

    if (failed) detectedSerialCount++;
  }

  if (detectedSerialCount === 0) {
    console.error(
      `❌  parallel-downloads [self-test]: auto-scan did NOT detect the serial ` +
      `download pattern in the fixture (${FIXTURE_REL}).\n` +
      `   The detection logic may be broken — check the fixture and the scan.\n`,
    );
    anyFailed = true;
  } else {
    console.log(
      `✅  parallel-downloads [self-test]: auto-scan correctly detected ` +
      `${detectedSerialCount} serial-download function(s) in the fixture.`,
    );
  }
})();

process.exit(anyFailed ? 1 : 0);
