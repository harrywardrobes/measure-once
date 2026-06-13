#!/usr/bin/env node
/**
 * scripts/check-suite-probe-counts.mjs
 *
 * For each suite row in docs/TEST_SUITES.md that documents probe labels
 * (bold **(X)** callouts), this script:
 *
 *   1. Locates the suite's test file via the package.json script definition.
 *   2. Finds the PROBE_LABELS array in that file.
 *   3. Extracts the set of probe IDs present in the implementation.
 *   4. Compares them against the probe IDs documented in TEST_SUITES.md
 *      in BOTH directions:
 *        a. Forward: probes in the test file missing from docs (impl ahead of docs).
 *        b. Reverse: probes documented in TEST_SUITES.md missing from the test
 *           file (docs ahead of impl — stale documentation).
 *
 * Fails CI with a clear message for every suite with a mismatch in either
 * direction.
 *
 * Secondary scan (non-failing): detects suites whose docs row contains probe
 * callouts but whose test file does not declare a PROBE_LABELS array.  These
 * suites are invisible to the drift check.  Known legacy suites are listed in
 * NO_PROBE_LABELS_ALLOWLIST below with a reason comment.  Any suite NOT in
 * that allowlist emits a warning so new additions are visible immediately.
 *
 * Tertiary scan (non-failing): detects suites whose docs row has NO bold **(X)**
 * probe callouts at all — i.e. the suite was never enrolled in the probe system.
 * Every such suite must either be listed in NO_PROBE_SUITES_ALLOWLIST below with
 * a short reason, or it will trigger an advisory warning so new un-labelled
 * additions are visible immediately.  This prevents the set of un-tracked suites
 * from silently growing over time without a recorded reason.
 *
 * Suites are fully skipped when:
 *   - The docs row has no bold **(X)** probe callouts AND the suite is listed in
 *     NO_PROBE_SUITES_ALLOWLIST (confirmed intentional — no probes needed), OR
 *   - The test file cannot be located from package.json scripts.
 *
 * Per-suite suppression for the reverse check:
 *   A test file may declare a PROBE_LABELS_DOC_EXTRAS constant — an array of
 *   plain probe-ID strings (e.g. ['CC-A2']) — listing IDs that appear in docs
 *   but intentionally have no dedicated entry in PROBE_LABELS (typically because
 *   two distinct doc IDs map to a single implementation probe label).  These IDs
 *   are excluded from the reverse-check failures.  Whenever PROBE_LABELS_DOC_EXTRAS
 *   is detected in any scanned test file, the script emits a non-failing advisory
 *   message naming the suite and suppressed IDs as a reminder that the preferred
 *   fix is to give each probe a distinct label so no suppression is needed.
 *
 *   Each ID listed in PROBE_LABELS_DOC_EXTRAS must NOT already have a dedicated
 *   entry in PROBE_LABELS.  If the same ID appears in both arrays the script
 *   fails CI with a "redundant PROBE_LABELS_DOC_EXTRAS entry" error, because the
 *   suppression is unnecessary and signals a stale or copy-paste mistake.
 *
 * Run via:  npm run test:suite-probe-counts
 *
 * ---------------------------------------------------------------------------
 * Authoring contract — summary for new test suites
 * ---------------------------------------------------------------------------
 * When adding a new suite that covers distinct named probes (e.g. (A), (B),
 * (ST-A)), you must:
 *
 *   1. Declare a PROBE_LABELS array near the top of the test file, one entry
 *      per probe.  Each string must begin with the probe ID in parentheses or
 *      square brackets, e.g.:
 *
 *        const PROBE_LABELS = [
 *          '(A) happy-path description',
 *          '(B) error-state description',
 *        ];
 *
 *      IDs must start with an uppercase letter; digits, hyphens, and further
 *      letters are allowed (A, F1, ST-A, CC-A, A-open, A-open-blocked, …).
 *
 *   2. List every probe ID in the matching docs/TEST_SUITES.md row using bold
 *      callout notation: **(A)**, **(ST-A)**, slash-separated for groups:
 *      **(A-open/B-open/B2-open)**.
 *
 *   3. Keep PROBE_LABELS and the docs row in sync in both directions — this
 *      script fails CI for any mismatch.  If you use PROBE_LABELS_DOC_EXTRAS
 *      to suppress a reverse-check ID, that ID must not also appear in
 *      PROBE_LABELS; duplicate entries across both arrays are a CI error.
 *
 * When adding a new suite that genuinely has no named probes (static lints,
 * binary pass/fail checks, narrative integration tests, etc.), add it to
 * NO_PROBE_SUITES_ALLOWLIST below with a one-line reason.  Omitting it will
 * cause a non-failing advisory on every CI run until it is either enrolled or
 * given real probe labels.
 *
 * See docs/TEST_SUITES.md § "Adding a new test suite" for the full checklist
 * and edge-case guidance (PROBE_LABELS_DOC_EXTRAS, NO_PROBE_LABELS_ALLOWLIST,
 * NO_PROBE_SUITES_ALLOWLIST).
 * ---------------------------------------------------------------------------
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Allowlist — suites with documented probes that intentionally have no
// PROBE_LABELS array (typically pre-dating the convention).  Each entry must
// carry a short reason explaining why it is exempt.  Any suite with doc probes
// and no PROBE_LABELS that is NOT listed here will trigger a non-failing
// warning so new omissions are visible immediately.
// ---------------------------------------------------------------------------

const NO_PROBE_LABELS_ALLOWLIST = new Map([
  // All legacy suites have been migrated to PROBE_LABELS.
]);

// ---------------------------------------------------------------------------
// Allowlist — suites with documented probe callouts whose test file cannot be
// located from package.json scripts (no script entry, or the file referenced
// by the script does not yet exist on disk).  Each entry must carry a short
// reason.  Any suite NOT listed here will trigger a non-failing advisory so
// new unresolved additions are visible immediately.
// ---------------------------------------------------------------------------

const FILE_NOT_FOUND_ALLOWLIST = new Map([
  ['test:substatus-hubspot-label-format', 'pending implementation — test file not yet written'],
  ['test:audit-log-scrolling',            'pending implementation — no package.json script yet; suite not enrolled in test:ci'],
]);

// ---------------------------------------------------------------------------
// Allowlist — suites that intentionally have NO probe callouts in docs and NO
// PROBE_LABELS array in their test file.  Each entry must carry a short reason
// explaining why named probes are not appropriate for that suite.  Any suite
// without bold **(X)** callouts in its docs row that is NOT listed here will
// trigger a non-failing advisory so new un-labelled additions are visible
// immediately.
//
// Categories used in reason comments:
//   static-lint      — binary pass/fail scan; no discrete named probes
//   static-check     — static build/artifact/drift check; binary pass/fail
//   unit-flat        — flat unit assertions on a pure function; no named probes
//   meta-test        — exercises the test infrastructure itself; probe labels N/A
//   capability-matrix— broad actor×route matrix; not decomposed into named probes
//   narrative        — integration/e2e with narrative flow; no discrete probe labels
//   smoke            — presence/smoke check; binary result, no named probes
// ---------------------------------------------------------------------------

const NO_PROBE_SUITES_ALLOWLIST = new Map([
  // -- static lints ---------------------------------------------------------
  ['test:privilege-reads',              'static-lint — binary file scan, no discrete named probes'],
  ['test:test-only-guards',            'static-lint — binary test-only hook guard scan'],
  ['test:typo-vars',                    'static-lint — binary typography drift check'],
  ['test:color-radius-vars',            'static-lint — binary colour/radius drift check'],
  ['test:css-hex-colors',               'static-lint — binary hex-literal scan'],
  ['test:var-hex-fallbacks',            'static-lint — binary var() hex-fallback scan'],
  ['test:mui-select-click',             'static-lint — binary anti-pattern scan'],
  ['test:ci-runner-sync',               'static-lint — binary CI runner sync check'],
  ['test:ci-doc-sync',                  'static-lint — binary CI doc sync check'],
  ['test:suite-descriptions',           'static-lint — binary suite description sync check'],
  ['test:browser-launch-pattern',       'static-lint — binary browser-launch pattern check'],
  ['test:story-count-sync',             'static-lint — binary story-count drift check'],
  ['test:offline-capability-sync',      'static-lint — binary offline capability sync check'],
  ['test:icon-lint',                    'static-lint — binary two-pass icon import check'],
  ['test:mount-ids',                    'static-lint — binary four-pass mount-id check'],
  ['test:inline-styles',                'static-lint — binary inline-style scan'],
  ['test:story-hex-colors',             'static-lint — binary hex-literal scan for stories'],
  ['test:component-hex-colors',         'static-lint — binary hex-literal scan for components'],
  ['test:workflow-js-no-dups',          'static-lint — binary duplicate function guard'],
  ['test:nav-key-sync',                 'static-lint — binary nav-key allow-list sync check'],
  ['test:no-config-handler-types',      'static-lint — binary contradiction check'],
  ['test:template-vars',               'static-lint — binary email template variable completeness check'],
  ['test:handler-meta',                'static-lint — binary handler-type coverage check across lookup tables'],
  ['test:handler-outcomes-drift',      'static-check — binary CJS↔TS registry parity and server contract drift guard'],
  ['test:golden-schema',               'schema-diff — golden-vs-dev DB comparison; pass/fail is the result itself'],
  ['test:migration-renames',           'db-check — DB-backed detection guard; pass/fail, no named probes'],
  ['test:lead-status-keys',            'static-lint — binary forward/reverse lead-status key sync check'],
  ['test:status-key-fields',            'static-lint — binary cross-check of handler config props'],
  ['test:bottom-nav-lint',              'static-lint — binary Icon/IconOutlined completeness check'],
  ['test:retired-tokens',               'static-lint — binary retired CSS token scan'],
  ['test:tokens-css',                   'static-lint — binary tokens.css naming convention check'],
  ['test:ls-keys',                      'static-lint — binary localStorage/sessionStorage key registry scan'],
  ['test:slot-constants-drift',         'static-lint — binary slot-constant registry drift check; pass/fail only, no named probes'],
  // -- static / build checks ------------------------------------------------
  ['test:stale-bundle',                 'static-check — binary build artifact check'],
  ['test:storybook-output-clean',       'static-check — binary Storybook output guard'],
  ['test:hubspot-credentials',          'static-check — binary CI credential presence check'],
  // -- meta test ------------------------------------------------------------
  ['test:suite-probe-counts-advisory',  'meta-test — exercises the advisory mechanism; PROBE_LABELS N/A'],
  // -- unit tests (flat assertions, no named probes) ------------------------
  ['test:resolve-action-label',         'unit-flat — 10 pure-function paths tested in flat assertions'],
  ['test:bundle-size-trend',            'unit-flat — flat assertions on trend-regression logic'],
  ['test:bundle-spike-warning',         'unit-flat — flat assertions on spike-detection logic'],
  ['test:handler-config-blocks',        'unit-flat — Vitest render checks on pure React config blocks'],
  ['test:conflicts-review-logic',       'unit-flat — Vitest assertions on pure diff/restore logic'],
  ['test:keyboard-shortcuts',           'unit-flat — pure function smoke across platform paths'],
  ['test:formatters',                   'unit-flat — flat Vitest assertions on compactRelativeTime / latestTimestamp pure functions'],
  // -- capability matrix ----------------------------------------------------
  ['test:privileges',                   'capability-matrix — 5-actor × 123-route matrix; not decomposed into named probes'],
  // -- smoke tests ----------------------------------------------------------
  ['test:window-ui-smoke',              'smoke — static chrome mount-point presence check'],
  ['test:storybook-smoke',              'smoke — story render error check across all stories'],
  // -- narrative integration / regression / e2e tests -----------------------
  ['test:lead-status-sync-customer-detail-viewer',   'narrative — single-scenario viewer role gate check'],
  ['test:lead-status-sync-customer-detail-editable', 'narrative — single-scenario manager/admin role gate check'],
  ['test:design-visit-list',            'narrative — scoping + rail assertions in narrative flow'],
  ['test:design-visit-qb-resubmit',     'narrative — QB sparse-update vs create-new branches, narrative'],
  ['test:design-visit-submitter-name',  'narrative — regression guard for submitter identity in outputs'],
  ['test:duplicate-phone-warnings',     'narrative — alert copy + disabled-submit + link checks'],
  ['test:lead-status-counts-rate-limit','narrative — single-flight, stale-cache, and retry behaviour'],
  ['test:phone-directory',              'narrative — auth gating + payload coverage, narrative'],
  ['test:phone-directory-customers',    'narrative — mock-HubSpot field mapping, narrative'],
  ['test:chunk-cache-headers',          'narrative — HTTP HEAD probes for cache-control headers'],
  ['test:admin-tab-skeletons-new',      'narrative — Suspense skeleton check for admin tabs'],
  ['test:admin-tab-skeletons-suspense', 'narrative — Suspense fallback layer check for admin tabs'],
  ['test:admin-tab-skeletons',          'narrative — in-component data skeleton layer check'],
  ['test:photo-storage-errors',         'narrative — error sanitisation across upload/delete/download paths'],
  ['test:turnstile-signout',            'narrative — bfcache fix + signed-out redirect regression guard'],
  ['test:invoice-panel-hidden',         'narrative — CSS visibility regression guard across six pages'],
  ['test:onboarding-conflicts',         'narrative — conflict detection + admin resolution e2e'],
  ['test:ideas',                        'narrative — CRUD + privilege checks for Ideas page'],
  ['test:settings-tab-load',            'narrative — race-condition regression guard for settings tab'],
  ['test:invoice-admin-controls',       'narrative — privilege gates + data scoping for QB routes'],
  ['test:qb-payment-history',           'narrative — QB payment history HTTP probe suite'],
  ['test:payment-history-component',    'unit-flat — Vitest render checks on PaymentHistory React component'],
  ['test:project-contacts-unknown-status', 'narrative — orphan-check regression guard'],
  ['test:hubspot-credential-audit',     'narrative — audit log entries on credential changes'],
  ['test:lead-status-delete-substatus-clear', 'narrative — background job verification after status delete'],
  ['test:customer-info',                'narrative — full customer-info HTTP probe suite'],
  ['test:customer-info-email-attachments', 'narrative — photo attachment path regression guard'],
  ['test:photo-approval-notification',  'narrative — audit log entries on photo approve/reject'],
  ['test:photo-reviews',                'narrative — integration test for photo-review routes'],
  ['test:design-visit',                 'narrative — full design-visit wizard + sign-off e2e'],
  ['test:visit-edit-cancel',            'narrative — PATCH + cancel confirmation e2e'],
  ['test:dv-catalogue-image-upload',    'narrative — catalogue image upload flow e2e'],
  ['test:dv-catalogue-reorder',         'narrative — catalogue reorder arrow controls e2e'],
  ['test:sign-off-stale-link',          'narrative — superseded sign-off link e2e'],
  ['test:react-admin-tabs',             'narrative — React admin island smoke test'],
  ['test:new-customer-flow',            'narrative — new customer modal e2e'],
  ['test:new-customer-counts-retry',    'narrative — count-retry logic focused integration test'],
  ['test:hubspot-429-retry',            'narrative — 429 recovery via hubspotRequestWithRetry'],
  ['test:hubspot-429-retry-contacts',   'narrative — 429 recovery for contacts-all and open-leads'],
  ['test:room-assignments-outage',      'narrative — room data served stale during HubSpot outage'],
  ['test:change-password',              'narrative — change-password dialog e2e'],
  ['test:set-password',                 'narrative — set-password page + autofill crash guard'],
  ['test:bottom-nav',                   'narrative — More drawer across roles e2e'],
  ['test:nav-active-tab',               'narrative — matchPath active-tab regression guard'],
  ['test:nav-customise',                'narrative — nav customisation dialog e2e'],
  ['test:trades',                       'narrative — trades CRUD + role gating e2e'],
  ['test:dev-mode-bc-sync',             'narrative — dev_mode_changed BroadcastChannel wiring regression'],
  ['test:skipped-photo-dashboard-link', 'narrative — dashboard link in skipped-photo notification emails'],
  ['test:active-projects-hubspot-outage','narrative — Active Projects error branch during HubSpot 502'],
  ['test:stage-scoped-pills',           'narrative — stage-tab pill filter update regression guard'],
  ['test:bundle-sizes',                 'narrative — post-build gzip size snapshot (standalone only)'],
  ['test:suite-probe-counts',           'static-lint — self-referential check; no discrete probe IDs in the implementation'],
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a map of suite name → absolute file path from package.json scripts.
 * Handles three command shapes:
 *   node test/…/run.js          — plain Node runner (.js or .mjs)
 *   node scripts/check-….mjs   — plain Node runner (.js or .mjs)
 *   vitest run src/react/…     — Vitest unit suite
 */
function buildFileMap(scripts) {
  const map = new Map();
  for (const [key, cmd] of Object.entries(scripts)) {
    if (!key.startsWith('test:') || key.endsWith(':ci')) continue;
    // node <path>.js|.mjs — path must start with test/ or scripts/
    const nodeMatch = cmd.match(/\s((?:test|scripts)\/[^\s]+\.m?js)\s*$/);
    if (nodeMatch) {
      map.set(key, join(ROOT, nodeMatch[1]));
      continue;
    }
    // vitest run <path>
    const vitestMatch = cmd.match(/^vitest\s+run\s+(\S+)$/);
    if (vitestMatch) {
      map.set(key, join(ROOT, vitestMatch[1]));
    }
  }
  return map;
}

/**
 * Extract probe IDs documented in a TEST_SUITES.md row.
 * Looks for bold **( X )** callouts.  Handles slash-separated combined
 * notation like **(A-open/B-open/B2-open)** by splitting on '/'.
 * Returns a Set of normalised ID strings such as 'A', 'ST-A', 'A-open', etc.
 */
function extractDocProbeIds(rowText) {
  const ids = new Set();
  for (const m of rowText.matchAll(/\*\*\(([^)]+)\)\*\*/g)) {
    for (const part of m[1].split('/')) {
      const trimmed = part.trim();
      if (trimmed) ids.add(trimmed);
    }
  }
  return ids;
}

/**
 * Extract probe IDs from a test file that uses a PROBE_LABELS array.
 * Returns null when no PROBE_LABELS is present (file uses a different style).
 * Otherwise returns a Set of IDs like 'A', 'F1', 'ST-A', 'A-open', etc.
 *
 * Probe IDs are the token immediately after the opening ( or [ in each string
 * literal within the array, e.g. '(A) description…' → 'A'.
 */
function extractRunJsProbeIds(src) {
  if (!src.includes('PROBE_LABELS')) return null;

  const ids = new Set();
  // Match string literals that start (after optional whitespace) with a
  // probe-label token: ( or [ followed by the ID, then ) or ] then a space.
  // The ID must begin with an uppercase letter (filters out lowercase-only
  // tokens like [pageerror] or [setup]).  After the first uppercase letter,
  // digits, hyphens, and further letters (any case) are allowed — covering
  // 'A', 'F1', 'ST-A', 'CC-A', 'A-open', 'A-open-blocked', 'SKP-A', etc.
  const pattern = /['"`]\s*[\(\[]([A-Z][A-Za-z0-9-]*)[\)\]]\s/g;
  for (const m of src.matchAll(pattern)) {
    ids.add(m[1]);
  }
  return ids.size > 0 ? ids : null;
}

/**
 * Extract the set of probe IDs listed in PROBE_LABELS_DOC_EXTRAS.
 * These are IDs that exist in docs but intentionally have no dedicated entry
 * in PROBE_LABELS (e.g. 'CC-A2' when two doc IDs map to a single impl label).
 * Returns an empty Set when the constant is absent.
 */
function extractDocExtrasProbeIds(src) {
  const arrayMatch = src.match(/PROBE_LABELS_DOC_EXTRAS\s*=\s*\[([^\]]*)\]/s);
  if (!arrayMatch) return new Set();
  const ids = new Set();
  for (const m of arrayMatch[1].matchAll(/['"`]([^'"`]+)['"`]/g)) {
    ids.add(m[1].trim());
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const docsFile = join(ROOT, 'docs', 'TEST_SUITES.md');
const pkgFile  = join(ROOT, 'package.json');

const docsSrc = readFileSync(docsFile, 'utf8');
const pkg     = JSON.parse(readFileSync(pkgFile, 'utf8'));
const fileMap = buildFileMap(pkg.scripts ?? {});

// Parse table rows: first column is the suite name, second is the description.
const suiteRows = new Map();
for (const line of docsSrc.split('\n')) {
  const m = line.match(/^\|\s*`(test:[^`]+)`\s*\|\s*(.*?)\s*\|?\s*$/);
  if (m) suiteRows.set(m[1], m[2]);
}

const forwardFailures            = [];
const reverseFailures            = [];
const docExtrasStaleFailures     = [];  // PROBE_LABELS_DOC_EXTRAS entries not present in docs
const docExtrasRedundantFailures = [];  // PROBE_LABELS_DOC_EXTRAS entries that also have a dedicated PROBE_LABELS entry
const noArrayWarn                = [];  // suites with doc probes but no PROBE_LABELS, not in allowlist
const docExtrasWarn              = [];  // suites using PROBE_LABELS_DOC_EXTRAS (non-failing advisory)
const noProbeSuiteWarn           = [];  // suites with no probe callouts AND not in NO_PROBE_SUITES_ALLOWLIST
const fileNotFoundWarn           = [];  // suites with doc probes, file not found, not in FILE_NOT_FOUND_ALLOWLIST
let   checked                    = 0;
let   skipped                    = 0;
let   allowlisted                = 0;
let   noProbeSuiteAllowlisted    = 0;
let   fileNotFoundAllowlisted    = 0;

for (const [suiteName, rowText] of suiteRows) {
  const docIds = extractDocProbeIds(rowText);

  if (docIds.size === 0) {
    // No probe callouts in docs — check whether this is a confirmed no-probe
    // suite (listed in NO_PROBE_SUITES_ALLOWLIST) or a new unlisted addition.
    if (NO_PROBE_SUITES_ALLOWLIST.has(suiteName)) {
      noProbeSuiteAllowlisted++;
    } else {
      noProbeSuiteWarn.push(suiteName);
    }
    skipped++;
    continue;
  }

  const filePath = fileMap.get(suiteName);
  if (!filePath || !existsSync(filePath)) {
    // Cannot locate the test file from package.json scripts.
    // Check the allowlist: known pending/unimplemented suites are listed there.
    // Anything NOT in the allowlist gets a non-failing advisory.
    if (FILE_NOT_FOUND_ALLOWLIST.has(suiteName)) {
      fileNotFoundAllowlisted++;
    } else {
      fileNotFoundWarn.push(suiteName);
    }
    skipped++;
    continue;
  }

  const src    = readFileSync(filePath, 'utf8');
  const runIds = extractRunJsProbeIds(src);

  if (runIds === null) {
    // File does not use a PROBE_LABELS array — cannot compare reliably.
    // Check the allowlist: known legacy suites are explicitly documented there.
    // Anything NOT in the allowlist is a new omission and gets a warning.
    if (NO_PROBE_LABELS_ALLOWLIST.has(suiteName)) {
      allowlisted++;
    } else {
      noArrayWarn.push({
        suite:  suiteName,
        file:   filePath.replace(ROOT + '/', ''),
        docIds: [...docIds].sort(),
      });
    }
    continue;
  }

  // Forward check: probes in the test file not yet mentioned in docs.
  const undoc = [...runIds].filter((id) => !docIds.has(id)).sort();
  if (undoc.length > 0) {
    forwardFailures.push({
      suite:  suiteName,
      file:   filePath.replace(ROOT + '/', ''),
      undoc,
      docIds: [...docIds].sort(),
      runIds: [...runIds].sort(),
    });
  }

  // Reverse check: probes documented in docs not found in the test file.
  // PROBE_LABELS_DOC_EXTRAS in the test file suppresses known doc-only aliases.
  const docExtras = extractDocExtrasProbeIds(src);

  // Stale-extras check (failing): each ID in PROBE_LABELS_DOC_EXTRAS must
  // actually appear in the docs row.  An entry that doesn't appear in docs is
  // unnecessary — the suppression can never be triggered.
  if (docExtras.size > 0) {
    const staleExtras = [...docExtras].filter((id) => !docIds.has(id)).sort();
    if (staleExtras.length > 0) {
      docExtrasStaleFailures.push({
        suite:       suiteName,
        file:        filePath.replace(ROOT + '/', ''),
        staleExtras,
        docIds:      [...docIds].sort(),
      });
    }
  }

  // Redundant-extras check (failing): each ID in PROBE_LABELS_DOC_EXTRAS must
  // NOT already have a dedicated PROBE_LABELS entry.  If an ID appears in both,
  // the suppression is unnecessary — the ID will pass the reverse check naturally
  // because it is already covered by a PROBE_LABELS label.
  if (docExtras.size > 0) {
    const redundantExtras = [...docExtras].filter((id) => runIds.has(id)).sort();
    if (redundantExtras.length > 0) {
      docExtrasRedundantFailures.push({
        suite:           suiteName,
        file:            filePath.replace(ROOT + '/', ''),
        redundantExtras,
        docIds:          [...docIds].sort(),
      });
    }
  }

  // Advisory (non-failing): warn when PROBE_LABELS_DOC_EXTRAS is used.
  // The preferred fix is to give each probe a distinct label so no suppression
  // is needed.
  if (docExtras.size > 0) {
    docExtrasWarn.push({
      suite:     suiteName,
      file:      filePath.replace(ROOT + '/', ''),
      extraIds:  [...docExtras].sort(),
    });
  }

  const stale = [...docIds].filter((id) => !runIds.has(id) && !docExtras.has(id)).sort();
  if (stale.length > 0) {
    reverseFailures.push({
      suite:  suiteName,
      file:   filePath.replace(ROOT + '/', ''),
      stale,
      docIds: [...docIds].sort(),
      runIds: [...runIds].sort(),
    });
  }

  checked++;
}

// ---------------------------------------------------------------------------
// Report advisories (non-failing) for suites with no probe callouts not in
// the NO_PROBE_SUITES_ALLOWLIST
// ---------------------------------------------------------------------------

if (noProbeSuiteWarn.length > 0) {
  console.warn(
    `ℹ️   suite-probe-counts: ${noProbeSuiteWarn.length} suite` +
    `${noProbeSuiteWarn.length === 1 ? '' : 's'} ` +
    `${noProbeSuiteWarn.length === 1 ? 'has' : 'have'} no probe callouts in` +
    ` TEST_SUITES.md and ${noProbeSuiteWarn.length === 1 ? 'is' : 'are'} not` +
    ` listed in NO_PROBE_SUITES_ALLOWLIST:\n`,
  );
  for (const suite of noProbeSuiteWarn) {
    console.warn(`  ${suite}`);
  }
  console.warn(
    `\n    Fix: either add probe labels (bold **(X)** callouts in the docs row\n` +
    `    and a PROBE_LABELS array in the test file), or add the suite to\n` +
    `    NO_PROBE_SUITES_ALLOWLIST in scripts/check-suite-probe-counts.mjs\n` +
    `    with a one-line reason explaining why named probes are not needed.\n`,
  );
}

// ---------------------------------------------------------------------------
// Report advisories (non-failing) for suites with doc probes whose file
// could not be located and are not in FILE_NOT_FOUND_ALLOWLIST
// ---------------------------------------------------------------------------

if (fileNotFoundWarn.length > 0) {
  console.warn(
    `ℹ️   suite-probe-counts: ${fileNotFoundWarn.length} suite` +
    `${fileNotFoundWarn.length === 1 ? '' : 's'} document` +
    `${fileNotFoundWarn.length === 1 ? 's' : ''} probe callouts but` +
    `${fileNotFoundWarn.length === 1 ? ' its' : ' their'} test file` +
    `${fileNotFoundWarn.length === 1 ? '' : 's'} could not be located` +
    ` (drift cannot be detected):\n`,
  );
  for (const suite of fileNotFoundWarn) {
    console.warn(`  ${suite}`);
  }
  console.warn(
    `\n    Fix: either implement the test suite so its file can be found via\n` +
    `    package.json scripts, or add the suite to FILE_NOT_FOUND_ALLOWLIST\n` +
    `    in scripts/check-suite-probe-counts.mjs with a one-line reason.\n`,
  );
}

// ---------------------------------------------------------------------------
// Report warnings (non-failing) for suites with doc probes but no PROBE_LABELS
// ---------------------------------------------------------------------------

if (noArrayWarn.length > 0) {
  console.warn(
    `⚠️   suite-probe-counts: ${noArrayWarn.length} suite` +
    `${noArrayWarn.length === 1 ? '' : 's'} document` +
    `${noArrayWarn.length === 1 ? 's' : ''} probe callouts in TEST_SUITES.md` +
    ` but ${noArrayWarn.length === 1 ? 'its' : 'their'} test file` +
    `${noArrayWarn.length === 1 ? '' : 's'} lack a PROBE_LABELS array` +
    ` (drift cannot be detected):\n`,
  );
  for (const { suite, file, docIds } of noArrayWarn) {
    console.warn(`  ${suite}  (${file})`);
    console.warn(`    Documented probes : ${docIds.join(', ')}`);
    console.warn(
      `    Fix: add a PROBE_LABELS array to ${file}, or add this suite` +
      ` to NO_PROBE_LABELS_ALLOWLIST in scripts/check-suite-probe-counts.mjs` +
      ` with a reason comment.\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Report advisories (non-failing) for suites using PROBE_LABELS_DOC_EXTRAS
// ---------------------------------------------------------------------------

if (docExtrasWarn.length > 0) {
  console.warn(
    `ℹ️   suite-probe-counts: ${docExtrasWarn.length} suite` +
    `${docExtrasWarn.length === 1 ? '' : 's'} use` +
    `${docExtrasWarn.length === 1 ? 's' : ''} PROBE_LABELS_DOC_EXTRAS` +
    ` to suppress the reverse check for` +
    ` ${docExtrasWarn.length === 1 ? 'a doc-only alias' : 'doc-only aliases'}.\n` +
    `    Preferred fix: give each probe a distinct label so no suppression is needed.\n`,
  );
  for (const { suite, file, extraIds } of docExtrasWarn) {
    console.warn(`  ${suite}  (${file})`);
    console.warn(`    Suppressed IDs : ${extraIds.join(', ')}\n`);
  }
}

// ---------------------------------------------------------------------------
// Report failures (exit 1) for probe mismatches in either direction
// ---------------------------------------------------------------------------

const totalFailures = forwardFailures.length + reverseFailures.length + docExtrasStaleFailures.length + docExtrasRedundantFailures.length;

if (totalFailures === 0) {
  const parts = [`all ${checked} suites with documented probes are up-to-date`];
  if (noProbeSuiteAllowlisted > 0)    parts.push(`${noProbeSuiteAllowlisted} confirmed no-probe (see NO_PROBE_SUITES_ALLOWLIST)`);
  if (noProbeSuiteWarn.length > 0)    parts.push(`${noProbeSuiteWarn.length} advisory (no probe callouts — add to NO_PROBE_SUITES_ALLOWLIST or label)`);
  if (fileNotFoundAllowlisted > 0)    parts.push(`${fileNotFoundAllowlisted} pending (see FILE_NOT_FOUND_ALLOWLIST)`);
  if (fileNotFoundWarn.length > 0)    parts.push(`${fileNotFoundWarn.length} advisory (file not found — add to FILE_NOT_FOUND_ALLOWLIST or implement)`);
  if (allowlisted > 0)                parts.push(`${allowlisted} allowlisted (no PROBE_LABELS array — see NO_PROBE_LABELS_ALLOWLIST)`);
  if (noArrayWarn.length > 0)         parts.push(`${noArrayWarn.length} warned (no PROBE_LABELS array — not in allowlist)`);
  if (docExtrasWarn.length > 0)       parts.push(`${docExtrasWarn.length} advisory (PROBE_LABELS_DOC_EXTRAS used — prefer distinct labels)`);
  console.log(`✅  suite-probe-counts: ${parts.join('; ')}`);
  process.exit(0);
}

if (forwardFailures.length > 0) {
  console.error(
    `❌  suite-probe-counts: ${forwardFailures.length} suite` +
    `${forwardFailures.length === 1 ? '' : 's'} ` +
    `${forwardFailures.length === 1 ? 'has a probe' : 'have probes'} in the test` +
    ` file not mentioned in docs/TEST_SUITES.md:\n`,
  );

  for (const { suite, file, undoc, docIds, runIds } of forwardFailures) {
    console.error(`  ${suite}  (${file})`);
    console.error(`    Documented probes : ${docIds.join(', ')}`);
    console.error(`    Probes in test    : ${runIds.join(', ')}`);
    console.error(`    Missing from docs : ${undoc.join(', ')}\n`);
  }

  console.error(
    'Update the matching rows in docs/TEST_SUITES.md to include every probe\n' +
    "label present in the suite's test file.\n",
  );
}

if (reverseFailures.length > 0) {
  console.error(
    `❌  suite-probe-counts: ${reverseFailures.length} suite` +
    `${reverseFailures.length === 1 ? '' : 's'} ` +
    `${reverseFailures.length === 1 ? 'has a probe' : 'have probes'} documented in` +
    ` docs/TEST_SUITES.md that no longer exist in the test file:\n`,
  );

  for (const { suite, file, stale, docIds, runIds } of reverseFailures) {
    console.error(`  ${suite}  (${file})`);
    console.error(`    Documented probes : ${docIds.join(', ')}`);
    console.error(`    Probes in test    : ${runIds.join(', ')}`);
    console.error(`    Stale in docs     : ${stale.join(', ')}\n`);
  }

  console.error(
    'Either remove the stale probe IDs from the matching rows in\n' +
    "docs/TEST_SUITES.md, or add them back to the suite's PROBE_LABELS array.\n" +
    'If a doc ID is intentionally a finer-grained alias for an existing label,\n' +
    "add it to a PROBE_LABELS_DOC_EXTRAS = ['<id>'] constant in the test file.\n",
  );
}

if (docExtrasStaleFailures.length > 0) {
  console.error(
    `❌  suite-probe-counts: ${docExtrasStaleFailures.length} suite` +
    `${docExtrasStaleFailures.length === 1 ? '' : 's'} ` +
    `${docExtrasStaleFailures.length === 1 ? 'has' : 'have'} unnecessary` +
    ` PROBE_LABELS_DOC_EXTRAS entries — the suppressed IDs do not appear` +
    ` in docs/TEST_SUITES.md and can never be triggered:\n`,
  );

  for (const { suite, file, staleExtras, docIds } of docExtrasStaleFailures) {
    console.error(`  ${suite}  (${file})`);
    console.error(`    Documented probes       : ${docIds.join(', ')}`);
    console.error(`    Unnecessary suppressions: ${staleExtras.join(', ')}\n`);
  }

  console.error(
    'Remove the listed IDs from the PROBE_LABELS_DOC_EXTRAS array in each\n' +
    'test file above.  Only IDs that genuinely appear in the docs row as\n' +
    'bold **(X)** callouts should be listed there.\n',
  );
}

if (docExtrasRedundantFailures.length > 0) {
  console.error(
    `❌  suite-probe-counts: ${docExtrasRedundantFailures.length} suite` +
    `${docExtrasRedundantFailures.length === 1 ? '' : 's'} ` +
    `${docExtrasRedundantFailures.length === 1 ? 'has' : 'have'} redundant` +
    ` PROBE_LABELS_DOC_EXTRAS entries — the suppressed IDs already have a` +
    ` dedicated PROBE_LABELS entry and pass the reverse check naturally:\n`,
  );

  for (const { suite, file, redundantExtras, docIds } of docExtrasRedundantFailures) {
    console.error(`  ${suite}  (${file})`);
    console.error(`    Documented probes        : ${docIds.join(', ')}`);
    console.error(`    Redundant suppressions   : ${redundantExtras.join(', ')}\n`);
  }

  console.error(
    'Remove the listed IDs from the PROBE_LABELS_DOC_EXTRAS array in each\n' +
    'test file above.  An ID only belongs in PROBE_LABELS_DOC_EXTRAS when it\n' +
    'appears in docs but has no corresponding PROBE_LABELS entry of its own.\n',
  );
}

process.exit(1);
