#!/usr/bin/env node
/**
 * check-workflow-js-duplicates.mjs
 *
 * Guards against picker-cluster functions drifting back into workflow.js.
 *
 * Task #1109 moved a cluster of picker / quick-set functions from workflow.js
 * into workflow-core.js, where they now live canonically.  If any of those
 * function names is accidentally re-added to workflow.js as a top-level
 * function declaration the two files would diverge silently and callers might
 * bind to the wrong (possibly stale) copy.
 *
 * What is checked
 * ───────────────
 * The script scans `public/workflow.js` for lines that match the pattern:
 *
 *   (async )?function <GUARDED_NAME>(
 *
 * at the start of the line (after optional whitespace).  Only top-level
 * declarations are relevant — inner / nested functions are not flagged because
 * they would not shadow the global export.
 *
 * Guarded function names (canonical home: public/workflow-core.js)
 * ────────────────────────────────────────────────────────────────
 *   closeCardPicker
 *   openLeadStatusPicker
 *   openCardStagePicker
 *   openCardSubstagePicker
 *   quickSetLeadStatus
 *   _quickSetLeadStatusWithSub
 *   _fetchLocaldataForCard
 *   _lastCompletedSubstageLabel
 *   _saveCardRoomMutation
 *   _substatusesForStatus
 *   _currentSubstatusFor
 *
 * Usage:
 *   node scripts/check-workflow-js-duplicates.mjs   # exits 1 on any match
 *
 * Wired into CI via: npm run test:workflow-js-no-dups
 */

import { readFileSync } from 'fs';
import { resolve, relative, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT        = resolve(__dirname, '..');
const TARGET_FILE = resolve(ROOT, 'public', 'workflow.js');

const GUARDED = [
  'closeCardPicker',
  'openLeadStatusPicker',
  'openCardStagePicker',
  'openCardSubstagePicker',
  'quickSetLeadStatus',
  '_quickSetLeadStatusWithSub',
  '_fetchLocaldataForCard',
  '_lastCompletedSubstageLabel',
  '_saveCardRoomMutation',
  '_substatusesForStatus',
  '_currentSubstatusFor',
];

const DECLARATION_RE = new RegExp(
  `^(?:async\\s+)?function\\s+(${GUARDED.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*\\(`,
);

const src   = readFileSync(TARGET_FILE, 'utf8');
const lines = src.split('\n');

const violations = [];
for (let i = 0; i < lines.length; i++) {
  const trimmed = lines[i].trimStart();
  const m = DECLARATION_RE.exec(trimmed);
  if (m) {
    violations.push({ line: i + 1, name: m[1], text: lines[i].trimEnd() });
  }
}

const rel = relative(ROOT, TARGET_FILE);
console.log(`check-workflow-js-duplicates: scanned ${rel}`);

if (violations.length === 0) {
  console.log(
    `✓ None of the ${GUARDED.length} guarded picker functions found as top-level` +
    ` declarations in ${rel}.\n` +
    `  Canonical home: public/workflow-core.js (Card picker cluster section).`
  );
  process.exit(0);
}

console.error(
  `\n✗ ${violations.length} guarded picker function(s) found as top-level declaration(s) in ${rel}:\n`
);
for (const v of violations) {
  console.error(`  ${rel}:${v.line}  →  ${v.text}`);
}
console.error(
  `\nThese functions were moved to public/workflow-core.js in task #1109 to` +
  ` eliminate duplication.\nRemove the declaration(s) above from ${rel} and` +
  ` ensure callers use the workflow-core.js copy.`
);
process.exit(1);
