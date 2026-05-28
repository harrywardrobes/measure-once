#!/usr/bin/env node
/**
 * check-workflow-map-ordering.mjs
 *
 * Guards the Workflow Map stage-ordering contract introduced in task #1868.
 *
 * The contract: the Workflow Map must render pipeline stages in exactly the
 * order that keys appear in workflow.json → `.stages`.  Two independent code
 * paths implement this:
 *
 *   A) CardActionsPage.tsx builds `allStages` via `Object.keys(wf.stages)`.
 *      Any substitution of a hardcoded list or a sort call would silently
 *      break the guarantee.
 *
 *   B) WorkflowMapChart.tsx iterates `allStages` as-supplied in
 *      `buildFlowGraph`.  A hidden `.sort()` or `.reverse()` in that loop
 *      would override the caller-supplied order.
 *
 *   C) `CARD_ACTION_STAGES` in WorkflowMapChart.tsx (the three DB-backed
 *      stages) must be a subsequence of workflow.json stage keys in the same
 *      relative order so that the mixed card-action + read-only list reflects
 *      the true pipeline sequence.
 *
 * Checks performed
 * ────────────────
 * 1. Parse workflow.json and extract stage keys in insertion order.
 * 2. Parse CARD_ACTION_STAGES from WorkflowMapChart.tsx and verify every key
 *    exists in workflow.json and that their relative order is preserved.
 * 3. In CardActionsPage.tsx, verify the allStages builder uses
 *    `Object.keys(wfStages)` (not a hardcoded stage list or a sort call).
 * 4. In WorkflowMapChart.tsx's buildFlowGraph, verify `allStages` is iterated
 *    without a `.sort()` or `.reverse()` reorder.
 *
 * Exit codes:
 *   0 — all invariants pass
 *   1 — one or more invariants fail
 *
 * Usage:
 *   node scripts/check-workflow-map-ordering.mjs
 *
 * Wired into CI via: npm run test:workflow-map-ordering
 */

import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

const WORKFLOW_JSON      = join(ROOT, 'workflow.json');
const WORKFLOW_MAP_CHART = join(ROOT, 'src/react/components/WorkflowMapChart.tsx');
const CARD_ACTIONS_PAGE  = join(ROOT, 'src/react/pages/admin/CardActionsPage.tsx');

/** @type {string[]} */
const errors = [];

// ── Step 1: Read workflow.json and extract stage keys in insertion order ───────

/** @type {{ stages?: Record<string, unknown> }} */
let wf;
try {
  wf = JSON.parse(readFileSync(WORKFLOW_JSON, 'utf8'));
} catch (err) {
  process.stderr.write(
    `[check-workflow-map-ordering] ERROR: Could not read or parse workflow.json:\n  ${err.message}\n`,
  );
  process.exit(1);
}

if (!wf.stages || typeof wf.stages !== 'object' || Array.isArray(wf.stages)) {
  process.stderr.write(
    '[check-workflow-map-ordering] ERROR: workflow.json is missing a ".stages" object.\n',
  );
  process.exit(1);
}

const wfStageKeys = Object.keys(wf.stages);

if (wfStageKeys.length === 0) {
  process.stderr.write(
    '[check-workflow-map-ordering] ERROR: workflow.json ".stages" has no keys.\n',
  );
  process.exit(1);
}

console.log(
  `[check-workflow-map-ordering] workflow.json has ${wfStageKeys.length} stage(s): ` +
  wfStageKeys.map(k => `'${k}'`).join(', ') + '.',
);

// ── Step 2: Parse CARD_ACTION_STAGES from WorkflowMapChart.tsx ────────────────

const chartSource = readFileSync(WORKFLOW_MAP_CHART, 'utf8');

/**
 * Locate the CARD_ACTION_STAGES array literal and extract the `key: '…'`
 * entries in the order they appear.
 *
 * Matches: `const CARD_ACTION_STAGES: Array<…> = [ … ];`
 * The `s` flag lets `.` cross newlines.
 */
const CA_ARRAY_RE =
  /CARD_ACTION_STAGES[^=]*=\s*\[([^\]]*)\]/s;

const caArrayMatch = chartSource.match(CA_ARRAY_RE);
if (!caArrayMatch) {
  errors.push(
    'WorkflowMapChart.tsx: Could not locate the CARD_ACTION_STAGES array literal.\n' +
    '  Has it been renamed, moved, or reformatted in a way that breaks the regex?\n' +
    '  The ordering guarantee depends on this array being derived from workflow.json\n' +
    '  key order — update this check if the array is intentionally restructured.',
  );
} else {
  const KEY_RE = /key:\s*['"]([^'"]+)['"]/g;
  /** @type {string[]} */
  const caKeys = [];
  let km;
  while ((km = KEY_RE.exec(caArrayMatch[1])) !== null) {
    caKeys.push(km[1]);
  }

  if (caKeys.length === 0) {
    errors.push(
      'WorkflowMapChart.tsx: CARD_ACTION_STAGES appears to be empty or no\n' +
      "  `key: '…'` entries could be parsed from it.",
    );
  } else {
    console.log(
      `[check-workflow-map-ordering] CARD_ACTION_STAGES has ${caKeys.length} key(s): ` +
      caKeys.map(k => `'${k}'`).join(', ') + '.',
    );

    // Check C: every CA key must exist in workflow.json
    /** @type {string[]} */
    const missingFromWf = caKeys.filter(k => !wf.stages[k]);
    if (missingFromWf.length > 0) {
      errors.push(
        `WorkflowMapChart.tsx: CARD_ACTION_STAGES contains key(s) not found in ` +
        `workflow.json stages: ${missingFromWf.map(k => `'${k}'`).join(', ')}.\n` +
        '  Every card-action stage key must correspond to a top-level key in\n' +
        '  workflow.json so the Workflow Map reflects the pipeline accurately.',
      );
    }

    // Check C: relative order must be preserved (subsequence check)
    // Walk wfStageKeys and collect CA keys in the order they appear
    const caInWfOrder = wfStageKeys.filter(k => caKeys.includes(k));
    const orderMismatch = caInWfOrder.some((k, i) => k !== caKeys[i]);
    if (orderMismatch) {
      errors.push(
        'WorkflowMapChart.tsx: CARD_ACTION_STAGES key order does not match the\n' +
        '  relative order of those keys in workflow.json.\n' +
        `  workflow.json order (filtered to CA keys): ${caInWfOrder.map(k => `'${k}'`).join(', ')}\n` +
        `  CARD_ACTION_STAGES order:                  ${caKeys.map(k => `'${k}'`).join(', ')}\n` +
        '  CARD_ACTION_STAGES must be a subsequence of workflow.json stage keys so\n' +
        '  that the unified allStages list reflects the true pipeline sequence.',
      );
    } else {
      console.log(
        '[check-workflow-map-ordering] CARD_ACTION_STAGES relative order matches workflow.json. ✓',
      );
    }
  }
}

// ── Step 3: CardActionsPage.tsx — allStages builder uses Object.keys ──────────

const capSource = readFileSync(CARD_ACTIONS_PAGE, 'utf8');

// Must contain `Object.keys(wfStages)` (or Object.keys on a similarly-named
// local that holds the wf.stages object).  We look for the canonical pattern
// established by the task #1868 implementation: `Object.keys(wfStages)`.
if (!/Object\.keys\(wfStages\)/.test(capSource)) {
  errors.push(
    'CardActionsPage.tsx: the allStages builder no longer calls\n' +
    '  `Object.keys(wfStages)` to derive stage keys.\n' +
    '  The ordering contract requires that stage keys are read directly from\n' +
    '  workflow.json in the order they appear in the file — not from a\n' +
    '  hardcoded list or a sort call.  Restore the `Object.keys(wfStages).map(…)`\n' +
    '  expression (see the "Ordering contract" comment in the fetchAll callback).',
  );
} else {
  console.log(
    '[check-workflow-map-ordering] CardActionsPage.tsx allStages builder uses Object.keys(wfStages). ✓',
  );
}

// Also assert there is no `.sort(` call on the allStages / unified array in
// the fetch callback — a sort would silently override JSON key order.
// We look for `.sort(` within 300 characters after `Object.keys(wfStages)`.
const objKeysIdx = capSource.indexOf('Object.keys(wfStages)');
if (objKeysIdx !== -1) {
  const nearbyWindow = capSource.slice(objKeysIdx, objKeysIdx + 400);
  if (/unified[^;]*\.sort\(|\.sort\(\)/.test(nearbyWindow)) {
    errors.push(
      'CardActionsPage.tsx: a `.sort()` call was found near the\n' +
      '  `Object.keys(wfStages)` expression.\n' +
      '  Sorting the unified stage list overrides the JSON-insertion-order\n' +
      '  guarantee — remove the sort call to restore correct ordering.',
    );
  }
}

// ── Step 4: WorkflowMapChart.tsx buildFlowGraph — no reorder of allStages ─────

// Locate the buildFlowGraph function body and verify it does not call
// .sort() or .reverse() on the allStages parameter before iterating.
// We extract a generous window around the function signature.
const buildFnIdx = chartSource.indexOf('export function buildFlowGraph(');
if (buildFnIdx === -1) {
  errors.push(
    'WorkflowMapChart.tsx: Could not locate `export function buildFlowGraph(`.\n' +
    '  Has the function been renamed or moved?  Update this check if so.',
  );
} else {
  // Walk forward to find the balanced function body
  const afterSignature = chartSource.slice(buildFnIdx);
  const openBrace = afterSignature.indexOf('{');
  let depth = 0;
  let bodyEnd = -1;
  for (let i = openBrace; i < afterSignature.length; i++) {
    if (afterSignature[i] === '{') depth++;
    else if (afterSignature[i] === '}') {
      depth--;
      if (depth === 0) { bodyEnd = i; break; }
    }
  }
  const fnBody = bodyEnd !== -1
    ? afterSignature.slice(openBrace, bodyEnd + 1)
    : afterSignature.slice(openBrace, openBrace + 2000);

  if (/allStages\s*\.\s*sort\s*\(|allStages\s*\.\s*reverse\s*\(/.test(fnBody)) {
    errors.push(
      'WorkflowMapChart.tsx: buildFlowGraph calls `.sort()` or `.reverse()` on\n' +
      '  the `allStages` array.\n' +
      '  The ordering contract requires that stages are rendered in the exact\n' +
      '  order supplied by the caller (which derives them from Object.keys of\n' +
      '  workflow.json).  Remove the reorder call to restore correct ordering.',
    );
  } else {
    console.log(
      '[check-workflow-map-ordering] buildFlowGraph does not reorder allStages. ✓',
    );
  }
}

// ── Report ─────────────────────────────────────────────────────────────────────

if (errors.length === 0) {
  console.log(
    '\n[check-workflow-map-ordering] OK — all ordering invariants pass.',
  );
  process.exit(0);
}

process.stderr.write(
  `\n[check-workflow-map-ordering] FAILED — ${errors.length} invariant(s) violated:\n\n`,
);
for (let i = 0; i < errors.length; i++) {
  process.stderr.write(`  ${i + 1}. ${errors[i]}\n\n`);
}
process.stderr.write(
  'The Workflow Map must render stages in workflow.json key-insertion order.\n' +
  'See the "Ordering contract" comment in WorkflowMapChart.tsx (WMAllStage)\n' +
  'and CardActionsPage.tsx (fetchAll callback) for full details.\n\n',
);
process.exit(1);
