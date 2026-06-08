#!/usr/bin/env node
/**
 * scripts/check-offline-capability-sync.mjs
 *
 * Static lint that stops the admin "Offline support" capability matrix from
 * silently drifting away from the app's actual offline behaviour.
 *
 * The matrix lives in the single source of truth
 *   src/react/lib/offlineCapabilities.ts   (FEATURE_AREAS)
 * and is rendered directly by src/react/pages/admin/OfflineSupportPage.tsx.
 *
 * Every area marked `full` (works offline) declares `backedBy: [...]` — the
 * offline-queue area codes whose `sendOrQueue()` writes make it work offline.
 * This script asserts a three-way equality between:
 *
 *   1. CODE   — the `area:` codes actually passed to `sendOrQueue()` callers
 *               under src/react/ (the real covered write surfaces).
 *   2. MATRIX — the union of `backedBy` codes across every `full` FEATURE_AREAS
 *               row in offlineCapabilities.ts.
 *   3. DOCS   — the `<!-- offline-areas: … -->` annotations on the "Covered
 *               write surfaces" table rows in docs/OFFLINE.md.
 *
 * If any of the three disagree the script fails with a clear message, so adding
 * or removing an offline-capable surface forces the matrix and docs to be
 * updated in lockstep.
 *
 * Additional invariants enforced:
 *   - Every `full` row must declare a non-empty `backedBy`.
 *   - `view` / `online` rows must NOT declare `backedBy`.
 *   - Every code used anywhere must be a member of the `OfflineArea` union in
 *     src/react/lib/offlineQueue.ts.
 *   - OfflineSupportPage.tsx must import FEATURE_AREAS (not redefine it).
 *
 * Run via:  npm run test:offline-capability-sync
 * No server, no DB, no Puppeteer.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const CAPABILITIES_FILE = join(ROOT, 'src', 'react', 'lib', 'offlineCapabilities.ts');
const QUEUE_FILE        = join(ROOT, 'src', 'react', 'lib', 'offlineQueue.ts');
const PAGE_FILE         = join(ROOT, 'src', 'react', 'pages', 'admin', 'OfflineSupportPage.tsx');
const DOCS_FILE         = join(ROOT, 'docs', 'OFFLINE.md');
const REACT_DIR         = join(ROOT, 'src', 'react');

const failures = [];

const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const sorted = (s) => [...s].sort();

// ── 1. Allowed area codes from the OfflineArea type union ─────────────────────

function readOfflineAreaCodes(src) {
  const m = src.match(/export type OfflineArea\s*=\s*([^;]+);/);
  if (!m) return null;
  const codes = new Set();
  for (const lit of m[1].matchAll(/'([a-zA-Z]+)'/g)) codes.add(lit[1]);
  return codes;
}

const allowedCodes = readOfflineAreaCodes(readFileSync(QUEUE_FILE, 'utf8'));
if (!allowedCodes) {
  console.error('❌  offline-capability-sync: could not parse the OfflineArea union from src/react/lib/offlineQueue.ts');
  process.exit(1);
}

// ── 2. CODE: area codes used by real sendOrQueue() callers ────────────────────

function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const SKIP_FILES = new Set([QUEUE_FILE, CAPABILITIES_FILE, join(ROOT, 'src', 'react', 'lib', 'syncEngine.ts')]);

const codeAreas = new Set();
let callerCount = 0;
for (const file of listSourceFiles(REACT_DIR)) {
  if (SKIP_FILES.has(file)) continue;
  const src = readFileSync(file, 'utf8');
  // Each sendOrQueue({ ... }) call: capture the first `area: '<code>'` inside it.
  for (const call of src.matchAll(/sendOrQueue\s*\(\s*\{[\s\S]*?area:\s*'([a-zA-Z]+)'/g)) {
    callerCount++;
    codeAreas.add(call[1]);
  }
}

if (callerCount === 0) {
  console.error('❌  offline-capability-sync: found no sendOrQueue() callers under src/react — parser likely broke.');
  process.exit(1);
}

for (const code of codeAreas) {
  if (!allowedCodes.has(code)) {
    failures.push(`sendOrQueue() uses area '${code}' which is not a member of the OfflineArea union (${sorted(allowedCodes).join(', ')}).`);
  }
}

// ── 3. MATRIX: backedBy codes across full FEATURE_AREAS rows ──────────────────

const capSrc = readFileSync(CAPABILITIES_FILE, 'utf8');

// Isolate the FEATURE_AREAS array body so we don't match the interface, etc.
const arrMatch = capSrc.match(/FEATURE_AREAS\s*:\s*FeatureArea\[\]\s*=\s*\[([\s\S]*?)\n\];/);
if (!arrMatch) {
  console.error('❌  offline-capability-sync: could not locate the FEATURE_AREAS array in offlineCapabilities.ts');
  process.exit(1);
}
const arrBody = arrMatch[1];

const matrixAreas = new Set();
let fullCount = 0;
let levelCount = 0;
// Authoring convention: on `full` rows, backedBy directly follows capability.
const rowRe = /capability:\s*'(full|view|online)'(?:\s*,\s*backedBy:\s*\[([^\]]*)\])?/g;
for (const row of arrBody.matchAll(rowRe)) {
  levelCount++;
  const level = row[1];
  const backedByRaw = row[2];
  const codes = backedByRaw
    ? [...backedByRaw.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1])
    : [];
  if (level === 'full') {
    fullCount++;
    if (codes.length === 0) {
      failures.push("A 'full' FEATURE_AREAS row has no backedBy codes (every full row must declare which offline-queue areas back it).");
    }
    for (const c of codes) {
      matrixAreas.add(c);
      if (!allowedCodes.has(c)) {
        failures.push(`FEATURE_AREAS backedBy lists '${c}', not a member of the OfflineArea union (${sorted(allowedCodes).join(', ')}).`);
      }
    }
  } else if (codes.length > 0) {
    failures.push(`A '${level}' FEATURE_AREAS row declares backedBy [${codes.map((c) => `'${c}'`).join(', ')}] — only 'full' rows may declare backedBy.`);
  }
}

// Sanity: number of name: entries should equal the number of capability rows parsed.
const nameCount = [...arrBody.matchAll(/name:\s*'/g)].length;
if (nameCount !== levelCount) {
  failures.push(`Parsed ${levelCount} capability rows but found ${nameCount} name: fields in FEATURE_AREAS — the parser convention (capability before backedBy/detail) may have been broken.`);
}

// ── 4. DOCS: <!-- offline-areas: … --> annotations in OFFLINE.md ──────────────

const docsSrc = readFileSync(DOCS_FILE, 'utf8');
const docsAreas = new Set();
let docAnnotationCount = 0;
for (const ann of docsSrc.matchAll(/<!--\s*offline-areas:\s*([^>]*?)-->/g)) {
  docAnnotationCount++;
  for (const c of ann[1].split(',')) {
    const code = c.trim();
    // Ignore non-code placeholders (e.g. the `…` in the explanatory note).
    if (/^[a-z]+$/.test(code)) docsAreas.add(code);
  }
}
if (docAnnotationCount === 0) {
  failures.push('docs/OFFLINE.md has no <!-- offline-areas: … --> annotations on the "Covered write surfaces" rows.');
}

// ── 5. Page must import FEATURE_AREAS, not redefine it ────────────────────────

const pageSrc = readFileSync(PAGE_FILE, 'utf8');
if (/const\s+FEATURE_AREAS\s*[:=]/.test(pageSrc)) {
  failures.push('OfflineSupportPage.tsx defines its own FEATURE_AREAS — it must import it from src/react/lib/offlineCapabilities.ts so there is a single source of truth.');
}
if (!/FEATURE_AREAS/.test(pageSrc) || !/offlineCapabilities/.test(pageSrc)) {
  failures.push('OfflineSupportPage.tsx must import FEATURE_AREAS from ../../lib/offlineCapabilities.');
}

// ── 6. Three-way equality ─────────────────────────────────────────────────────

if (!setEq(codeAreas, matrixAreas)) {
  const onlyCode = sorted([...codeAreas].filter((c) => !matrixAreas.has(c)));
  const onlyMatrix = sorted([...matrixAreas].filter((c) => !codeAreas.has(c)));
  if (onlyCode.length) failures.push(`Area codes used by sendOrQueue() but NOT backed by any 'full' matrix row: ${onlyCode.join(', ')}. Add/upgrade a FEATURE_AREAS row (backedBy) in offlineCapabilities.ts.`);
  if (onlyMatrix.length) failures.push(`Area codes claimed by a 'full' matrix row but NOT used by any sendOrQueue() caller: ${onlyMatrix.join(', ')}. Downgrade the row or remove the stale backedBy code in offlineCapabilities.ts.`);
}

if (!setEq(codeAreas, docsAreas)) {
  const onlyCode = sorted([...codeAreas].filter((c) => !docsAreas.has(c)));
  const onlyDocs = sorted([...docsAreas].filter((c) => !codeAreas.has(c)));
  if (onlyCode.length) failures.push(`Area codes used by sendOrQueue() but missing from docs/OFFLINE.md "Covered write surfaces" annotations: ${onlyCode.join(', ')}.`);
  if (onlyDocs.length) failures.push(`Area codes annotated in docs/OFFLINE.md but NOT used by any sendOrQueue() caller: ${onlyDocs.join(', ')}.`);
}

// ── Report ────────────────────────────────────────────────────────────────────

if (failures.length === 0) {
  console.log(
    `✅  offline-capability-sync: capability matrix is in sync — ` +
    `${callerCount} sendOrQueue() caller${callerCount === 1 ? '' : 's'}, ` +
    `${fullCount} full row${fullCount === 1 ? '' : 's'}, ` +
    `areas {${sorted(codeAreas).join(', ')}} match across code, matrix, and docs.`,
  );
  process.exit(0);
}

console.error(`❌  offline-capability-sync: ${failures.length} problem${failures.length === 1 ? '' : 's'} detected:\n`);
for (const f of failures) console.error(`   - ${f}`);
console.error(
  '\nThe admin Offline-support capability matrix must stay in lockstep with real\n' +
  'offline behaviour. Sources to reconcile:\n' +
  '   • code   — area: codes in sendOrQueue() callers under src/react/\n' +
  '   • matrix — backedBy codes on full rows in src/react/lib/offlineCapabilities.ts\n' +
  '   • docs   — <!-- offline-areas: … --> rows in docs/OFFLINE.md\n',
);
process.exit(1);
