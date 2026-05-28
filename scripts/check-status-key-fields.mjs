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

// ── Report ────────────────────────────────────────────────────────────────────

if (violations.length === 0) {
  console.log(
    '[check-status-key-fields] OK — all status-key companion props are ' +
    'registered in KNOWN_STATUS_KEY_FIELDS.',
  );
  process.exit(0);
}

process.stderr.write(
  `\n[check-status-key-fields] VIOLATIONS (${violations.length}):\n\n`,
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

process.exit(1);
