#!/usr/bin/env node
/**
 * check-status-key-fields.mjs
 *
 * Cross-checks `KNOWN_STATUS_KEY_FIELDS` in HandlerConfigBlocks.tsx against every
 * dedicated config-block Props interface that uses the `*Invalid` companion-prop
 * convention to signal stale status-key references.
 *
 * Convention: if a *ConfigProps interface declares `fooBarInvalid?: boolean`,
 * that boolean is the staleness flag for the status-key string prop `fooBar`.
 * Every such `fooBar` field MUST appear in `KNOWN_STATUS_KEY_FIELDS` so the JSON
 * fallback editor (ActionHandlersPage.tsx) can detect stale references uniformly.
 *
 * This lint catches the case where a new handler type adds a status-key prop with
 * an `*Invalid` companion but forgets to register it in `KNOWN_STATUS_KEY_FIELDS`.
 *
 * Checks performed
 * ────────────────
 * 1. Parse `KNOWN_STATUS_KEY_FIELDS` from HandlerConfigBlocks.tsx and collect the
 *    set of registered `field` names.
 * 2. Scan every `export interface *ConfigProps` block in the same file for props
 *    matching `someName?: boolean` where `someName` ends with `Invalid` — these are
 *    the staleness-flag companions for status-key string props.
 * 3. Derive the base field name (strip the trailing `Invalid` suffix) and assert it
 *    is present in the `KNOWN_STATUS_KEY_FIELDS` set.
 * 4. Verify that ActionHandlersPage.tsx still (a) imports `KNOWN_STATUS_KEY_FIELDS`
 *    as a value (not just a type) from `./HandlerConfigBlocks`, (b) iterates it
 *    with a `for (const … of KNOWN_STATUS_KEY_FIELDS)` loop — the canonical stale-
 *    detection pattern — (c) the loop body still references `jsonStaleLsRefs`
 *    (the push target variable), and (d) the loop body also contains a `.push(`
 *    call, so a gutted body or one where the push target was renamed but only a
 *    stale comment remains is also caught.
 *    If any of these invariants breaks, stale-key detection in the JSON fallback
 *    editor silently stops working even though KNOWN_STATUS_KEY_FIELDS is correctly
 *    populated.
 *
 * Exit codes:
 *   0 — all status-key fields are registered; no violations
 *   1 — one or more fields are missing from KNOWN_STATUS_KEY_FIELDS
 *
 * Usage:
 *   node scripts/check-status-key-fields.mjs
 *
 * Wired into CI via: npm run test:status-key-fields
 */

import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

const HANDLER_CONFIG_BLOCKS = join(
  ROOT,
  'src/react/pages/admin/HandlerConfigBlocks.tsx',
);

const ACTION_HANDLERS_PAGE = join(
  ROOT,
  'src/react/pages/admin/ActionHandlersPage.tsx',
);

const source = readFileSync(HANDLER_CONFIG_BLOCKS, 'utf8');

// ── Step 1: extract KNOWN_STATUS_KEY_FIELDS entries ───────────────────────────

/**
 * Locate the KNOWN_STATUS_KEY_FIELDS array literal and pull out every
 * `field: 'xxx'` or `field: "xxx"` entry inside it.
 */
const ARRAY_BLOCK_RE =
  /KNOWN_STATUS_KEY_FIELDS[^=]*=\s*\[([^\]]*)\]\s*as\s+const/s;

const arrayMatch = source.match(ARRAY_BLOCK_RE);
if (!arrayMatch) {
  process.stderr.write(
    '[check-status-key-fields] ERROR: Could not locate KNOWN_STATUS_KEY_FIELDS ' +
    'array in HandlerConfigBlocks.tsx.\n' +
    'Has it been renamed, moved, or reformatted?\n',
  );
  process.exit(1);
}

const FIELD_RE = /field:\s*['"]([^'"]+)['"]/g;
/** @type {string[]} */
const knownFields = [];
let fm;
while ((fm = FIELD_RE.exec(arrayMatch[1])) !== null) {
  knownFields.push(fm[1]);
}

if (knownFields.length === 0) {
  process.stderr.write(
    '[check-status-key-fields] ERROR: KNOWN_STATUS_KEY_FIELDS appears to be ' +
    'empty or could not be parsed.\n',
  );
  process.exit(1);
}

const knownSet = new Set(knownFields);

console.log(
  `[check-status-key-fields] KNOWN_STATUS_KEY_FIELDS has ${knownFields.length} ` +
  `field(s): ${knownFields.map(f => `'${f}'`).join(', ')}.`,
);

// ── Step 2: find *ConfigProps interfaces and their *Invalid companion props ────

/**
 * Match each `export interface *ConfigProps { … }` block.
 * We use a simple line-based state machine rather than a regex over the full
 * source, because interface bodies can span many lines with arbitrary content.
 */
const lines = source.split('\n');

/** @type {Array<{interfaceName: string, field: string, line: number}>} */
const detected = [];

/** @type {string | null} */
let currentInterface = null;
let braceDepth = 0;

// Matches lines like: `  someNameInvalid?: boolean;`
// Group 1 = the part before "Invalid"
const INVALID_PROP_RE = /^\s*(\w+)Invalid\??\s*:\s*boolean\s*;?\s*$/;

// Matches exported ConfigProps interface declarations
const INTERFACE_DECL_RE = /^export\s+interface\s+(\w+ConfigProps)\b/;

for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];

  if (currentInterface === null) {
    const m = raw.match(INTERFACE_DECL_RE);
    if (m) {
      currentInterface = m[1];
      braceDepth = 0;
      // The opening brace may be on the same line
      for (const ch of raw) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
      }
      if (braceDepth <= 0) {
        // Single-line interface (rare but guard it)
        currentInterface = null;
      }
    }
  } else {
    // We are inside an interface block; track brace depth
    for (const ch of raw) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
    }

    // Check for *Invalid companion prop before potentially closing
    const propMatch = raw.match(INVALID_PROP_RE);
    if (propMatch) {
      detected.push({
        interfaceName: currentInterface,
        field: propMatch[1],
        line: i + 1,
      });
    }

    if (braceDepth <= 0) {
      currentInterface = null;
    }
  }
}

console.log(
  `[check-status-key-fields] Found ${detected.length} *Invalid companion ` +
  `prop(s) across all *ConfigProps interface(s).`,
);

// ── Step 3: cross-check detected fields against KNOWN_STATUS_KEY_FIELDS ───────

/** @type {Array<{interfaceName: string, field: string, line: number}>} */
const violations = [];

for (const entry of detected) {
  if (!knownSet.has(entry.field)) {
    violations.push(entry);
  }
}

// ── Check 4: KNOWN_STATUS_KEY_FIELDS is imported and iterated in the JSON ─────
//             fallback loop inside ActionHandlersPage.tsx

/**
 * Two invariants must hold in ActionHandlersPage.tsx:
 *
 * A) KNOWN_STATUS_KEY_FIELDS must be listed in a value-import from
 *    './HandlerConfigBlocks' (not just a type import).  If the symbol is
 *    dropped from the import the loop silently does nothing.
 *
 * B) KNOWN_STATUS_KEY_FIELDS must be iterated directly inside the stale-
 *    detection loop — the canonical pattern is:
 *      `for (const <var> of KNOWN_STATUS_KEY_FIELDS)`
 *    If this loop is refactored away (e.g. replaced with a forEach or removed
 *    entirely) stale-key detection in the JSON fallback editor breaks silently.
 */

const ahpSource = readFileSync(ACTION_HANDLERS_PAGE, 'utf8');

/** @type {string[]} */
const check4Errors = [];

// ── 4A: value-import check ────────────────────────────────────────────────────
// We look for `KNOWN_STATUS_KEY_FIELDS` appearing on a non-`import type` line
// that belongs to an import from './HandlerConfigBlocks'.  We use a simple
// multiline block match: find every `import { … } from './HandlerConfigBlocks'`
// block that is NOT a pure type-import, then check whether the identifier
// appears inside it.
//
// Regex: matches `import {…} from './HandlerConfigBlocks'` (value imports only).
// The `s` flag lets `.` cross newlines.
const VALUE_IMPORT_RE =
  /import\s*\{([^}]*)\}\s*from\s*['"]\.\/HandlerConfigBlocks['"]/gs;

let foundValueImport = false;
let importMatch;
while ((importMatch = VALUE_IMPORT_RE.exec(ahpSource)) !== null) {
  // The block contains the symbols — check if KNOWN_STATUS_KEY_FIELDS is one
  const importedNames = importMatch[1];
  if (/\bKNOWN_STATUS_KEY_FIELDS\b/.test(importedNames)) {
    foundValueImport = true;
    break;
  }
}

if (!foundValueImport) {
  check4Errors.push(
    'KNOWN_STATUS_KEY_FIELDS is not present in a value import from ' +
    "'./HandlerConfigBlocks' in ActionHandlersPage.tsx.\n" +
    '  If the import was converted to `import type` or removed, the stale-\n' +
    '  detection loop will silently do nothing at runtime.',
  );
}

// ── 4B: loop usage check ──────────────────────────────────────────────────────
// Assert that the file contains a `for (const <var> of KNOWN_STATUS_KEY_FIELDS`
// expression — the canonical iteration pattern used by the JSON fallback stale-
// detection block.  Any other iteration form (forEach, reduce, map) would also
// be acceptable, but this specific pattern is the one the codebase uses, and
// requiring it to remain unchanged makes accidental removals detectable.
const LOOP_RE = /for\s*\(\s*const\s+\w+\s+of\s+KNOWN_STATUS_KEY_FIELDS\b/;

if (!LOOP_RE.test(ahpSource)) {
  check4Errors.push(
    'ActionHandlersPage.tsx no longer contains a ' +
    '`for (const … of KNOWN_STATUS_KEY_FIELDS)` loop.\n' +
    '  The JSON-fallback stale-detection block iterates KNOWN_STATUS_KEY_FIELDS\n' +
    '  to flag stale lead-status / sub-status keys in the JSON editor.  If the\n' +
    '  loop was refactored or removed, stale-key detection is silently broken.',
  );
}

// ── 4C: loop body check ───────────────────────────────────────────────────────
// The loop header can survive while the body is accidentally deleted or gutted
// (e.g. during a merge-conflict resolution).  This check finds the loop header,
// extracts the brace-balanced body that follows it, and asserts two things:
//
//   C1. The push-target variable `jsonStaleLsRefs` is referenced in the body.
//       Catches a gutted body or one cleared during a bad merge.
//
//   C2. A `.push(` call appears in the body.
//       Catches the case where `jsonStaleLsRefs` survives only in a comment
//       while the actual push was deleted, or where the variable was renamed
//       and only a stale comment preserving the old name remains.
//
// Requiring both C1 and C2 means either a variable rename or a comment-only
// reference will be detected, whichever happens first.
//
// We only run this check when the loop header was found (4B passed), so that
// 4B and 4C failures are reported independently rather than cascading.
if (LOOP_RE.test(ahpSource)) {
  const loopHeaderMatch = LOOP_RE.exec(ahpSource);
  // Find the opening `{` of the loop body (search forward from the header end)
  const afterHeader = ahpSource.slice(loopHeaderMatch.index + loopHeaderMatch[0].length);
  const openBraceIdx = afterHeader.indexOf('{');
  if (openBraceIdx === -1) {
    check4Errors.push(
      'ActionHandlersPage.tsx: the `for (const … of KNOWN_STATUS_KEY_FIELDS)` ' +
      'loop header was found but is not followed by an opening `{`.\n' +
      '  The stale-detection loop body appears to be missing entirely.',
    );
  } else {
    // Walk forward tracking brace depth to extract the full loop body
    let depth = 0;
    let bodyEnd = -1;
    for (let i = openBraceIdx; i < afterHeader.length; i++) {
      if (afterHeader[i] === '{') depth++;
      else if (afterHeader[i] === '}') {
        depth--;
        if (depth === 0) {
          bodyEnd = i;
          break;
        }
      }
    }
    const loopBody = bodyEnd !== -1
      ? afterHeader.slice(openBraceIdx, bodyEnd + 1)
      : afterHeader.slice(openBraceIdx);

    // C1: push-target variable name must appear in the body
    if (!/\bjsonStaleLsRefs\b/.test(loopBody)) {
      check4Errors.push(
        'ActionHandlersPage.tsx: the `for (const … of KNOWN_STATUS_KEY_FIELDS)` ' +
        'loop body no longer references `jsonStaleLsRefs`.\n' +
        '  The loop header is present but the body appears to have been emptied,\n' +
        '  gutted, or the push-target variable was renamed — stale-key detection\n' +
        '  in the JSON fallback editor is silently broken.  Restore the loop body\n' +
        '  that pushes to `jsonStaleLsRefs` (or update this check if the variable\n' +
        '  is intentionally renamed).',
      );
    }

    // C2: an actual `.push(` call must appear in the body.
    // Prevents a comment-only reference to `jsonStaleLsRefs` from satisfying C1
    // while the real push statement is absent.
    if (!/\.push\(/.test(loopBody)) {
      check4Errors.push(
        'ActionHandlersPage.tsx: the `for (const … of KNOWN_STATUS_KEY_FIELDS)` ' +
        'loop body does not contain a `.push(` call.\n' +
        '  The loop header (and possibly the variable name) are present, but the\n' +
        '  actual push that accumulates stale-key warnings appears to be missing.\n' +
        '  Restore the `.push(…)` statement inside the loop body.',
      );
    }
  }
}

if (check4Errors.length > 0) {
  process.stderr.write(
    '\n[check-status-key-fields] CHECK 4 FAILURES ' +
    `(${check4Errors.length}):\n\n`,
  );
  for (const msg of check4Errors) {
    process.stderr.write(`  • ${msg}\n\n`);
  }
  process.stderr.write(
    'Restore the import and/or the loop in ActionHandlersPage.tsx — see the\n' +
    'comment block around the `jsonStaleLsRefs` variable for context.\n\n',
  );
  // Fall through so that Check 3 violations are also reported below.
}

// ── Report ────────────────────────────────────────────────────────────────────

const allClear = violations.length === 0 && check4Errors.length === 0;

if (allClear) {
  console.log(
    '[check-status-key-fields] OK — all status-key companion props are ' +
    'registered in KNOWN_STATUS_KEY_FIELDS, and ActionHandlersPage.tsx ' +
    'correctly imports and iterates the list.',
  );
  process.exit(0);
}

if (violations.length > 0) {
  process.stderr.write(
    `\n[check-status-key-fields] CHECK 3 VIOLATIONS (${violations.length}):\n\n`,
  );

  for (const { interfaceName, field, line } of violations) {
    process.stderr.write(
      `  Line ${line}: '${field}Invalid' found in ${interfaceName} but ` +
      `'${field}' is NOT in KNOWN_STATUS_KEY_FIELDS.\n`,
    );
  }

  process.stderr.write(`
A *ConfigProps interface has a boolean \`<field>Invalid\` companion prop, which
signals that \`<field>\` stores a lead-status or sub-status key.  The JSON
fallback editor in ActionHandlersPage.tsx scans KNOWN_STATUS_KEY_FIELDS to
detect stale status references — if the field is missing from that list, stale
keys will go undetected when users fall back to the JSON editor.

To fix:
  Add an entry for each missing field to KNOWN_STATUS_KEY_FIELDS in
  src/react/pages/admin/HandlerConfigBlocks.tsx, specifying its \`field\`,
  \`label\`, and \`type\` ('lead_status' or 'lead_status_or_substatus').

`);
}

process.exit(1);
