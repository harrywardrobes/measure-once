'use strict';
const { makeSkip } = require('../helpers/report');
// test/lead-status-sync/customer-detail-viewer.js
//
// Isolated end-to-end test: the lead-status pill in #workflow-header is
// read-only for viewer-role users.
//
// This file intentionally boots its own fresh browser with no prior admin
// pages or request-interception sessions.  That removes the risk of probe [G]
// in customer-detail.js being silently affected by dirty state left by the
// admin probes (C–F) that precede it in the combined suite.
//
// Regression guard for the `canEditPipeline()` gate in
// CustomerDetailHeader (src/react/pages/customer-detail/CustomerDetailHeader.tsx).
// If that guard ever regresses, viewer-role users would see a clickable pill
// that opens the unified picker and can submit status changes.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:lead-status-sync-customer-detail-viewer
//   # or against the shared DB with the privtest- prefix cleanup:
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:lead-status-sync-customer-detail-viewer

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const {
  spawnServer,
  waitForServer,
  seedUsers,
  cleanupTestData,
  resetRateLimitStore,
  login,
  setPool,
  PASSWORD,
  BASE,
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

// ── test fixtures ─────────────────────────────────────────────────────────────
const KEY_A       = 'PRIVTEST_LSV_A';
const KEY_B       = 'PRIVTEST_LSV_B';
const LABEL_A     = 'PrivTest Viewer Status A';
const LABEL_B     = 'PrivTest Viewer Status B';
const CONTACT_ID  = '999999999';

// ── helpers ───────────────────────────────────────────────────────────────────
async function waitFor(page, predFn, args = {}, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(predFn, args);
    if (ok) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

function parseCookieKV(jar) {
  if (!jar) return null;
  const idx = jar.indexOf('=');
  if (idx < 0) return null;
  return { name: jar.slice(0, idx), value: jar.slice(idx + 1) };
}

// Seed window.__moHeaderUser + state, load statuses from the server, and
// render the workflow header so the pill is present.
// Mirrors the same technique used by probe [G] in customer-detail.js.
async function bootstrapHeader(page, lsKey, role) {
  return page.evaluate(async (currentLs, userRole) => {
    // React manages its own DOM — do NOT wipe #workflow-view's innerHTML here.
    // Just seed the globals and let renderWorkflowHeader() drive a React state
    // update (flushSync) so the component re-renders with the new contact.

    if (typeof loadLeadStatuses === 'function')    await loadLeadStatuses();
    if (typeof loadLeadSubstatuses === 'function') await loadLeadSubstatuses();

    state.selectedContact = {
      id: '999999999',
      properties: {
        hs_lead_status: currentLs,
        hw_lead_substatus: '',
        firstname: 'Viewer', lastname: 'Test', email: 'viewertest@privtest.local',
      },
    };
    state.selectedContactId = '999999999';
    state.user = { privilege_level: userRole };
    window.__moHeaderUser = { privilege_level: userRole };
    if (typeof renderWorkflowHeader === 'function') renderWorkflowHeader();
  }, lsKey, role);
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const hasTestDb   = !!process.env.DATABASE_URL_TEST;
  const allowShared = process.env.PRIVTEST_ALLOW_SHARED_DB === '1';
  const connStr     = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;

  if (!connStr) {
    console.error('DATABASE_URL_TEST (preferred) or DATABASE_URL is required.');
    process.exit(2);
  }
  if (!hasTestDb && !allowShared) {
    console.error(
      '\n  ✘ Refuses to run against the shared DATABASE_URL by default.\n'
      + '    Set DATABASE_URL_TEST=<disposable> or PRIVTEST_ALLOW_SHARED_DB=1.\n',
    );
    process.exit(2);
  }

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  lead-status viewer-role pill isolation  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  const PRIVTEST_KEYS = [KEY_A, KEY_B];

  await cleanupTestData(pool);
  await pool.query(`DELETE FROM lead_status_config WHERE key = ANY($1)`, [PRIVTEST_KEYS]);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  viewer=${users.viewer.email}`);

  await pool.query(
    `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
     VALUES ($1, $2, 990, false),
            ($3, $4, 991, false)
     ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label,
       sort_order = EXCLUDED.sort_order, excluded_from_sales = EXCLUDED.excluded_from_sales`,
    [KEY_A, LABEL_A, KEY_B, LABEL_B],
  );
  console.log(`  Inserted 2 lead statuses\n`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  const findings = [];
  function record(name, expected, observed, ok, detail = '') {
    findings.push({ name, expected, observed, ok, skipped: false, detail });
    const mark = ok ? '  ✓' : '  ✗';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
      if (detail) console.log(`     detail   : ${detail}`);
    }
  }
  const skip = makeSkip(findings);

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try {
      await pool.query(`DELETE FROM lead_status_config WHERE key = ANY($1)`, [PRIVTEST_KEYS]);
      await cleanupTestData(pool);
    } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  };

  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:', e);  cleanupAndExit(2); });
  process.on('unhandledRejection', (e) => { console.error('Unhandled:', e); cleanupAndExit(2); });

  // ── boot test server ───────────────────────────────────────────────────────
  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  Server up at ${BASE}`);
  } catch (e) {
    console.error('Server boot failed:', e.message);
    console.error(logBuf.join('').slice(-2000));
    await cleanupAndExit(2);
    return;
  }

  // ── puppeteer check ────────────────────────────────────────────────────────
  if (!puppeteer) {
    record('puppeteer available', 'require("puppeteer") resolves', 'module not installed', false,
      'Install puppeteer (npm i -D puppeteer) and rerun.');
    await writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

  const { findChromium } = require('../shared/find-chromium');
  const executablePath = findChromium() || undefined;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    skip('headless chromium launches', 'browser.launch() succeeds', `error: ${e.message}`);
    await writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

  // ── viewer login ───────────────────────────────────────────────────────────
  // Obtain a viewer session cookie via the API (no prior admin tab is ever
  // opened in this browser, so there is no dirty state from request
  // interception or window.__moHeaderUser overrides).
  const viewerClient = await login(users.viewer.email, PASSWORD);

  try {
    console.log('\n  [viewer] Viewer role: lead-status pill is read-only (no picker)');

    // Fresh incognito context — belt-and-braces isolation even within the
    // clean browser instance.
    const viewerCtx = await (browser.createBrowserContext
      ? browser.createBrowserContext()
      : browser.createIncognitoBrowserContext());
    const page = await viewerCtx.newPage();
    await page.setCacheEnabled(false);

    // Inject the viewer session cookie.
    const kv = parseCookieKV(viewerClient.cookie);
    if (kv) {
      const { hostname } = new URL(BASE);
      await page.setCookie({
        name: kv.name, value: kv.value,
        domain: hostname, path: '/', httpOnly: true,
      });
    }

    await page.goto(`${BASE}/customers/${CONTACT_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    // Poll until the page bootstrap functions are defined (DOMContentLoaded +
    // initial /api/contacts/:id call settled under the stripped HUBSPOT_TOKEN).
    await waitFor(page, () =>
      typeof state !== 'undefined' &&
      typeof renderWorkflowHeader === 'function' &&
      typeof loadLeadStatuses === 'function',
    {}, 10000);

    // Render the workflow header with viewer-role state.
    await bootstrapHeader(page, KEY_A, 'viewer');
    // Poll until the pill is present in the header.
    await waitFor(page, () =>
      !!document.querySelector('#workflow-header .lead-status-badge'), {}, 5000);

    // ── assertions ─────────────────────────────────────────────────────────
    const pillInfo = await page.evaluate(() => {
      const pill = document.querySelector('#workflow-header .lead-status-badge');
      return {
        present:    !!pill,
        clickable:  !!pill && pill.classList.contains('lsb-clickable'),
        hasOnclick: !!pill && !!pill.getAttribute('onclick'),
      };
    });

    record(
      'viewer sees a lead-status pill in #workflow-header',
      'pill is present',
      `present=${pillInfo.present}`,
      pillInfo.present,
    );
    record(
      'viewer pill does NOT have class lsb-clickable',
      'classList lacks "lsb-clickable"',
      `clickable=${pillInfo.clickable}`,
      !pillInfo.clickable,
    );
    record(
      'viewer pill has no onclick handler',
      'getAttribute("onclick") returns null/empty',
      `hasOnclick=${pillInfo.hasOnclick}`,
      !pillInfo.hasOnclick,
    );

    // Click the pill anyway and confirm the unified picker does NOT open.
    if (pillInfo.present) {
      await page.click('#workflow-header .lead-status-badge').catch(() => {});
      // Intentional fixed wait: this is a negative assertion (picker must NOT
      // open). A poll-loop would return immediately when nothing appears, so a
      // brief fixed window is required to give the picker a realistic chance to
      // appear before we assert its absence.
      await new Promise(r => setTimeout(r, 500));
      const pickerOpened = await page.evaluate(() =>
        !!document.getElementById('card-picker-popup'));
      record(
        'clicking the viewer pill does NOT open the unified picker popup',
        '#card-picker-popup is absent from DOM',
        `pickerOpened=${pickerOpened}`,
        !pickerOpened,
      );
    }

    await page.close();
    await viewerCtx.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }

  // ── summary & report ───────────────────────────────────────────────────────
  const pass    = findings.filter(f => f.ok).length;
  const skipped = findings.filter(f => f.skipped).length;
  const fail    = findings.filter(f => !f.ok && !f.skipped).length;
  console.log(`\n  Results: ${pass} passed, ${skipped} skipped, ${fail} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

// ── report writer ──────────────────────────────────────────────────────────────
async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Lead-Status Viewer-Role Pill — Isolated E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:lead-status-sync-customer-detail-viewer\``,
    '',
    '## Summary',
    '',
    `- Passed: ${findings.filter(f => f.ok).length} / ${findings.length}`,
    `- Skipped: ${findings.filter(f => f.skipped).length} / ${findings.length}`,
    `- Failed: ${findings.filter(f => !f.ok && !f.skipped).length} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **Viewer pill present**: navigates to `/customers/:id` as a viewer-role user,',
    '  bootstraps the workflow header with `privilege_level: "viewer"`, and asserts',
    '  `.lead-status-badge` is rendered inside `#workflow-header`.',
    '- **No lsb-clickable class**: asserts the pill does NOT carry the `lsb-clickable`',
    '  CSS class that the admin/member code path adds to enable click-to-open.',
    '- **No onclick handler**: asserts `getAttribute("onclick")` returns null/empty,',
    '  confirming the click handler was never attached.',
    '- **No picker popup on click**: clicks the pill directly via Puppeteer and waits',
    '  500 ms; asserts `#card-picker-popup` never appears in the DOM.',
    '',
    '## Isolation guarantee',
    '',
    'This suite boots its own fresh browser instance with no prior admin pages',
    'loaded and no Puppeteer request-interception sessions active. The browser',
    'context used for the viewer page is a new incognito context, so session',
    'cookies from any other test cannot leak in.',
    '',
    '## Notes',
    '',
    '- The test server strips `HUBSPOT_TOKEN`, so `GET /api/contacts/:id` 503s.',
    '  `bootstrapHeader` seeds `state.selectedContact` + `window.__moHeaderUser`',
    '  directly, then calls `renderWorkflowHeader()` — the same renderer path',
    '  the page uses after a successful contact load.',
  ];
  const outPath = path.join(dir, 'lead-status-sync-customer-detail-viewer.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/lead-status-sync-customer-detail-viewer.md`);
}

main();
