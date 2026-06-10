#!/usr/bin/env node
/**
 * scripts/check-handler-meta.mjs
 *
 * Static lint: every handler type declared in the ModalState union in
 * `src/react/components/CardActionModalsHost.tsx` must have a matching
 * entry in `HANDLER_COMPONENT_META` in `src/react/utils/handlerMeta.ts`.
 *
 * The check fails with a clear error listing any handler types that are
 * present in the host but absent from the meta map, so that a developer
 * adding a new modal cannot accidentally omit the WorkflowPage reference
 * entry.
 *
 * ── How handler types are detected ───────────────────────────────────────
 *
 * The ModalState union in CardActionModalsHost.tsx contains members of the
 * form:
 *
 *   | { type: 'schedule_visit'; … }
 *
 * This script scans for those `type: '<name>'` patterns.  The sentinel
 * variant `{ type: 'none' }` is excluded because it is not a real handler.
 *
 * ── How HANDLER_COMPONENT_META keys are detected ─────────────────────────
 *
 * The script reads `HANDLER_COMPONENT_META` as raw text and collects the
 * object-literal keys from the block that follows the `= {` opening brace,
 * matching lines of the form:
 *
 *   show_message: {
 *   add_design_visit_to_calendar: {
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
const ROOT          = resolve(__dirname, '..');
const HOST_FILE     = resolve(ROOT, 'src', 'react', 'components', 'CardActionModalsHost.tsx');
const META_FILE     = resolve(ROOT, 'src', 'react', 'utils', 'handlerMeta.ts');

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

// ── Parse HANDLER_COMPONENT_META keys from handlerMeta.ts ─────────────────
//
// Find the block starting with `export const HANDLER_COMPONENT_META` and
// scan each line for object keys of the form `  <identifier>: {`.

const META_BLOCK_START_RE = /export\s+const\s+HANDLER_COMPONENT_META[^=]*=\s*\{/;
const META_KEY_RE         = /^\s{2}([a-z_][a-z0-9_]*):\s*\{/;

const metaSrc   = readFileSync(META_FILE, 'utf8');
const metaLines = metaSrc.split('\n');
const metaKeys  = new Set();

let inBlock = false;
let depth   = 0;

for (const line of metaLines) {
  if (!inBlock) {
    if (META_BLOCK_START_RE.test(line)) {
      inBlock = true;
      depth   = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    }
    continue;
  }

  depth += (line.match(/\{/g) || []).length;
  depth -= (line.match(/\}/g) || []).length;

  if (depth <= 0) break;

  const km = META_KEY_RE.exec(line);
  if (km) metaKeys.add(km[1]);
}

// ── Cross-reference ────────────────────────────────────────────────────────

const missing = [...hostTypes].filter(t => !metaKeys.has(t)).sort();

// ── Report ─────────────────────────────────────────────────────────────────

console.log(
  `check-handler-meta: found ${hostTypes.size} handler type(s) in ModalState ` +
  `and ${metaKeys.size} key(s) in HANDLER_COMPONENT_META\n`
);

if (missing.length === 0) {
  console.log(
    '✓ Every handler type in CardActionModalsHost.tsx has a matching\n' +
    '  entry in HANDLER_COMPONENT_META (src/react/utils/handlerMeta.ts).'
  );
  process.exit(0);
}

console.error(
  `✗ ${missing.length} handler type(s) are present in ModalState ` +
  `(CardActionModalsHost.tsx) but missing from HANDLER_COMPONENT_META:\n`
);
for (const t of missing) {
  console.error(`  - ${t}`);
}
console.error(
  '\nFix: add an entry for each missing type to HANDLER_COMPONENT_META in\n' +
  '     src/react/utils/handlerMeta.ts, e.g.:\n\n' +
  '       <handler_type>: {\n' +
  '         component: \'<ModalComponentName>\',\n' +
  '         filePath:  \'src/react/components/modals/<ModalComponentName>.tsx\',\n' +
  '       },\n'
);
process.exit(1);
