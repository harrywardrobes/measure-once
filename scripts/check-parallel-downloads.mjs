#!/usr/bin/env node
/**
 * scripts/check-parallel-downloads.mjs
 *
 * Static structural lint: verifies that every batch-download call inside each
 * configured (file, function) pair appears within a `Promise.all(…)` wrapper.
 *
 * This guard complements timing-sensitive perf tests that are skipped on CI.
 * A refactor from `Promise.all(keys.map(…))` to a serial `for...of` / `await`
 * loop would silently regress download performance; this check catches it
 * structurally without any timing assertions.
 *
 * To enrol a new batch-download surface add one entry to TARGETS below:
 *
 *   { file: 'path/to/file.js', fn: 'myBatchFunction', downloadCall: 'downloadAsBytes' }
 *
 * Detection logic (per target):
 *   1. Locate the start of `fn` in the source file.
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

// ── Configuration ──────────────────────────────────────────────────────────────
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
];
// ──────────────────────────────────────────────────────────────────────────────

const TOPLEVEL_FN = /^(?:async\s+)?function\s+\w/;

let anyFailed = false;

for (const { file, fn, downloadCall } of TARGETS) {
  const filePath = join(ROOT, file);
  let src;
  try {
    src = readFileSync(filePath, 'utf8');
  } catch {
    console.error(
      `❌  parallel-downloads: cannot read \`${file}\`.\n` +
      `   Check that the path in TARGETS is correct.\n`,
    );
    anyFailed = true;
    continue;
  }

  const lines = src.split('\n');

  // Locate the function declaration
  const fnStartIdx = lines.findIndex(l => l.includes(`function ${fn}`));
  if (fnStartIdx === -1) {
    console.error(
      `❌  parallel-downloads: \`${fn}\` not found in ${file}.\n` +
      `   If the function was renamed or removed, update TARGETS in this script.\n`,
    );
    anyFailed = true;
    continue;
  }

  // Bound the range to the next top-level function (or EOF)
  let fnEndIdx = lines.length;
  for (let i = fnStartIdx + 1; i < lines.length; i++) {
    if (TOPLEVEL_FN.test(lines[i])) {
      fnEndIdx = i;
      break;
    }
  }

  const fnLines    = lines.slice(fnStartIdx, fnEndIdx);
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
      console.error(
        `❌  parallel-downloads: \`${downloadCall}\` on line ${absLine} of ${file} ` +
        `(inside \`${fn}\`) does not appear inside a \`Promise.all()\` wrapper.\n` +
        `   Downloads would run serially, requiring N × RTT instead of ~1 × RTT.\n` +
        `   Fix: wrap the \`${downloadCall}\` calls with ` +
        `\`Promise.all(keys.map(async key => { … }))\`.\n`,
      );
    }
  }

  if (callsFound === 0) {
    failed = true;
    console.error(
      `❌  parallel-downloads: no \`${downloadCall}\` call found inside ` +
      `\`${fn}\` in ${file} (lines ${fnStartIdx + 1}–${fnEndIdx}).\n` +
      `   If the download logic was moved or renamed, update TARGETS in this script.\n`,
    );
  }

  if (!failed) {
    console.log(
      `✅  parallel-downloads: ${callsWrapped} \`${downloadCall}\` ` +
      `${callsWrapped === 1 ? 'call' : 'calls'} inside \`${fn}\` in ${file} ` +
      `${callsWrapped === 1 ? 'is' : 'are'} all inside a \`Promise.all()\` wrapper.`,
    );
  } else {
    anyFailed = true;
  }
}

process.exit(anyFailed ? 1 : 0);
