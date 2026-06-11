#!/usr/bin/env node
/**
 * scripts/check-handler-meta.mjs
 *
 * Static lint: every handler type declared in the ModalState union in
 * `src/react/components/CardActionModalsHost.tsx` must have a matching
 * entry in each of the four maps in `src/react/utils/handlerMeta.ts`:
 *
 *   • HANDLER_COMPONENT_META
 *   • HANDLER_MODAL_SUMMARY
 *   • HANDLER_TYPE_LABELS
 *   • HANDLER_EMAIL_TEMPLATES
 *
 * The check fails with a clear error listing any handler types that are
 * present in the host but absent from any map, so that a developer
 * adding a new modal cannot accidentally omit entries.
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
 * ── How map keys are detected ────────────────────────────────────────────
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

const metaSrc = readFileSync(META_FILE, 'utf8');

const componentMetaKeys  = extractMapKeys(metaSrc, 'HANDLER_COMPONENT_META');
const modalSummaryKeys   = extractMapKeys(metaSrc, 'HANDLER_MODAL_SUMMARY');
const typeLabelKeys      = extractMapKeys(metaSrc, 'HANDLER_TYPE_LABELS');
const emailTemplateKeys  = extractMapKeys(metaSrc, 'HANDLER_EMAIL_TEMPLATES');

// ── Cross-reference each map ───────────────────────────────────────────────

const checks = [
  { mapName: 'HANDLER_COMPONENT_META',  keys: componentMetaKeys },
  { mapName: 'HANDLER_MODAL_SUMMARY',   keys: modalSummaryKeys  },
  { mapName: 'HANDLER_TYPE_LABELS',     keys: typeLabelKeys     },
  { mapName: 'HANDLER_EMAIL_TEMPLATES', keys: emailTemplateKeys },
];

// ── Report ─────────────────────────────────────────────────────────────────

console.log(
  `check-handler-meta: found ${hostTypes.size} handler type(s) in ModalState\n`
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
    '\n✓ Every handler type in CardActionModalsHost.tsx has a matching entry\n' +
    '  in HANDLER_COMPONENT_META, HANDLER_MODAL_SUMMARY, HANDLER_TYPE_LABELS,\n' +
    '  and HANDLER_EMAIL_TEMPLATES (src/react/utils/handlerMeta.ts).'
  );
  process.exit(0);
}

process.exit(1);
