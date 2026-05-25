#!/usr/bin/env node
/**
 * Unit tests for the bundle-size trend-regression warning logic.
 *
 * Exercises detectTrendWarning() from bundle-size-trend.mjs against synthetic
 * history entries, covering:
 *   1. Growth above the threshold → warning emitted
 *   2. Growth below the threshold → silent
 *   3. Growth exactly at the threshold → silent (strict > comparison)
 *   4. Single-entry window → silent (need at least 2 entries)
 *   5. Empty window → silent
 *   6. Zero oldest value → silent (avoids division by zero)
 *   7. Window slicing: only the last TREND_WINDOW entries are considered
 *
 * Exits non-zero when any assertion fails.
 */

import { detectTrendWarning, TREND_WINDOW, TREND_DRIFT_PCT } from './bundle-size-trend.mjs';

let passed = 0;
let failed = 0;

function entry(totalAlwaysGzBytes) {
  return { totalAlwaysGzBytes, ts: new Date().toISOString(), sha: 'abc1234', result: 'PASS', chunks: {} };
}

function assert(description, actual, expectWarning) {
  const gotWarning = actual !== null;
  if (gotWarning === expectWarning) {
    console.log(`  ✔  ${description}`);
    passed++;
  } else {
    console.error(`  ✖  ${description}`);
    console.error(`     Expected warning=${expectWarning}, got: ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertContains(description, actual, substring) {
  if (actual !== null && actual.includes(substring)) {
    console.log(`  ✔  ${description}`);
    passed++;
  } else {
    console.error(`  ✖  ${description}`);
    console.error(`     Expected string containing "${substring}", got: ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log('\nBundle-size trend warning logic tests\n');

// ── 1. Growth above threshold → warn ─────────────────────────────────────────
{
  const base = 100_000;
  const grown = Math.round(base * (1 + (TREND_DRIFT_PCT + 1) / 100));
  const entries = [entry(base), entry(grown)];
  const result = detectTrendWarning(entries);
  assert('growth above threshold emits a warning', result, true);
  if (result !== null) {
    assertContains('warning mentions growth percentage', result, '%');
    assertContains('warning mentions the threshold', result, `>${TREND_DRIFT_PCT}%`);
  }
}

// ── 2. Growth below threshold → silent ───────────────────────────────────────
{
  const base = 100_000;
  const grown = Math.round(base * (1 + (TREND_DRIFT_PCT - 1) / 100));
  const entries = [entry(base), entry(grown)];
  assert('growth below threshold is silent', detectTrendWarning(entries), false);
}

// ── 3. Exactly at threshold → silent (strict >) ──────────────────────────────
{
  const base = 100_000;
  const grown = Math.round(base * (1 + TREND_DRIFT_PCT / 100));
  const entries = [entry(base), entry(grown)];
  assert('growth exactly at threshold is silent (strict >)', detectTrendWarning(entries), false);
}

// ── 4. Single-entry window → silent ──────────────────────────────────────────
{
  assert('single entry is silent', detectTrendWarning([entry(100_000)]), false);
}

// ── 5. Empty window → silent ──────────────────────────────────────────────────
{
  assert('empty window is silent', detectTrendWarning([]), false);
}

// ── 6. Zero oldest value → silent (avoids division by zero) ──────────────────
{
  const entries = [entry(0), entry(100_000)];
  assert('zero oldest value is silent', detectTrendWarning(entries), false);
}

// ── 7. Window slicing: TREND_WINDOW oldest entry overrides earlier ones ───────
// Build a history longer than TREND_WINDOW where:
//   - entries 0..(length - TREND_WINDOW - 1) are enormous (would trigger warn
//     if used as the baseline)
//   - entries in the active window are stable (no drift)
// The check should only look at the last TREND_WINDOW entries, so it must be
// silent.
{
  const stable = 100_000;
  const tooBig = 1_000_000; // 10× the stable value — way over threshold if baseline
  const beforeWindow = Array.from({ length: 3 }, () => entry(tooBig));
  const inWindow = Array.from({ length: TREND_WINDOW }, () => entry(stable));
  const allEntries = [...beforeWindow, ...inWindow];

  const windowEntries = allEntries.slice(-TREND_WINDOW);
  assert(
    `only the last ${TREND_WINDOW} entries are considered (stable window → silent)`,
    detectTrendWarning(windowEntries),
    false,
  );
}

// ── 8. Shrinkage → silent ─────────────────────────────────────────────────────
{
  const entries = [entry(100_000), entry(80_000)];
  assert('shrinking bundle is silent', detectTrendWarning(entries), false);
}

// ── 9. Many entries where only newest vs oldest in window matters ─────────────
{
  const base = 100_000;
  const grown = Math.round(base * (1 + (TREND_DRIFT_PCT + 5) / 100));
  const entries = [
    entry(base),
    ...Array.from({ length: TREND_WINDOW - 2 }, () => entry(base + 500)),
    entry(grown),
  ];
  assert(
    'multi-entry window: oldest vs newest comparison triggers warning when grown > threshold',
    detectTrendWarning(entries),
    true,
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
