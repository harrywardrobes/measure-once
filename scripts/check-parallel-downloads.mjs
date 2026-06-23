#!/usr/bin/env node
/**
 * scripts/check-parallel-downloads.mjs
 *
 * Static structural lint: verifies that every `downloadAsBytes` call inside
 * `sendAdminNotificationEmail` in customer-info.js appears within a
 * `Promise.all(…)` wrapper.
 *
 * This guard complements the perf test (test:customer-info-parallel-downloads),
 * which is skipped on CI due to timing sensitivity.  A refactor from
 * `Promise.all(photoKeys.map(…))` to a serial `for...of` / `await` loop would
 * silently regress download performance; this check catches it structurally
 * without any timing assertions.
 *
 * Scope: only lines inside `sendAdminNotificationEmail` are checked.
 * Standalone single-file downloads in other routes (e.g. the photo-serving
 * GET endpoint) are correctly excluded because they are outside the function.
 *
 * Detection logic:
 *   1. Locate the start of `sendAdminNotificationEmail` in the source.
 *   2. Locate the start of the next top-level `async function` after it
 *      (or end-of-file) to determine the function body range.
 *   3. For every line in that range that calls `downloadAsBytes`, inspect a
 *      window of up to 20 preceding lines within the same range.  If
 *      `Promise.all(` does not appear in that window, the check fails.
 *
 * Run via:  npm run test:parallel-downloads
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT   = fileURLToPath(new URL('..', import.meta.url));
const TARGET = join(ROOT, 'customer-info.js');

const src   = readFileSync(TARGET, 'utf8');
const lines = src.split('\n');

// ── Locate the sendAdminNotificationEmail function body ────────────────────

const FN_NAME = 'sendAdminNotificationEmail';

// Find the line where the function is declared (async function sendAdminNotificationEmail)
const fnStartIdx = lines.findIndex(l => l.includes(`function ${FN_NAME}`));

if (fnStartIdx === -1) {
  console.error(
    `❌  parallel-downloads: \`${FN_NAME}\` not found in customer-info.js.\n` +
    `   If the function was renamed or removed, update this script accordingly.\n`,
  );
  process.exit(1);
}

// Find the start of the next top-level function (async function / function) after fnStartIdx
// to bound the range we scan.
const TOPLEVEL_FN = /^(?:async\s+)?function\s+\w/;
let fnEndIdx = lines.length;
for (let i = fnStartIdx + 1; i < lines.length; i++) {
  if (TOPLEVEL_FN.test(lines[i])) {
    fnEndIdx = i;
    break;
  }
}

const fnLines      = lines.slice(fnStartIdx, fnEndIdx);
let failed         = false;
let callsFound     = 0;
let callsWrapped   = 0;

for (let i = 0; i < fnLines.length; i++) {
  if (!fnLines[i].includes('downloadAsBytes')) continue;
  callsFound++;

  const windowStart = Math.max(0, i - 20);
  const window      = fnLines.slice(windowStart, i + 1).join('\n');

  if (window.includes('Promise.all(')) {
    callsWrapped++;
  } else {
    const absLine = fnStartIdx + i + 1;
    failed = true;
    console.error(
      `❌  parallel-downloads: \`downloadAsBytes\` on line ${absLine} of customer-info.js ` +
      `(inside \`${FN_NAME}\`) does not appear inside a \`Promise.all()\` wrapper.\n` +
      `   Downloads would run serially, requiring N × RTT instead of ~1 × RTT.\n` +
      `   Fix: wrap the \`downloadAsBytes\` calls with ` +
      `\`Promise.all(photoKeys.map(async key => { … }))\`.\n`,
    );
  }
}

if (callsFound === 0) {
  failed = true;
  console.error(
    `❌  parallel-downloads: no \`downloadAsBytes\` call found inside ` +
    `\`${FN_NAME}\` in customer-info.js (lines ${fnStartIdx + 1}–${fnEndIdx}).\n` +
    `   If the download logic was moved or renamed, update this script accordingly.\n`,
  );
}

if (!failed) {
  console.log(
    `✅  parallel-downloads: ${callsWrapped} \`downloadAsBytes\` ` +
    `${callsWrapped === 1 ? 'call' : 'calls'} inside \`${FN_NAME}\` in customer-info.js ` +
    `${callsWrapped === 1 ? 'is' : 'are'} all inside a \`Promise.all()\` wrapper.`,
  );
  process.exit(0);
}

process.exit(1);
