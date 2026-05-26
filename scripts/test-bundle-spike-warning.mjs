#!/usr/bin/env node
/**
 * Tests for the per-build spike-detection warning logic.
 *
 * Part A — Unit tests: exercise detectSpikeWarning() directly.
 *   1. Growth above SPIKE_PCT in one build → warning emitted
 *   2. Growth below SPIKE_PCT in one build → silent
 *   3. Growth exactly at SPIKE_PCT → silent (strict > comparison)
 *   4. Single-entry history → silent (need at least 2 entries)
 *   5. Empty history → silent
 *   6. Zero previous value → silent (avoids division by zero)
 *   7. Shrinkage → silent
 *   8. Only the last two entries are compared (middle entries ignored)
 *   9. Stable build-over-build growth well below threshold → silent
 *
 * Part B — Integration tests: run check-bundle-sizes.mjs end-to-end with a
 *   seeded history file and controlled bundle directory, then assert that the
 *   spike warning appears (or does not appear) in both stdout and the generated
 *   markdown report.
 *
 * Exits non-zero when any assertion fails.
 */

import { detectSpikeWarning, SPIKE_PCT } from './bundle-size-trend.mjs';
import { gzipSync } from 'zlib';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function entry(totalAlwaysGzBytes) {
  return { totalAlwaysGzBytes, ts: new Date().toISOString(), sha: 'abc1234', result: 'PASS', chunks: {} };
}

function assert(description, condition) {
  if (condition) {
    console.log(`  ✔  ${description}`);
    passed++;
  } else {
    console.error(`  ✖  ${description}`);
    failed++;
  }
}

function assertWarning(description, actual, expectWarning) {
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

// ════════════════════════════════════════════════════════════════════════════
// Part A — Unit tests
// ════════════════════════════════════════════════════════════════════════════

console.log('\nPart A — Unit tests for detectSpikeWarning()\n');

// ── 1. Growth above SPIKE_PCT → warn ─────────────────────────────────────────
{
  const base = 100_000;
  const spiked = Math.round(base * (1 + (SPIKE_PCT + 1) / 100));
  const entries = [entry(base), entry(spiked)];
  const result = detectSpikeWarning(entries);
  assertWarning('growth above SPIKE_PCT emits a warning', result, true);
  if (result !== null) {
    assertContains('warning mentions growth percentage', result, '%');
    assertContains('warning mentions the threshold', result, `>${SPIKE_PCT}%`);
    assertContains('warning mentions "jumped"', result, 'jumped');
  }
}

// ── 2. Growth below SPIKE_PCT → silent ───────────────────────────────────────
{
  const base = 100_000;
  const grown = Math.round(base * (1 + (SPIKE_PCT - 1) / 100));
  const entries = [entry(base), entry(grown)];
  assertWarning('growth below SPIKE_PCT is silent', detectSpikeWarning(entries), false);
}

// ── 3. Exactly at SPIKE_PCT → silent (strict >) ──────────────────────────────
{
  const base = 100_000;
  const grown = Math.round(base * (1 + SPIKE_PCT / 100));
  const entries = [entry(base), entry(grown)];
  assertWarning('growth exactly at SPIKE_PCT is silent (strict >)', detectSpikeWarning(entries), false);
}

// ── 4. Single-entry history → silent ─────────────────────────────────────────
{
  assertWarning('single entry is silent', detectSpikeWarning([entry(100_000)]), false);
}

// ── 5. Empty history → silent ─────────────────────────────────────────────────
{
  assertWarning('empty history is silent', detectSpikeWarning([]), false);
}

// ── 6. Zero previous value → silent (avoids division by zero) ────────────────
{
  const entries = [entry(0), entry(100_000)];
  assertWarning('zero previous value is silent', detectSpikeWarning(entries), false);
}

// ── 7. Shrinkage → silent ─────────────────────────────────────────────────────
{
  const entries = [entry(100_000), entry(80_000)];
  assertWarning('shrinking bundle is silent', detectSpikeWarning(entries), false);
}

// ── 8. Only last two entries matter ───────────────────────────────────────────
{
  const small  = 50_000;
  const base   = 100_000;
  const spiked = Math.round(base * (1 + (SPIKE_PCT + 2) / 100));
  const entries = [entry(small), entry(small), entry(base), entry(spiked)];
  assertWarning(
    'only the last two entries are compared (spike vs immediate predecessor)',
    detectSpikeWarning(entries),
    true,
  );
}

// ── 9. Stable build-over-build growth → silent ───────────────────────────────
{
  const base = 100_000;
  const entries = [entry(base), entry(base + 1_000), entry(base + 2_000)];
  assertWarning('stable build-over-build growth well below threshold is silent', detectSpikeWarning(entries), false);
}

// ════════════════════════════════════════════════════════════════════════════
// Part B — Integration tests: run check-bundle-sizes.mjs end-to-end
// ════════════════════════════════════════════════════════════════════════════

console.log('\nPart B — Integration tests (check-bundle-sizes.mjs end-to-end)\n');

/**
 * Set up an isolated temp workspace for one integration test case:
 *   - <tmp>/react/main.js          — fake always-loaded entry chunk
 *   - <tmp>/react/chunks/          — empty (no lazy chunks)
 *   - <tmp>/report/                — isolated report + history dir
 *
 * Returns { reactDir, reportDir, mainJsGzSize, cleanup }.
 */
function setupTempWorkspace(label) {
  const base = join(tmpdir(), `mo-spike-test-${label}-${Date.now()}`);
  const reactDir  = join(base, 'react');
  const chunksDir = join(reactDir, 'chunks');
  const reportDir = join(base, 'report');

  mkdirSync(chunksDir, { recursive: true });
  mkdirSync(reportDir, { recursive: true });

  // Fake main.js — small enough to pass the 20 kB always-loaded threshold.
  // The exact content does not matter; we measure its gzip size below.
  const fakeContent = Buffer.from(
    '(function(){console.log("fake main bundle for spike test");})();\n'
  );
  writeFileSync(join(reactDir, 'main.js'), fakeContent);

  const mainJsGzSize = gzipSync(fakeContent, { level: 9 }).length;

  function cleanup() {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return { reactDir, reportDir, mainJsGzSize, cleanup };
}

/**
 * Run check-bundle-sizes.mjs with the supplied env overrides and return
 * { stdout, stderr, status, mdReport }.
 */
function runScript(reactDir, reportDir) {
  const scriptPath = resolve(__dirname, 'check-bundle-sizes.mjs');
  const result = spawnSync(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      BUNDLE_SIZES_REACT_DIR_OVERRIDE:   reactDir,
      BUNDLE_SIZES_REPORT_DIR_OVERRIDE:  reportDir,
    },
    encoding: 'utf8',
  });

  let mdReport = '';
  try {
    mdReport = readFileSync(join(reportDir, 'bundle-sizes.md'), 'utf8');
  } catch { /* report may not exist if the script crashed early */ }

  return {
    stdout:   result.stdout || '',
    stderr:   result.stderr || '',
    status:   result.status,
    mdReport,
  };
}

// ── B-1. Spike case: previous entry is 7% smaller → spike warning fires ───────
{
  const { reactDir, reportDir, mainJsGzSize, cleanup } = setupTempWorkspace('spike');
  try {
    // Seed one history entry that is 7% below the current gzip size so the
    // script's second entry (appended during this run) will be ~7.5% larger —
    // enough to exceed SPIKE_PCT (5%).
    const prevGzSize = Math.round(mainJsGzSize / 1.07);
    const historyEntry = JSON.stringify(entry(prevGzSize)) + '\n';
    writeFileSync(join(reportDir, 'bundle-sizes-history.jsonl'), historyEntry);

    const { stdout, status, mdReport } = runScript(reactDir, reportDir);

    assert('B-1: script exits 0 (spike is non-fatal)', status === 0);
    assert('B-1: stdout contains "Spike warning:"', stdout.includes('Spike warning:'));
    assert('B-1: markdown report contains "**Spike warning:**"', mdReport.includes('**Spike warning:**'));
  } finally {
    cleanup();
  }
}

// ── B-2. No-spike case: previous entry is 3% smaller → no warning ─────────────
{
  const { reactDir, reportDir, mainJsGzSize, cleanup } = setupTempWorkspace('nospike');
  try {
    // Seed an entry that is 3% below the current gzip size — growth of ~3.1%,
    // below the 5% SPIKE_PCT threshold.
    const prevGzSize = Math.round(mainJsGzSize / 1.03);
    const historyEntry = JSON.stringify(entry(prevGzSize)) + '\n';
    writeFileSync(join(reportDir, 'bundle-sizes-history.jsonl'), historyEntry);

    const { stdout, status, mdReport } = runScript(reactDir, reportDir);

    assert('B-2: script exits 0', status === 0);
    assert('B-2: stdout does NOT contain "Spike warning:"', !stdout.includes('Spike warning:'));
    assert('B-2: markdown report does NOT contain "**Spike warning:**"', !mdReport.includes('**Spike warning:**'));
  } finally {
    cleanup();
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
