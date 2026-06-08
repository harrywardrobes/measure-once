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
 * ── View-only ("view when cached") drift guard ──────────────────────────────
 * Being *viewable* offline depends on the service worker actually caching an
 * area's GET reads. The cached read routes live in ONE source of truth,
 *   scripts/offline-read-caches.mjs   (OFFLINE_READ_CACHES)
 * which scripts/build-sw.mjs consumes to build its Workbox runtimeCaching read
 * entries — so the manifest *is* the real SW behaviour. A second three-way
 * equality is asserted between:
 *
 *   1. SW     — OFFLINE_READ_CACHES (cache names + route patterns) — the GETs
 *               really cached for offline view.
 *   2. MATRIX — the union of `cachedBy` names across every `full`/`view` row in
 *               offlineCapabilities.ts.
 *   3. DOCS   — the `<!-- offline-view-cache: <cache> routes: … -->` annotations
 *               on the cache table in docs/OFFLINE.md.
 *
 * Equality is checked at TWO granularities:
 *   - cache names: SW ↔ matrix ↔ docs.
 *   - route patterns (per cache): SW (manifest) ↔ docs. So adding/removing an
 *     individual cached GET route inside an existing cache also fails CI until
 *     the docs annotation is updated.
 *
 * Plus structural rules:
 *   - Every `view` row must declare a non-empty `cachedBy`.
 *   - `online` rows must NOT declare `cachedBy`.
 *   - Every `cachedBy` name must be a real offline read cache.
 *   - build-sw.mjs must build its read caches from the manifest and must not
 *     hand-define same-origin read-route caches outside it.
 * So a `view` row can't claim offline caching the SW doesn't provide, and
 * adding/removing a cached read route forces the matrix and docs to update.
 *
 * Run via:  npm run test:offline-capability-sync
 * No server, no DB, no Puppeteer.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { OFFLINE_READ_CACHES } from './offline-read-caches.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const CAPABILITIES_FILE = join(ROOT, 'src', 'react', 'lib', 'offlineCapabilities.ts');
const QUEUE_FILE        = join(ROOT, 'src', 'react', 'lib', 'offlineQueue.ts');
const PAGE_FILE         = join(ROOT, 'src', 'react', 'pages', 'admin', 'OfflineSupportPage.tsx');
const DOCS_FILE         = join(ROOT, 'docs', 'OFFLINE.md');
const SW_FILE           = join(ROOT, 'scripts', 'build-sw.mjs');
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

// ── 3. SW: runtime read caches + route patterns (from the shared manifest) ────
//
// scripts/offline-read-caches.mjs is the single source of truth: build-sw.mjs
// builds its runtimeCaching read entries from it, so the manifest *is* the real
// SW behaviour. We read the same manifest here and validate the matrix + docs
// against it at both cache-name and route granularity.

const swReadCaches = new Set();          // cache names the SW caches reads into
const swRoutesByCache = new Map();       // cacheName -> sorted route-source list
for (const entry of OFFLINE_READ_CACHES) {
  if (!entry.cacheName) {
    failures.push('scripts/offline-read-caches.mjs has an entry with no cacheName.');
    continue;
  }
  if (!Array.isArray(entry.routes) || entry.routes.length === 0) {
    failures.push(`scripts/offline-read-caches.mjs entry '${entry.cacheName}' declares no routes — every offline read cache must list at least one GET route pattern.`);
  }
  // Every route source must be a valid RegExp (build-sw compiles these).
  for (const r of entry.routes || []) {
    try { new RegExp(r); }
    catch { failures.push(`scripts/offline-read-caches.mjs route '${r}' on '${entry.cacheName}' is not a valid RegExp source.`); }
  }
  swReadCaches.add(entry.cacheName);
  swRoutesByCache.set(entry.cacheName, sorted(new Set(entry.routes || [])));
}
if (swReadCaches.size === 0) {
  failures.push('scripts/offline-read-caches.mjs lists no offline read caches — the view-capability check cannot tell which GET reads are cached offline.');
}

// Guard: build-sw.mjs must consume the manifest and must NOT hand-define any
// same-origin read-route cache outside it (no stray `api/` route literals), so
// new cached reads can only enter via the manifest the matrix/docs are checked
// against.
const swSrc = readFileSync(SW_FILE, 'utf8');
if (!/offline-read-caches/.test(swSrc) || !/OFFLINE_READ_CACHES/.test(swSrc)) {
  failures.push('scripts/build-sw.mjs must import OFFLINE_READ_CACHES from ./offline-read-caches.mjs and build its read caches from it.');
}
if (/api\//.test(swSrc)) {
  failures.push('scripts/build-sw.mjs references an `api/` route pattern directly — same-origin read-route caches must be declared only in scripts/offline-read-caches.mjs (so the matrix/docs drift guard sees them). Move the route into that manifest.');
}

// ── 4. MATRIX: backedBy (write) + cachedBy (read-cache) across FEATURE_AREAS ───

const capSrc = readFileSync(CAPABILITIES_FILE, 'utf8');

// Isolate the FEATURE_AREAS array body so we don't match the interface, etc.
const arrMatch = capSrc.match(/FEATURE_AREAS\s*:\s*FeatureArea\[\]\s*=\s*\[([\s\S]*?)\n\];/);
if (!arrMatch) {
  console.error('❌  offline-capability-sync: could not locate the FEATURE_AREAS array in offlineCapabilities.ts');
  process.exit(1);
}
const arrBody = arrMatch[1];

// Each FEATURE_AREAS entry is a flat object literal (no nested braces), so we
// can parse row-by-row and read named fields independently of their order.
const rowBlocks = [...arrBody.matchAll(/\{[^{}]+\}/g)].map((m) => m[0]);
const parseLit = (raw) =>
  raw ? [...raw.matchAll(/'([a-zA-Z][\w-]*)'/g)].map((m) => m[1]) : [];

const matrixAreas = new Set();  // backedBy codes (write surfaces) across full rows
const matrixCaches = new Set(); // cachedBy SW cache names across full + view rows
let fullCount = 0;
let viewCount = 0;
let levelCount = 0;

for (const block of rowBlocks) {
  const capM = block.match(/capability:\s*'(full|view|online)'/);
  if (!capM) continue;
  levelCount++;
  const level = capM[1];
  const nameM = block.match(/name:\s*'([^']+)'/);
  const name = nameM ? nameM[1] : '(unnamed)';
  const backedBy = parseLit((block.match(/backedBy:\s*\[([^\]]*)\]/) || [])[1]);
  const cachedBy = parseLit((block.match(/cachedBy:\s*\[([^\]]*)\]/) || [])[1]);

  // backedBy invariants (offline write surfaces).
  if (level === 'full') {
    fullCount++;
    if (backedBy.length === 0) {
      failures.push(`The '${name}' (full) FEATURE_AREAS row has no backedBy codes (every full row must declare which offline-queue areas back it).`);
    }
    for (const c of backedBy) {
      matrixAreas.add(c);
      if (!allowedCodes.has(c)) {
        failures.push(`FEATURE_AREAS backedBy on '${name}' lists '${c}', not a member of the OfflineArea union (${sorted(allowedCodes).join(', ')}).`);
      }
    }
  } else if (backedBy.length > 0) {
    failures.push(`The '${name}' (${level}) FEATURE_AREAS row declares backedBy [${backedBy.map((c) => `'${c}'`).join(', ')}] — only 'full' rows may declare backedBy.`);
  }

  // cachedBy invariants (offline read caches that make an area viewable).
  if (level === 'view') {
    viewCount++;
    if (cachedBy.length === 0) {
      failures.push(`The '${name}' (view) FEATURE_AREAS row has no cachedBy entries — every 'view' row must name the service-worker runtime cache(s) that hold its offline-viewable reads.`);
    }
  } else if (level === 'online' && cachedBy.length > 0) {
    failures.push(`The '${name}' (online) FEATURE_AREAS row declares cachedBy [${cachedBy.map((c) => `'${c}'`).join(', ')}] — 'online' areas are not cached for offline viewing, so they must not declare cachedBy.`);
  }
  for (const c of cachedBy) {
    matrixCaches.add(c);
    if (swReadCaches.size > 0 && !swReadCaches.has(c)) {
      failures.push(`FEATURE_AREAS cachedBy on '${name}' lists '${c}', which is not a declared offline read cache (${sorted(swReadCaches).join(', ')}). Add the cache to scripts/offline-read-caches.mjs or fix the name.`);
    }
  }
}

// Sanity: number of name: entries should equal the number of capability rows.
const nameCount = [...arrBody.matchAll(/name:\s*'/g)].length;
if (nameCount !== levelCount) {
  failures.push(`Parsed ${levelCount} capability rows but found ${nameCount} name: fields in FEATURE_AREAS — the row parser may have been broken.`);
}

// ── 5. DOCS: <!-- offline-areas / offline-view-cache: … --> in OFFLINE.md ─────

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

// Each annotation is `<!-- offline-view-cache: <cacheName> routes: <r1> | <r2> -->`,
// mirroring one SW read cache and its exact route patterns at route granularity.
const docsViewCaches = new Set();
const docsRoutesByCache = new Map(); // cacheName -> sorted route-source list
let docViewCacheCount = 0;
for (const ann of docsSrc.matchAll(/<!--\s*offline-view-cache:\s*([\s\S]*?)-->/g)) {
  docViewCacheCount++;
  const body = ann[1].trim();
  const m = body.match(/^([\w-]+)\s+routes:\s*([\s\S]+)$/);
  if (!m) {
    failures.push(`docs/OFFLINE.md offline-view-cache annotation '${body}' is malformed — expected '<cacheName> routes: <pattern> ; <pattern>'.`);
    continue;
  }
  const cacheName = m[1].trim();
  docsViewCaches.add(cacheName);
  // Routes are `;`-separated (a `|` appears inside the regex patterns themselves).
  const routes = m[2].split(';').map((r) => r.trim()).filter(Boolean);
  if (routes.length === 0) {
    failures.push(`docs/OFFLINE.md offline-view-cache annotation for '${cacheName}' lists no routes.`);
  }
  docsRoutesByCache.set(cacheName, sorted(new Set(routes)));
}
if (docViewCacheCount === 0) {
  failures.push('docs/OFFLINE.md has no <!-- offline-view-cache: … --> annotations on the service-worker cache table rows.');
}

// ── 6. Page must import FEATURE_AREAS, not redefine it ────────────────────────

const pageSrc = readFileSync(PAGE_FILE, 'utf8');
if (/const\s+FEATURE_AREAS\s*[:=]/.test(pageSrc)) {
  failures.push('OfflineSupportPage.tsx defines its own FEATURE_AREAS — it must import it from src/react/lib/offlineCapabilities.ts so there is a single source of truth.');
}
if (!/FEATURE_AREAS/.test(pageSrc) || !/offlineCapabilities/.test(pageSrc)) {
  failures.push('OfflineSupportPage.tsx must import FEATURE_AREAS from ../../lib/offlineCapabilities.');
}

// ── 7. Three-way equality — write surfaces (code / matrix / docs) ──────────────

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

// ── 8. Three-way equality — read caches (SW / matrix / docs) ───────────────────

if (swReadCaches.size > 0 && !setEq(swReadCaches, matrixCaches)) {
  const onlySw = sorted([...swReadCaches].filter((c) => !matrixCaches.has(c)));
  const onlyMatrix = sorted([...matrixCaches].filter((c) => !swReadCaches.has(c)));
  if (onlySw.length) failures.push(`SW runtime read caches not claimed by any 'full'/'view' matrix row (cachedBy): ${onlySw.join(', ')}. Add a row's cachedBy in offlineCapabilities.ts so the matrix reflects what's cached offline.`);
  if (onlyMatrix.length) failures.push(`Matrix cachedBy names absent from scripts/offline-read-caches.mjs: ${onlyMatrix.join(', ')}. The SW no longer caches these reads — downgrade the row or fix the name.`);
}

if (swReadCaches.size > 0 && !setEq(swReadCaches, docsViewCaches)) {
  const onlySw = sorted([...swReadCaches].filter((c) => !docsViewCaches.has(c)));
  const onlyDocs = sorted([...docsViewCaches].filter((c) => !swReadCaches.has(c)));
  if (onlySw.length) failures.push(`Offline read caches missing from docs/OFFLINE.md <!-- offline-view-cache: … --> annotations: ${onlySw.join(', ')}.`);
  if (onlyDocs.length) failures.push(`docs/OFFLINE.md annotates read caches not present in scripts/offline-read-caches.mjs: ${onlyDocs.join(', ')}.`);
}

// ── 8b. ROUTE-LEVEL equality — manifest route patterns ↔ docs annotations ──────
// Catches drift below cache-name granularity: adding/removing an individual GET
// route inside an existing cache (e.g. a new /api/projects read in mo-customers)
// changes real offline behaviour, so the docs route list must move in lockstep.

for (const cacheName of swReadCaches) {
  if (!docsRoutesByCache.has(cacheName)) continue; // cache-name mismatch already reported above
  const swRoutes = swRoutesByCache.get(cacheName) || [];
  const docsRoutes = docsRoutesByCache.get(cacheName) || [];
  const swSet = new Set(swRoutes);
  const docsSet = new Set(docsRoutes);
  if (!setEq(swSet, docsSet)) {
    const onlySw = swRoutes.filter((r) => !docsSet.has(r));
    const onlyDocs = docsRoutes.filter((r) => !swSet.has(r));
    if (onlySw.length) failures.push(`Cache '${cacheName}' caches route(s) not documented in docs/OFFLINE.md <!-- offline-view-cache: ${cacheName} routes: … -->: ${onlySw.join(' , ')}. Update the docs annotation to match scripts/offline-read-caches.mjs.`);
    if (onlyDocs.length) failures.push(`docs/OFFLINE.md documents route(s) for '${cacheName}' that scripts/offline-read-caches.mjs no longer caches: ${onlyDocs.join(' , ')}. Remove them from the docs annotation or restore them in the manifest.`);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

if (failures.length === 0) {
  console.log(
    `✅  offline-capability-sync: capability matrix is in sync — ` +
    `${callerCount} sendOrQueue() caller${callerCount === 1 ? '' : 's'}, ` +
    `${fullCount} full row${fullCount === 1 ? '' : 's'}, ${viewCount} view row${viewCount === 1 ? '' : 's'}; ` +
    `write areas {${sorted(codeAreas).join(', ')}} match across code/matrix/docs and ` +
    `read caches {${sorted(swReadCaches).join(', ')}} match across SW/matrix/docs.`,
  );
  process.exit(0);
}

console.error(`❌  offline-capability-sync: ${failures.length} problem${failures.length === 1 ? '' : 's'} detected:\n`);
for (const f of failures) console.error(`   - ${f}`);
console.error(
  '\nThe admin Offline-support capability matrix must stay in lockstep with real\n' +
  'offline behaviour. Sources to reconcile:\n' +
  '   • code   — area: codes in sendOrQueue() callers under src/react/ (write surfaces)\n' +
  '   • SW     — offline read caches + route patterns in scripts/offline-read-caches.mjs (cached reads)\n' +
  '   • matrix — backedBy (writes) + cachedBy (read caches) on rows in src/react/lib/offlineCapabilities.ts\n' +
  '   • docs   — <!-- offline-areas: … --> + <!-- offline-view-cache: <cache> routes: … --> rows in docs/OFFLINE.md\n',
);
process.exit(1);
