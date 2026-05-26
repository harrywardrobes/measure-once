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

import { detectTrendWarning, detectChunkTrendWarnings, TREND_WINDOW, TREND_DRIFT_PCT } from './bundle-size-trend.mjs';

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

// ── Per-chunk trend warning tests ─────────────────────────────────────────────

function chunkEntry(chunkSizes, totalOverride) {
  const chunks = chunkSizes;
  const total = totalOverride ?? Object.values(chunks).reduce((s, v) => s + v, 0);
  return { totalAlwaysGzBytes: total, ts: new Date().toISOString(), sha: 'abc1234', result: 'PASS', chunks };
}

function assertArray(description, actual, expectNonEmpty) {
  const gotWarning = actual.length > 0;
  if (gotWarning === expectNonEmpty) {
    console.log(`  ✔  ${description}`);
    passed++;
  } else {
    console.error(`  ✖  ${description}`);
    console.error(`     Expected non-empty=${expectNonEmpty}, got: ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertArrayContains(description, actual, substring) {
  const match = actual.find(w => w.includes(substring));
  if (match) {
    console.log(`  ✔  ${description}`);
    passed++;
  } else {
    console.error(`  ✖  ${description}`);
    console.error(`     Expected an entry containing "${substring}", got: ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log('\nPer-chunk trend warning logic tests\n');

// ── 10. One chunk grows above threshold while total stays flat → warn ──────────
// chunk-a balloons; chunk-b shrinks by the same amount so the total is flat.
// detectTrendWarning should be silent; detectChunkTrendWarnings should fire.
{
  const base = 100_000;
  const delta = Math.round(base * (TREND_DRIFT_PCT + 5) / 100);
  const oldEntry = chunkEntry({ 'chunk-a': base, 'chunk-b': base }, base * 2);
  const newEntry = chunkEntry({ 'chunk-a': base + delta, 'chunk-b': base - delta }, base * 2);
  const entries = [oldEntry, newEntry];

  const totalWarn = detectTrendWarning(entries);
  assert('total trend is silent when one chunk grows and another shrinks equally', totalWarn, false);

  const chunkWarns = detectChunkTrendWarnings(entries);
  assertArray('per-chunk warns when one chunk grows above threshold', chunkWarns, true);
  assertArrayContains('per-chunk warning names the offending chunk', chunkWarns, 'chunk-a');
  assertArrayContains('per-chunk warning mentions the threshold', chunkWarns, `>${TREND_DRIFT_PCT}%`);
}

// ── 11. All chunks stable → silent ────────────────────────────────────────────
{
  const stable = 100_000;
  const oldEntry = chunkEntry({ 'chunk-a': stable, 'chunk-b': stable });
  const newEntry = chunkEntry({ 'chunk-a': stable, 'chunk-b': stable });
  const chunkWarns = detectChunkTrendWarnings([oldEntry, newEntry]);
  assertArray('all chunks stable → no per-chunk warnings', chunkWarns, false);
}

// ── 12. Newly added chunk (absent from oldest) → silent for that chunk ─────────
{
  const base = 100_000;
  const bigNew = Math.round(base * (1 + (TREND_DRIFT_PCT + 10) / 100));
  const oldEntry = chunkEntry({ 'chunk-a': base });
  const newEntry = chunkEntry({ 'chunk-a': base, 'chunk-new': bigNew });
  const chunkWarns = detectChunkTrendWarnings([oldEntry, newEntry]);
  assertArray('newly added chunk with no baseline → silent', chunkWarns, false);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
