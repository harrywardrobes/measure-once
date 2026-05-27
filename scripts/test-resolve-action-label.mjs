#!/usr/bin/env node
/**
 * Unit tests for the resolveActionLabel resolver in useCardActionHandlers.ts.
 *
 * Imports the shared pure-function implementation from
 * src/react/utils/resolveActionLabel.mjs — the same module used by the
 * production React hook — so this test exercises real production code, not a
 * hand-written mirror.
 *
 * The three critical paths from task #585 that this guards:
 *   1. Per-LS row with a label        → returns that label
 *   2. Per-LS row with null label     → returns '' (admin explicitly cleared;
 *                                       must NOT fall through to per-stage default)
 *   3. No per-LS row at all (absent)  → falls back to per-stage default row
 *
 * Also covers:
 *   4. No lead status on contact        → returns per-stage default
 *   5. No matching row at all           → returns ''
 *   6. Substatus action_label priority  → beats per-LS label
 *   7. Substatus with no action_label   → falls through to per-LS label
 *   8. Case-insensitivity               → stage/LS keys are normalised
 *   9. Legacy per-substageId fallback   → used when lsKey is absent
 *  10. Missing per-LS key              → falls back to per-stage default
 *
 * No server, no DB, no Puppeteer required.
 * Exits non-zero when any assertion fails.
 */

import { resolveActionLabel } from '../src/react/utils/resolveActionLabel.mjs';

let passed = 0;
let failed = 0;

// ── Assertion helpers ─────────────────────────────────────────────────────────

function assertEqual(description, actual, expected) {
  if (actual === expected) {
    console.log(`  ✔  ${description}`);
    passed++;
  } else {
    console.error(`  ✖  ${description}`);
    console.error(`     Expected: ${JSON.stringify(expected)}`);
    console.error(`     Actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\nresolveActionLabel unit tests\n');

const NO_SUBSTATUS_MAP = {};

// ── 1. Per-LS row with a label → return that label ───────────────────────────
{
  const map = {
    'sales|hot': 'Book appointment',
    'sales|':    'Default action',
  };
  assertEqual(
    '1. Per-LS row with label → returns the per-LS label',
    resolveActionLabel(map, NO_SUBSTATUS_MAP, 'sales', 'hot', undefined, undefined),
    'Book appointment',
  );
}

// ── 2. Per-LS row with null label → returns '', NOT the per-stage default ─────
//
// null in the map means the admin explicitly cleared the label for this LS.
// The resolver must return '' and must NOT fall through to the per-stage
// default row.  This is the critical regression path from task #582.
{
  const map = {
    'sales|cold': null,             // admin explicitly cleared this LS
    'sales|':     'Default action',
  };
  assertEqual(
    '2a. Per-LS row with null label → returns empty string',
    resolveActionLabel(map, NO_SUBSTATUS_MAP, 'sales', 'cold', undefined, undefined),
    '',
  );
  assertEqual(
    '2b. Cleared per-LS row must NOT fall through to per-stage default',
    resolveActionLabel(map, NO_SUBSTATUS_MAP, 'sales', 'cold', undefined, undefined) !== 'Default action',
    true,
  );
}

// ── 3. No per-LS row → falls back to per-stage default ───────────────────────
//
// When the map has no key for this (stage, LS) pair at all (key is absent,
// not null), the resolver must fall back to the per-stage (stage, '') row.
{
  const map = {
    'sales|hot': 'Book appointment',
    'sales|':    'Default action',
    // 'sales|warm' is intentionally absent
  };
  assertEqual(
    '3. No per-LS row (key absent) → falls back to per-stage default',
    resolveActionLabel(map, NO_SUBSTATUS_MAP, 'sales', 'warm', undefined, undefined),
    'Default action',
  );
}

// ── 4. Per-stage default present, contact has no lead status ──────────────────
{
  const map = {
    'sales|': 'Schedule visit',
  };
  assertEqual(
    '4. No lead status on contact → returns per-stage default',
    resolveActionLabel(map, NO_SUBSTATUS_MAP, 'sales', undefined, undefined, undefined),
    'Schedule visit',
  );
}

// ── 5. Per-stage default absent, no per-LS row → returns '' ──────────────────
{
  const map = {
    'sales|hot': 'Book appointment',
    // no 'sales|' key, no 'sales|cold' key
  };
  assertEqual(
    '5. No matching row at all → returns empty string',
    resolveActionLabel(map, NO_SUBSTATUS_MAP, 'sales', 'cold', undefined, undefined),
    '',
  );
}

// ── 6. Substatus action label has highest priority ────────────────────────────
{
  const map = {
    'sales|hot': 'Per-LS label',
    'sales|':    'Default label',
  };
  const substatusMap = {
    'HOT|URGENT': 'Rush booking',
  };
  assertEqual(
    '6. Substatus action label takes priority over per-LS label',
    resolveActionLabel(map, substatusMap, 'sales', 'hot', undefined, 'HOT__URGENT'),
    'Rush booking',
  );
}

// ── 7. Substatus present but no action_label → falls through to per-LS row ───
{
  const map = {
    'sales|hot': 'Per-LS label',
    'sales|':    'Default label',
  };
  const substatusMap = {
    // 'HOT|STANDARD' has no entry (no action_label configured)
  };
  assertEqual(
    '7. Substatus with no action_label → falls through to per-LS label',
    resolveActionLabel(map, substatusMap, 'sales', 'hot', undefined, 'HOT__STANDARD'),
    'Per-LS label',
  );
}

// ── 8. Stage/LS keys are case-insensitive (normalised to lowercase) ───────────
{
  const map = {
    'sales|hot': 'Book appointment',  // keys stored lowercase
    'sales|':    'Default action',
  };
  assertEqual(
    '8a. Upper-case stageKey is normalised',
    resolveActionLabel(map, NO_SUBSTATUS_MAP, 'SALES', 'hot', undefined, undefined),
    'Book appointment',
  );
  assertEqual(
    '8b. Mixed-case leadStatusKey is normalised',
    resolveActionLabel(map, NO_SUBSTATUS_MAP, 'sales', 'HOT', undefined, undefined),
    'Book appointment',
  );
}

// ── 9. Legacy per-substageId fallback when no lead status ─────────────────────
{
  const map = {
    'survey|substage-1': 'Start survey',
    'survey|':           'Default survey action',
  };
  assertEqual(
    '9. Legacy substageId fallback when no lead status key',
    resolveActionLabel(map, NO_SUBSTATUS_MAP, 'survey', undefined, 'substage-1', undefined),
    'Start survey',
  );
}

// ── 10. Per-stage default used when lsKey present but per-LS key missing ──────
{
  const map = {
    'installation|': 'Schedule installation',
    // No 'installation|new_lead' row
  };
  assertEqual(
    '10. Missing per-LS key falls back to per-stage default',
    resolveActionLabel(map, NO_SUBSTATUS_MAP, 'installation', 'new_lead', undefined, undefined),
    'Schedule installation',
  );
  assertEqual(
    '10b. Confirm the per-LS key is genuinely absent (not null)',
    ('installation|new_lead' in map),
    false,
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
