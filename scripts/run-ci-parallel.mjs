#!/usr/bin/env node
/**
 * scripts/run-ci-parallel.mjs
 *
 * Parallel CI runner for Measure Once.
 *
 * IMPORTANT: every test:*:ci entry in scripts/run-ci.mjs must also appear in
 * STATIC_SUITES or DB_SUITES below.  The test:ci-runner-sync step (run as part
 * of STATIC_SUITES) enforces this automatically.  If you add a new :ci suite
 * to run-ci.mjs, add it here too — otherwise it will be silently skipped on
 * any project that uses the parallel runner.
 *
 * Execution model
 * ───────────────
 *   Phase 0 — build:react  (sequential; later phases depend on the bundle)
 *   Phase 1 — static lints  (all in parallel; no server or DB required)
 *   Phase 2 — DB-isolated suites  (bounded parallel pool; each suite gets
 *              its own temp DB via scripts/with-test-db.js)
 *   Phase 3 — build:storybook (sequential), then test:storybook-output-clean
 *              and test:storybook-smoke in parallel
 *
 * Phases 1 and 2 run concurrently with each other once the build finishes.
 * Phase 3 runs concurrently with Phases 1 and 2 (the Storybook build starts
 * immediately after Phase 0 completes).
 * Within Phase 2 the pool size is controlled by the CI_PARALLEL env-var
 * (default: 5).  Raising it speeds things up; lowering it reduces peak load.
 *
 * Usage
 * ─────
 *   node scripts/run-ci-parallel.mjs          # run everything
 *   CI_PARALLEL=8 node scripts/run-ci-parallel.mjs
 *
 * Exit code
 * ─────────
 *   0  — all phases passed
 *   1  — one or more tests failed (summary printed to stderr)
 */

import { spawn }    from 'child_process';
import { platform } from 'os';

const _rawPool  = parseInt(process.env.CI_PARALLEL || '', 10);
const POOL_SIZE = (_rawPool >= 1) ? _rawPool : 5;
const NPM       = platform() === 'win32' ? 'npm.cmd' : 'npm';

// ─── Suite definitions ────────────────────────────────────────────────────────

/**
 * Phase 1: static / lint suites — no server, no DB.
 * All can run simultaneously right after the build.
 */
const STATIC_SUITES = [
  'test:stale-bundle',
  'test:bundle-size-trend',
  'test:bundle-spike-warning',
  'test:resolve-action-label',
  'test:typo-vars',
  'test:color-radius-vars',
  'test:tokens-css',
  'test:privilege-reads',
  'test:test-only-guards',
  'test:ls-keys',
  'test:migration-renames',
  'test:retired-tokens',
  'test:mount-ids',
  'test:public-island-bootstrap',
  'test:bottom-nav-lint',
  'test:icon-lint',
  'test:inline-styles',
  'test:story-hex-colors',
  'test:component-hex-colors',
  'test:css-hex-colors',
  'test:var-hex-fallbacks',
  'test:keyboard-shortcuts',
  'test:handler-config-blocks',
  'test:payment-history-component',
  'test:template-vars',
  'test:handler-meta',
  'test:handler-outcomes-drift',
  'test:slot-constants-drift',
  'test:golden-schema',
  'test:conflicts-review-logic',
  'test:lead-status-keys',
  'test:status-key-fields',
  'test:mui-select-click',
  'test:ci-runner-sync',
  'test:ci-doc-sync',
  'test:suite-descriptions',
  'test:suite-probe-counts',
  'test:suite-probe-counts-advisory',
  'test:browser-launch-pattern',
  'test:story-count-sync',
  'test:offline-capability-sync',
  'test:sw-closures',
  'test:sw-closures-fixtures',
];

/**
 * Phase 2: DB-isolated integration / E2E suites.
 * Each :ci variant wraps the test with scripts/with-test-db.js so every run
 * gets its own temporary PostgreSQL database and can safely run in parallel.
 */
const DB_SUITES = [
  'test:migration-renames:ci',
  'test:privileges:ci',
  'test:lead-status-sync:ci',
  'test:lead-status-counts-rate-limit:ci',
  'test:lead-status-delete-substatus-clear:ci',
  'test:substatus-hubspot-label-format:ci',
  'test:customer-info:ci',
  'test:customer-info-email-attachments:ci',
  'test:customer-info-resend:ci',
  'test:customer-info-generate-link-reuse:ci',
  'test:customer-info-rail:ci',
  'test:customer-info-conflict-warning:ci',
  'test:customer-info-stale-rail:ci',
  'test:superseded-tooltip:ci',
  'test:masked-email-backfill:ci',
  'test:contact-attempt-history:ci',
  'test:photo-storage-errors:ci',
  'test:lead-status-sync-customer-detail:ci',
  'test:lead-status-sync-customer-detail-viewer:ci',
  'test:lead-status-sync-customer-detail-editable:ci',
  'test:card-action-handlers:ci',
  'test:design-visit-qb-resubmit:ci',
  'test:design-visit-submitter-name:ci',
  'test:photo-approval-notification:ci',
  'test:photo-reviews:ci',
  'test:start-design-visit:ci',
  'test:start-survey-visit:ci',
  'test:survey-visit-email-notes:ci',
  'test:design-visit:ci',
  'test:design-visit-list:ci',
  'test:visit-edit-cancel:ci',
  'test:catalog-migration:ci',
  'test:questionnaire:ci',
  'test:dv-catalogue-admin:ci',
  'test:dv-catalogue-image-upload:ci',
  'test:dv-catalogue-reorder:ci',
  'test:window-ui-smoke:ci',
  'test:sign-off-stale-link:ci',
  'test:react-admin-tabs:ci',
  'test:workflow-tab:ci',
  'test:new-customer-flow:ci',
  'test:new-customer-counts-retry:ci',
  'test:duplicate-phone-warnings:ci',
  'test:hubspot-429-retry:ci',
  'test:hubspot-429-retry-contacts:ci',
  'test:design-visit-hubspot-retry:ci',
  'test:hubspot-credential-audit:ci',
  'test:lead-status-guard:ci',
  'test:phone-directory:ci',
  'test:phone-directory-customers:ci',
  'test:contacts-all-stale-fallback:ci',
  'test:contacts-stale-visibility:ci',
  'test:room-assignments-outage:ci',
  'test:change-password:ci',
  'test:set-password:ci',
  'test:login:ci',
  'test:open-deal:ci',
  'test:invoice-admin-controls:ci',
  'test:qb-payment-history:ci',
  'test:invoice-bc-sync:ci',
  'test:deposit-invoice-followup:ci',
  'test:bottom-nav:ci',
  'test:bottom-nav-default:ci',
  'test:nav-active-tab:ci',
  'test:nav-customise:ci',
  'test:nav-customise-reset:ci',
  'test:admin-tab-skeletons:ci',
  'test:admin-tab-skeletons-new:ci',
  'test:admin-tab-skeletons-suspense:ci',
  'test:room-stale-banner:ci',
  'test:room-stale-banner-visibility:ci',
  'test:trades:ci',
  'test:chunk-cache-headers:ci',
  'test:customers-pagination:ci',
  'test:active-projects-hubspot-outage:ci',
  'test:info-card-review-resend:ci',
  'test:upload-photos-copyable-link:ci',
  'test:upload-photos-modal-emitter:ci',
  'test:skipped-photo-warning:ci',
  'test:skipped-photo-dashboard-link:ci',
  'test:turnstile-signout:ci',
  'test:nav-role-config:ci',
  'test:invoice-panel-hidden:ci',
  'test:permissions-ui:ci',
  'test:ideas:ci',
  'test:onboarding-conflicts:ci',
  'test:stage-scoped-pills:ci',
  'test:open-leads-stale-visibility:ci',
  'test:project-contacts-unknown-status:ci',
  'test:project-contacts-dev-mode:ci',
  'test:conflict-digest-settings:ci',
  'test:settings-tab-load:ci',
  'test:profile-google-calendar:ci',
  'test:connect-services-modal:ci',
  'test:scheduling-past-time-guard:ci',
  'test:customer-card-action-strip:ci',
  'test:projects-top-spacing:ci',
  'test:customer-info-live-badge:ci',
  'test:dev-mode-bc-sync:ci',
  'test:upload-photos-resend-mode:ci',
  'test:active-link-expires:ci',
  'test:active-link-warning-ordering:ci',
  'test:upload-photos-modal-labels:ci',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timestamp() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function log(msg) {
  process.stdout.write(`[${timestamp()}] ${msg}\n`);
}

/**
 * Run a single npm script; returns a Promise that resolves to a result object.
 * Output is only buffered (and later printed) when the suite fails; passing
 * suites discard their output to keep peak memory low during large parallel runs.
 *
 * @param {string} scriptName - npm script to run
 * @param {Record<string,string>} [extraEnv] - extra env vars merged into process.env
 */
function runScript(scriptName, extraEnv = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks  = [];

    const child = spawn(NPM, ['run', scriptName], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   { ...process.env, ...extraEnv },
    });

    child.stdout.on('data', (d) => chunks.push({ stream: 'out', data: d }));
    child.stderr.on('data', (d) => chunks.push({ stream: 'err', data: d }));

    child.on('error', (err) => {
      resolve({
        name:       scriptName,
        ok:         false,
        durationMs: Date.now() - started,
        chunks,
        spawnErr:   err,
      });
    });

    child.on('close', (code) => {
      const ok = code === 0;
      resolve({
        name:       scriptName,
        ok,
        durationMs: Date.now() - started,
        chunks:     ok ? [] : chunks,
      });
    });
  });
}

/**
 * Print buffered output for a failed suite, prefixing every line so it is easy
 * to attribute in a long parallel log.
 */
function printFailure(result) {
  const sep = '─'.repeat(72);
  process.stderr.write(`\n${sep}\n`);
  process.stderr.write(`FAILED  ${result.name}  (${fmtMs(result.durationMs)})\n`);
  if (result.spawnErr) {
    process.stderr.write(`spawn error: ${result.spawnErr.message}\n`);
  }
  process.stderr.write(`${sep}\n`);
  for (const { data } of result.chunks) {
    process.stderr.write(data);
  }
  if (result.chunks.length && !result.chunks[result.chunks.length - 1].data.toString().endsWith('\n')) {
    process.stderr.write('\n');
  }
}

function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Phase runners ────────────────────────────────────────────────────────────

/**
 * Run a set of scripts all at once; returns all results.
 */
async function runAll(suites, label) {
  log(`${label}: starting ${suites.length} suite(s) in parallel`);
  const results = await Promise.all(suites.map((s) => {
    log(`  → ${s}`);
    return runScript(s);
  }));
  return results;
}

/**
 * Run a set of scripts through a bounded pool (POOL_SIZE concurrently).
 * Progress is logged as each suite starts and finishes.
 */
async function runPool(suites, label) {
  log(`${label}: ${suites.length} suite(s), pool size ${POOL_SIZE}`);
  const results = [];
  const queue   = [...suites];
  let   running = 0;
  let   started = 0;

  return new Promise((resolve) => {
    function maybeStart() {
      while (running < POOL_SIZE && queue.length > 0) {
        const suite = queue.shift();
        running++;
        started++;
        const idx = started;
        log(`  [${idx}/${suites.length}] start  ${suite}`);
        runScript(suite).then((result) => {
          running--;
          results.push(result);
          const status = result.ok ? 'pass ' : 'FAIL ';
          log(`  [${results.length}/${suites.length}] ${status} ${suite}  (${fmtMs(result.durationMs)})`);
          maybeStart();
          if (results.length === suites.length) resolve(results);
        });
      }
    }
    maybeStart();
  });
}

/**
 * Phase 3: build Storybook sequentially, then run the three Storybook test
 * suites in parallel, passing STORYBOOK_OUT_DIR so they reuse the artifact
 * produced by the build step rather than triggering a second build.
 * Returns all results (build failure included as a synthetic failed result
 * so it surfaces in the summary).
 */
async function runStorybookPhase() {
  log('\nPhase 3: build:storybook');
  const buildResult = await runScript('build:storybook');
  if (!buildResult.ok) {
    log(`Phase 3: build:storybook FAILED  (${fmtMs(buildResult.durationMs)})`);
    return [buildResult];
  }
  log(`Phase 3: build:storybook passed  (${fmtMs(buildResult.durationMs)})`);

  const sbEnv = { STORYBOOK_OUT_DIR: 'public/storybook' };
  const STORYBOOK_SUITES = ['test:storybook-output-clean', 'test:storybook-smoke', 'test:admin-grouped-tabs-bar-stories', 'test:tabbar-stories', 'test:design-system-page-story'];
  log(`Phase 3 (storybook): starting ${STORYBOOK_SUITES.length} suite(s) in parallel`);
  for (const s of STORYBOOK_SUITES) log(`  → ${s}`);
  return Promise.all(STORYBOOK_SUITES.map((s) => runScript(s, sbEnv)));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const wallStart = Date.now();
  log('=== Measure Once CI (parallel) ===');
  log(`Pool size for DB suites: ${POOL_SIZE}  (override with CI_PARALLEL=N)`);

  // ── Phase 0: build ──────────────────────────────────────────────────────────
  log('\nPhase 0: build:react');
  const buildResult = await runScript('build:react');
  if (!buildResult.ok) {
    process.stderr.write('\nbuild:react FAILED — aborting CI run\n');
    printFailure(buildResult);
    process.exit(1);
  }
  log(`Phase 0: build:react passed  (${fmtMs(buildResult.durationMs)})`);

  // ── Phases 1, 2 & 3: run concurrently ──────────────────────────────────────
  log('\nPhase 1 + 2 + 3: static lints, DB suites, and Storybook (running concurrently)');
  const [staticResults, dbResults, storybookResults] = await Promise.all([
    runAll(STATIC_SUITES,  'Phase 1 (static)'),
    runPool(DB_SUITES,     'Phase 2 (DB-isolated)'),
    runStorybookPhase(),
  ]);

  // ── Summary ─────────────────────────────────────────────────────────────────
  const allResults  = [...staticResults, ...dbResults, ...storybookResults];
  const failed      = allResults.filter((r) => !r.ok);
  const passed      = allResults.filter((r) => r.ok);
  const wallElapsed = Date.now() - wallStart;

  for (const r of failed) printFailure(r);

  const sep = '═'.repeat(72);
  log(`\n${sep}`);
  log(`CI summary  |  ${passed.length} passed  |  ${failed.length} failed  |  wall time ${fmtMs(wallElapsed)}`);
  log(sep);

  if (failed.length > 0) {
    log('Failed suites:');
    for (const r of failed) log(`  ✗ ${r.name}`);
    process.exit(1);
  }

  log('All suites passed.');
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[run-ci-parallel] fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
