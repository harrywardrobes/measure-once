#!/usr/bin/env node
/**
 * scripts/check-handler-meta.mjs
 *
 * Static lint: every handler type declared in the ModalState union in
 * `src/react/components/CardActionModalsHost.tsx` must have a matching
 * entry in each lookup table exported from `src/react/utils/handlerMeta.ts`
 * that is typed as `Record<HandlerType, …>`.
 *
 * ── Tables that are checked ────────────────────────────────────────────────
 *
 * Rather than maintaining a hard-coded list of export names, the script
 * dynamically discovers every `export const` declaration in `handlerMeta.ts`
 * whose type annotation is `Record<HandlerType, …>`.  This means a developer
 * who adds a fifth (or sixth, …) lookup table of the same shape will
 * automatically have it covered — no script update required.
 *
 * ── How handler types are detected ────────────────────────────────────────
 *
 * The ModalState union in CardActionModalsHost.tsx contains members of the
 * form:
 *
 *   | { type: 'schedule_visit'; … }
 *
 * This script scans for those `type: '<name>'` patterns.  The sentinel
 * variant `{ type: 'none' }` is excluded because it is not a real handler.
 *
 * ── How map keys are detected ─────────────────────────────────────────────
 *
 * The script reads each named export as raw text and collects the
 * object-literal keys from the block that follows the `= {` opening brace,
 * matching lines of the form:
 *
 *   show_message: {
 *   add_design_visit_to_calendar: {
 *   arrange_visit:                'Arrange visit',
 *
 * Usage:
 *   node scripts/check-handler-meta.mjs    # exits 1 on any missing entry
 *
 * Wired into CI via: npm run test:handler-meta
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const HOST_FILE = resolve(ROOT, 'src', 'react', 'components', 'CardActionModalsHost.tsx');
const META_FILE = resolve(ROOT, 'src', 'react', 'utils', 'handlerMeta.ts');

// ── Parse handler types from the ModalState union ─────────────────────────
//
// Match lines like:  | { type: 'schedule_visit';
//                    | { type: 'contact_customer'; contactId: string; … }
// Capture the quoted type name.

const HOST_TYPE_RE = /\|\s*\{\s*type:\s*'([^']+)'/g;

const hostSrc = readFileSync(HOST_FILE, 'utf8');
const hostTypes = new Set();
for (const m of hostSrc.matchAll(HOST_TYPE_RE)) {
  const t = m[1];
  if (t !== 'none') hostTypes.add(t);
}

// ── Discover all Record<HandlerType, …> exports in handlerMeta.ts ──────────
//
// Match lines like:
//   export const HANDLER_COMPONENT_META: Record<HandlerType, HandlerComponentMeta> = {
//   export const HANDLER_TYPE_LABELS: Record<HandlerType, string> = {
//
// This means any new table added with the same type annotation is
// automatically included in the checks below without editing this script.

const RECORD_EXPORT_RE =
  /^export\s+const\s+(\w+)\s*:\s*Record\s*<\s*HandlerType\s*,/gm;

const metaSrc = readFileSync(META_FILE, 'utf8');

const discoveredExports = [];
for (const m of metaSrc.matchAll(RECORD_EXPORT_RE)) {
  discoveredExports.push(m[1]);
}

if (discoveredExports.length === 0) {
  console.error(
    'check-handler-meta: no Record<HandlerType, …> exports found in\n' +
    '  src/react/utils/handlerMeta.ts\n\n' +
    '  Expected at least one export of the form:\n' +
    '    export const MY_TABLE: Record<HandlerType, …> = { … }\n'
  );
  process.exit(1);
}

// ── Generic map-key extractor ──────────────────────────────────────────────
//
// Given the source text and an export name, finds the block starting with
// `export const <name>` and returns a Set of the top-level object keys.
// Keys can be followed by `: {`, `: '`, or `:` (covers both object-value
// and string-value entries, and padded alignment styles).

const TOP_KEY_RE = /^\s{2}([a-z_][a-z0-9_]*):/;

function extractMapKeys(src, exportName) {
  const blockStartRe = new RegExp(
    `export\\s+const\\s+${exportName}[^=]*=\\s*\\{`
  );
  const lines  = src.split('\n');
  const keys   = new Set();
  let inBlock  = false;
  let depth    = 0;

  for (const line of lines) {
    if (!inBlock) {
      if (blockStartRe.test(line)) {
        inBlock = true;
        depth   = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      }
      continue;
    }

    depth += (line.match(/\{/g) || []).length;
    depth -= (line.match(/\}/g) || []).length;

    if (depth <= 0) break;

    const km = TOP_KEY_RE.exec(line);
    if (km) keys.add(km[1]);
  }

  return keys;
}

// ── Cross-reference each dynamically-discovered map ────────────────────────

const checks = discoveredExports.map(mapName => ({
  mapName,
  keys: extractMapKeys(metaSrc, mapName),
}));

// ── Report ─────────────────────────────────────────────────────────────────

console.log(
  `check-handler-meta: found ${hostTypes.size} handler type(s) in ModalState\n` +
  `  (checking ${checks.length} Record<HandlerType, …> table(s) from handlerMeta.ts)\n`
);

let anyFailed = false;

for (const { mapName, keys } of checks) {
  const missing = [...hostTypes].filter(t => !keys.has(t)).sort();
  console.log(`  ${mapName}: ${keys.size} key(s) found`);

  if (missing.length > 0) {
    anyFailed = true;
    console.error(
      `\n  ✗ ${missing.length} handler type(s) missing from ${mapName}:`
    );
    for (const t of missing) {
      console.error(`      - ${t}`);
    }
    console.error(
      `\n    Fix: add an entry for each missing type to ${mapName} in\n` +
      `         src/react/utils/handlerMeta.ts\n`
    );
  }
}

if (!anyFailed) {
  console.log(
    `\n✓ Every handler type in CardActionModalsHost.tsx has a matching entry\n` +
    `  in all ${checks.length} Record<HandlerType, …> table(s) found in\n` +
    `  src/react/utils/handlerMeta.ts:\n` +
    checks.map(c => `    • ${c.mapName}`).join('\n')
  );
  process.exit(0);
}

process.exit(1);
