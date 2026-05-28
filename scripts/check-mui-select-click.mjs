#!/usr/bin/env node
/**
 * check-mui-select-click.mjs
 *
 * Static lint: scans every `test/** /run.js` file for the inline anti-pattern
 * of opening a MUI Select dropdown by calling `page.$(…)` to obtain an
 * ElementHandle and then invoking `.click()` on it directly, rather than
 * delegating to the shared `clickMuiSelect` helper.
 *
 * WHY THIS MATTERS
 * ────────────────
 * `test/helpers/mui-select.js` already encodes the correct rule: MUI Select
 * dropdowns must be opened via Puppeteer's native ElementHandle.click() call
 * (which dispatches real pointer/mouse events through the browser's event
 * pipeline).  That helper is one canonical place for the logic.  Inline copies
 * are harder to maintain and easy to get wrong (e.g. missing a null-guard or
 * using `page.evaluate(() => el.click())` instead of the native path).
 *
 * DETECTION ALGORITHM
 * ───────────────────
 * For each `test/** /run.js` file (helpers excluded) we slide a 15-line window
 * over the source and flag any window that contains ALL THREE of:
 *   1. A `page.$(` call                — opening a handle
 *   2. A variable `.click()` call      — e.g. `await handle.click()` where the
 *      receiver is not `page` itself   — calling click on the handle
 *   3. A `MuiSelect` reference         — confirming the target is a MUI Select
 *
 * Windows that already contain a `clickMuiSelect(` call are skipped — the
 * author has already migrated that spot.
 *
 * Exit codes:
 *   0 — no violations found
 *   1 — one or more violations detected
 *
 * Usage:
 *   node scripts/check-mui-select-click.mjs
 *
 * Wired into CI via: npm run test:mui-select-click
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_DIR = join(ROOT, 'test');

const WINDOW = 15;

/**
 * Recursively collect every `run.js` file under `dir`, skipping `helpers/`.
 * @param {string} dir
 * @returns {string[]}
 */
function collectRunFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'helpers') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...collectRunFiles(full));
    } else if (entry === 'run.js') {
      results.push(full);
    }
  }
  return results;
}

/**
 * Return true if `line` contains a `.click()` call on a variable that is
 * NOT `page` itself (i.e. a handle click, not `page.click()`).
 *
 * Matches patterns like:
 *   await handle.click()
 *   await sel.click()
 *   await someHandle.click()
 *
 * Does NOT match:
 *   await page.click(…)        — Puppeteer page-level click by selector
 *   el.click()                 — bare DOM click inside page.evaluate()
 *                                (no `await`, no puppeteer handle)
 */
function isHandleClick(line) {
  return /\bawait\s+(?!page\b)\w+\.click\(\)/.test(line);
}

/**
 * Scan a single file and return an array of violation objects.
 * Each object has { line (1-based), windowStart, windowEnd, snippet }.
 *
 * @param {string} filePath
 * @returns {Array<{line: number, snippet: string}>}
 */
function scanFile(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const violations = [];
  const reported = new Set();

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('page.$(')) continue;

    const start = i;
    const end = Math.min(i + WINDOW, lines.length - 1);
    const window = lines.slice(start, end + 1);
    const joined = window.join('\n');

    if (!joined.includes('MuiSelect')) continue;
    if (!window.some(isHandleClick)) continue;
    if (joined.includes('clickMuiSelect(')) continue;

    if (!reported.has(i)) {
      reported.add(i);
      violations.push({
        line: i + 1,
        snippet: lines[i].trim(),
      });
    }
  }

  return violations;
}

const files = collectRunFiles(TEST_DIR);
console.log(
  `[check-mui-select-click] Scanning ${files.length} test run.js file(s)…`,
);

const allViolations = [];

for (const f of files) {
  const vs = scanFile(f);
  if (vs.length > 0) {
    allViolations.push({ file: relative(ROOT, f), violations: vs });
  }
}

if (allViolations.length === 0) {
  console.log(
    '[check-mui-select-click] OK — no inline MUI Select click anti-patterns found.',
  );
  process.exit(0);
}

process.stderr.write(
  `\n[check-mui-select-click] VIOLATIONS (${allViolations.reduce((n, v) => n + v.violations.length, 0)}):\n\n`,
);

for (const { file, violations } of allViolations) {
  process.stderr.write(`  ${file}:\n`);
  for (const { line, snippet } of violations) {
    process.stderr.write(`    Line ${line}: ${snippet}\n`);
  }
  process.stderr.write('\n');
}

process.stderr.write(
  'FIX: replace the inline page.$() + handle.click() pattern with the\n' +
  'shared helper from test/helpers/mui-select.js:\n\n' +
  '  const { clickMuiSelect } = require(\'../helpers/mui-select\');\n' +
  '  await clickMuiSelect(page, \'.MuiSelect-select…\');\n\n' +
  'The helper correctly uses Puppeteer\'s native ElementHandle.click() so\n' +
  'MUI\'s React event handler opens the dropdown portal as expected.\n\n',
);
process.exit(1);
