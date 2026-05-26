'use strict';
// test/lead-status-sync/run.js
//
// End-to-end live test: lead status label rename → filter-dropdown sync.
//
// Covers two update paths defined in public/workflow-core.js (lines 340–362):
//   (A) BroadcastChannel  — admin tab saves → channel message → customer tab re-renders
//   (B) visibilitychange  — server-side label already changed → tab gains focus → refresh
//   (C) count format      — filter options carry a "(N)" suffix after re-render
//
// The test server runs without a HubSpot token (stripped by the shared harness),
// so contacts always fail to load with 503.  populateLeadStatusFilter() is
// therefore not reached by the normal init flow (it sits after `await loader` in
// customers.html and after the Promise.all in core.js bootstrap).  The test
// compensates by calling loadLeadStatuses() + populateLeadStatusFilter() directly
// in the page context to establish the initial filter baseline; the function is
// no longer part of workflow-core.js — it is exposed only by the React bundle
// as window.populateLeadStatusFilter on pages that mount the React island.  The
// two sync paths (BroadcastChannel and visibilitychange) also invoke those same
// functions — so the tested code paths are exercised faithfully.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:lead-status-sync
//   # or against the shared DB with the privtest- prefix cleanup:
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:lead-status-sync

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
// A fixed key with the privtest- naming convention so cleanup is easy.
const LS_KEY      = 'PRIVTEST_LS_SYNC';
const LABEL_ORIG  = 'PrivTest Sync Label';
const LABEL_BC    = 'PrivTest Renamed BC';
const LABEL_VIS   = 'PrivTest Renamed Vis';

// Sub-status fixture used by section (E) and chip-rename sections (F)/(G).
const SS_KEY       = 'PRIVTEST_SS_SYNC';
const SS_LABEL     = 'PrivTest Sub Sync';
const SS_LABEL_BC  = 'PrivTest Sub Renamed BC';
const SS_LABEL_VIS = 'PrivTest Sub Renamed Vis';

// ── helpers ───────────────────────────────────────────────────────────────────
function parseCookieKV(jar) {
  if (!jar) return null;
  const idx = jar.indexOf('=');
  if (idx < 0) return null;
  return { name: jar.slice(0, idx), value: jar.slice(idx + 1) };
}

async function injectSession(page, jar) {
  const kv = parseCookieKV(jar);
  if (!kv) return;
  const { hostname } = new URL(BASE);
  await page.setCookie({
    name: kv.name, value: kv.value,
    domain: hostname, path: '/', httpOnly: true,
  });
}

// Call loadLeadStatuses() then populateLeadStatusFilter() inside the page's JS
// context so the filter dropdown is populated even when HubSpot is absent (the
// test server strips HUBSPOT_TOKEN, making contacts load return 503 — which
// prevents the normal init from reaching populateLeadStatusFilter).
// populateLeadStatusFilter is no longer in workflow-core.js; it is exposed by
// the React bundle as window.populateLeadStatusFilter on the customers page.
async function bootstrapFilter(page) {
  return page.evaluate(async () => {
    if (typeof loadLeadStatuses === 'function') await loadLeadStatuses();
    if (typeof populateLeadStatusFilter === 'function') populateLeadStatusFilter();
  });
}

// Poll the #lead-status-filter <select> until an <option> whose text starts
// with `label` appears, or until `timeoutMs` elapses.
async function waitForFilterLabel(page, label, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate((lbl) => {
      const sel = document.getElementById('lead-status-filter');
      if (!sel) return false;
      return Array.from(sel.options).some(o => o.textContent.startsWith(lbl));
    }, label);
    if (found) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

async function getFilterOptions(page) {
  return page.evaluate(() => {
    const sel = document.getElementById('lead-status-filter');
    if (!sel) return [];
    return Array.from(sel.options).map(o => o.textContent.trim());
  });
}

// Poll .MuiChip-label elements until one whose text includes `label` is
// found, or until `timeoutMs` elapses.
async function waitForChipLabel(page, label, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate((lbl) => {
      const chips = document.querySelectorAll('.MuiChip-label');
      return Array.from(chips).some(c => c.textContent.includes(lbl));
    }, label);
    if (found) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

// Populate the lead-status dropdown then programmatically select `lsKey` so
// React picks up the change event and renders sub-status chips.
async function bootstrapFilterAndSelect(page, lsKey) {
  await page.evaluate(async (key) => {
    if (typeof loadLeadStatuses === 'function') await loadLeadStatuses();
    if (typeof populateLeadStatusFilter === 'function') populateLeadStatusFilter();
    const sel = document.getElementById('lead-status-filter');
    if (!sel) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype, 'value',
    )?.set;
    if (nativeSetter) nativeSetter.call(sel, key);
    else sel.value = key;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, lsKey);
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
  console.log(`\n  lead-status-sync E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  // Pre-clean stale fixtures from a prior crashed run.
  await cleanupTestData(pool);
  // Delete sub-statuses before lead_status_config (FK ON DELETE NO ACTION).
  await pool.query(`DELETE FROM lead_substatuses WHERE status_key = $1`, [LS_KEY]);
  await pool.query(`DELETE FROM lead_status_config WHERE key = $1`, [LS_KEY]);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}`);

  // Insert the test lead-status row with a high sort_order so it doesn't
  // conflict with real production statuses.
  await pool.query(
    `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
     VALUES ($1, $2, 999, false)
     ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label`,
    [LS_KEY, LABEL_ORIG],
  );
  console.log(`  Inserted test lead-status  key="${LS_KEY}"  label="${LABEL_ORIG}"`);

  // Insert a sub-status for the test lead-status (used by section E).
  await pool.query(
    `INSERT INTO lead_substatuses (status_key, substatus_key, label, sort_order)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (status_key, substatus_key) DO UPDATE SET label = EXCLUDED.label`,
    [LS_KEY, SS_KEY, SS_LABEL],
  );
  console.log(`  Inserted test sub-status   status_key="${LS_KEY}"  substatus_key="${SS_KEY}"\n`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  const findings = [];
  function record(name, expected, observed, ok, detail = '') {
    findings.push({ name, expected, observed, ok, detail });
    const mark = ok ? '  ✓' : '  ✗';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
      if (detail) console.log(`     detail   : ${detail}`);
    }
  }

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try {
      // Delete sub-statuses first (FK ON DELETE NO ACTION blocks lead_status_config delete).
      await pool.query(`DELETE FROM lead_substatuses WHERE status_key = $1`, [LS_KEY]);
      await pool.query(`DELETE FROM lead_status_config WHERE key = $1`, [LS_KEY]);
      await cleanupTestData(pool);
    } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  };

  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:', e);   cleanupAndExit(2); });
  process.on('unhandledRejection', (e) => { console.error('Unhandled:', e);  cleanupAndExit(2); });

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

  // ── verify API layer before opening any browser ────────────────────────────
  // These checks run purely against the HTTP API so they surface useful
  // diagnostics if the browser-level tests fail.
  const adminClient = await login(users.admin.email, PASSWORD);

  const listRes = await adminClient.get('/api/admin/lead-statuses');
  const hasTestKey = Array.isArray(listRes.json) && listRes.json.some(s => s.key === LS_KEY);
  record(
    'GET /api/admin/lead-statuses returns the test status',
    `status=200 and key "${LS_KEY}" present`,
    `status=${listRes.status} found=${hasTestKey}`,
    listRes.status === 200 && hasTestKey,
  );

  const pubRes = await adminClient.get('/api/lead-statuses');
  const hasTestKeyPub = Array.isArray(pubRes.json) && pubRes.json.some(s => s.key === LS_KEY);
  record(
    'GET /api/lead-statuses (public, auth-gated) returns the test status',
    `status=200 and key "${LS_KEY}" present`,
    `status=${pubRes.status} found=${hasTestKeyPub}`,
    pubRes.status === 200 && hasTestKeyPub,
  );

  // ── require puppeteer ──────────────────────────────────────────────────────
  if (!puppeteer) {
    record(
      'puppeteer available',
      'require("puppeteer") resolves',
      'module not installed',
      false,
      'Install puppeteer (npm i -D puppeteer) and rerun.',
    );
    await writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

  // Locate the system Chromium via the shared helper (auto-discovers Nix paths).
  const { findChromium } = require('../shared/find-chromium');
  const executablePath = findChromium() || undefined;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 1280, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    record('headless chromium launches', 'browser.launch() succeeds', `error: ${e.message}`, false);
    await writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

  try {
    // ── (A) BroadcastChannel path ─────────────────────────────────────────────
    // Two tabs in the *same* browser:
    //   customerTab  – open /customers, has the filter dropdown + BC listener
    //   adminTab     – simulates the admin settings page posting the broadcast
    //
    // BroadcastChannel does NOT deliver a message back to the same port that
    // sent it, so the post from adminTab arrives at customerTab's listener which
    // then calls loadLeadStatuses() and re-renders the React filter dropdown.
    console.log('\n  [A] BroadcastChannel path');

    const customerTab = await browser.newPage();
    await customerTab.setCacheEnabled(false);
    await injectSession(customerTab, adminClient.cookie);

    const adminTab = await browser.newPage();
    await adminTab.setCacheEnabled(false);
    await injectSession(adminTab, adminClient.cookie);

    // Navigate to /customers and wait for the DOM + scripts to load.
    // Use domcontentloaded because networkidle2 can stall indefinitely when
    // contacts 503 and the page never fully quiesces.
    await customerTab.goto(`${BASE}/customers`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    // Give scripts a tick to execute (BroadcastChannel listener is registered
    // synchronously after workflow-core.js evaluates).
    await new Promise(r => setTimeout(r, 500));

    // Seed the filter baseline: call loadLeadStatuses() then
    // window.populateLeadStatusFilter() (from the React bundle) directly.
    // This is necessary because the normal init path (customers.html
    // DOMContentLoaded) only reaches the filter render after a successful
    // contacts fetch — which returns 503 when HUBSPOT_TOKEN is absent.
    await bootstrapFilter(customerTab);

    const initOpts = await getFilterOptions(customerTab);
    const hasOrig = initOpts.some(t => t.startsWith(LABEL_ORIG));
    record(
      'filter shows original label after manual bootstrap',
      `option starting with "${LABEL_ORIG}"`,
      `options: ${JSON.stringify(initOpts.filter(t => t !== 'All statuses').slice(0, 6))}`,
      hasOrig,
    );

    // Rename via the admin API (server-side state change).
    const patchA = await adminClient.patch(
      `/api/admin/lead-statuses/${encodeURIComponent(LS_KEY)}`,
      { label: LABEL_BC },
    );
    record(
      'PATCH /api/admin/lead-statuses/:key renames the label',
      `status=200 label="${LABEL_BC}"`,
      `status=${patchA.status} label="${patchA.json?.label}"`,
      patchA.status === 200 && patchA.json?.label === LABEL_BC,
    );

    // Load any workflow-core.js-bearing page in adminTab so the BroadcastChannel
    // API is available in its context, then post the channel message.
    await adminTab.goto(`${BASE}/customers`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await new Promise(r => setTimeout(r, 300));
    await adminTab.evaluate(() => {
      new BroadcastChannel('lead_statuses_changed').postMessage('changed');
    });

    // The listener in customerTab calls loadLeadStatuses() then re-renders
    // the React filter dropdown; poll until the new label appears.
    const bcUpdated = await waitForFilterLabel(customerTab, LABEL_BC, 7000);
    const optsAfterBc = await getFilterOptions(customerTab);
    record(
      'BroadcastChannel message triggers filter dropdown to show new label',
      `option starting with "${LABEL_BC}" within 7 s`,
      `found=${bcUpdated} options: ${JSON.stringify(optsAfterBc.filter(t => t !== 'All statuses').slice(0, 6))}`,
      bcUpdated,
    );

    // Old label must be gone (no stale entry).
    const staleAfterBc = optsAfterBc.some(t => t.startsWith(LABEL_ORIG));
    record(
      'original label is absent from dropdown after BroadcastChannel rename',
      `no option starting with "${LABEL_ORIG}"`,
      `stalePresent=${staleAfterBc}`,
      !staleAfterBc,
    );

    await customerTab.close();
    await adminTab.close();

    // ── (B) visibilitychange path ─────────────────────────────────────────────
    // Open a fresh customers tab, bootstrap the filter to confirm it shows the
    // BC-renamed label, rename again via API, then synthesise a hidden→visible
    // visibilitychange sequence.  The handler (workflow-core.js lines 340–347)
    // calls loadLeadStatuses() and re-renders the React filter dropdown.
    console.log('\n  [B] visibilitychange path');

    const visTab = await browser.newPage();
    await visTab.setCacheEnabled(false);
    await injectSession(visTab, adminClient.cookie);
    await visTab.goto(`${BASE}/customers`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await new Promise(r => setTimeout(r, 500));
    await bootstrapFilter(visTab);

    // Confirm BC-renamed label is the current state.
    const optsBeforeVis = await getFilterOptions(visTab);
    const hasBc = optsBeforeVis.some(t => t.startsWith(LABEL_BC));
    record(
      'filter shows BC-renamed label before visibilitychange rename',
      `option starting with "${LABEL_BC}"`,
      `found=${hasBc} options: ${JSON.stringify(optsBeforeVis.filter(t => t !== 'All statuses').slice(0, 6))}`,
      hasBc,
    );

    // Rename server-side so the next GET /api/lead-statuses returns LABEL_VIS.
    const patchB = await adminClient.patch(
      `/api/admin/lead-statuses/${encodeURIComponent(LS_KEY)}`,
      { label: LABEL_VIS },
    );
    record(
      'second PATCH renames label for visibilitychange test',
      `status=200 label="${LABEL_VIS}"`,
      `status=${patchB.status} label="${patchB.json?.label}"`,
      patchB.status === 200 && patchB.json?.label === LABEL_VIS,
    );

    // Synthesise the hidden → visible transition.
    // The handler only runs when visibilityState === 'visible', so we need to:
    //   1. Override visibilityState to 'hidden' and dispatch — handler skips.
    //   2. Restore to 'visible' and dispatch — handler fires, fetches, re-renders.
    await visTab.evaluate(() => {
      const proto   = Document.prototype;
      const ownDesc = Object.getOwnPropertyDescriptor(proto, 'visibilityState')
                   || Object.getOwnPropertyDescriptor(document, 'visibilityState');

      // Step 1: hidden
      Object.defineProperty(document, 'visibilityState',
        { get: () => 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));

      // Step 2: visible — this is what the real tab-focus event looks like
      if (ownDesc) {
        Object.defineProperty(document, 'visibilityState', ownDesc);
      } else {
        Object.defineProperty(document, 'visibilityState',
          { get: () => 'visible', configurable: true });
      }
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Poll for the newly renamed label.
    const visUpdated = await waitForFilterLabel(visTab, LABEL_VIS, 7000);
    const optsAfterVis = await getFilterOptions(visTab);
    record(
      'visibilitychange triggers filter dropdown to show new label',
      `option starting with "${LABEL_VIS}" within 7 s`,
      `found=${visUpdated} options: ${JSON.stringify(optsAfterVis.filter(t => t !== 'All statuses').slice(0, 6))}`,
      visUpdated,
    );

    // Old BC label must be gone after the visibility-triggered refresh.
    const staleAfterVis = optsAfterVis.some(t => t.startsWith(LABEL_BC));
    record(
      'BC-renamed label is absent from dropdown after visibilitychange refresh',
      `no option starting with "${LABEL_BC}"`,
      `stalePresent=${staleAfterVis}`,
      !staleAfterVis,
    );

    await visTab.close();

    // ── (C) count format ──────────────────────────────────────────────────────
    // Verify the React filter dropdown always appends " (N)" to each option.
    // Contacts are empty in CI (no HubSpot) so every count will be 0, but the
    // suffix must still appear.
    console.log('\n  [C] count format');

    const countTab = await browser.newPage();
    await countTab.setCacheEnabled(false);
    await injectSession(countTab, adminClient.cookie);
    await countTab.goto(`${BASE}/customers`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await new Promise(r => setTimeout(r, 500));
    await bootstrapFilter(countTab);

    const optsCount = await getFilterOptions(countTab);
    const statusOpts = optsCount.filter(t => t !== 'All statuses');
    const countFormatOk = statusOpts.length > 0 && statusOpts.every(t => /\(\d+\)$/.test(t));
    record(
      'all filter options carry a "(N)" count suffix after render',
      `every non-"All statuses" option ends with (N); at least 1 option`,
      `count=${statusOpts.length} options: ${JSON.stringify(statusOpts.slice(0, 6))}`,
      countFormatOk,
    );

    await countTab.close();

    // ── (D) skeleton loading state ────────────────────────────────────────────
    // Open a fresh customers tab with request interception enabled.  Hold the
    // GET /api/lead-statuses response in-flight while we assert that:
    //   1. A MUI Skeleton is visible in the DOM next to the lead-status filter.
    //   2. The FormControl wrapping #lead-status-filter has visibility:hidden.
    // Then release the request and assert:
    //   3. The skeleton element is removed from the DOM within 5 s.
    //   4. The FormControl becomes visibility:visible.
    console.log('\n  [D] skeleton loading state');

    const skelTab = await browser.newPage();
    await skelTab.setCacheEnabled(false);
    await injectSession(skelTab, adminClient.cookie);

    // A promise that resolves (with the intercepted Request object) the first
    // time Puppeteer catches a GET /api/lead-statuses request.
    let resolveLeadStatusReq;
    const leadStatusReqCaught = new Promise(res => { resolveLeadStatusReq = res; });
    let pendingLeadStatusReq = null;

    await skelTab.setRequestInterception(true);
    skelTab.on('request', req => {
      const url = req.url();
      // Match /api/lead-statuses exactly (with optional query string), but not
      // /api/admin/lead-statuses or /api/contacts-lead-status-counts.
      if (/\/api\/lead-statuses(\?|$)/.test(url) && !pendingLeadStatusReq) {
        pendingLeadStatusReq = req;
        resolveLeadStatusReq(req);
        // Deliberately do NOT call req.continue() here — we hold the request.
      } else {
        req.continue();
      }
    });

    await skelTab.goto(`${BASE}/customers`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    // Wait until Puppeteer has caught the /api/lead-statuses request (up to 5 s).
    const reqCatchOk = await Promise.race([
      leadStatusReqCaught.then(() => true),
      new Promise(res => setTimeout(() => res(false), 5000)),
    ]);
    record(
      '/api/lead-statuses request is intercepted in-flight',
      'request intercepted within 5 s',
      `caught=${reqCatchOk}`,
      reqCatchOk,
    );

    // Give React a tick to render the skeleton now that the request is stalled.
    await new Promise(r => setTimeout(r, 300));

    // ── assert skeleton is visible ──
    // Look for .MuiSkeleton-root inside the Box that contains #lead-status-filter.
    const skelVisible = await skelTab.evaluate(() => {
      const sel = document.getElementById('lead-status-filter');
      if (!sel) return false;
      const box = sel.closest('.MuiFormControl-root')?.parentElement;
      if (!box) return false;
      const skel = box.querySelector('.MuiSkeleton-root');
      if (!skel) return false;
      const st = window.getComputedStyle(skel);
      return st.display !== 'none' && st.visibility !== 'hidden';
    });
    record(
      'lead-status skeleton is present in DOM while /api/lead-statuses is in-flight',
      '.MuiSkeleton-root visible next to #lead-status-filter',
      `visible=${skelVisible}`,
      skelVisible,
    );

    // ── assert select is hidden while skeleton is shown ──
    const selectHidden = await skelTab.evaluate(() => {
      const sel = document.getElementById('lead-status-filter');
      if (!sel) return false;
      const fc = sel.closest('.MuiFormControl-root');
      if (!fc) return false;
      return window.getComputedStyle(fc).visibility === 'hidden';
    });
    record(
      'lead-status FormControl is visibility:hidden while skeleton is shown',
      'FormControl visibility === hidden',
      `hidden=${selectHidden}`,
      selectHidden,
    );

    // ── release the held request ──
    if (pendingLeadStatusReq) {
      try { pendingLeadStatusReq.continue(); } catch {}
    }

    // ── assert skeleton disappears ──
    const skelGone = await skelTab.waitForFunction(
      () => {
        const sel = document.getElementById('lead-status-filter');
        const box = sel?.closest('.MuiFormControl-root')?.parentElement;
        return !box || !box.querySelector('.MuiSkeleton-root');
      },
      { timeout: 5000 },
    ).then(() => true).catch(() => false);
    record(
      'lead-status skeleton disappears after /api/lead-statuses resolves',
      '.MuiSkeleton-root absent within 5 s',
      `gone=${skelGone}`,
      skelGone,
    );

    // ── assert select is now visible ──
    const selectVisible = await skelTab.evaluate(() => {
      const sel = document.getElementById('lead-status-filter');
      if (!sel) return false;
      const fc = sel.closest('.MuiFormControl-root');
      if (!fc) return false;
      return window.getComputedStyle(fc).visibility === 'visible';
    });
    record(
      'lead-status FormControl is visibility:visible after skeleton disappears',
      'FormControl visibility === visible',
      `visible=${selectVisible}`,
      selectVisible,
    );

    await skelTab.close();

    // ── (E) sub-status skeleton loading state ─────────────────────────────────
    // Open a fresh customers tab and intercept ONLY /api/lead-substatuses,
    // letting /api/lead-statuses resolve normally so the lead-status filter
    // renders (store.loaded = true) while sub-statuses remain in-flight
    // (store.subsLoaded = false).
    //
    // Flow:
    //   1. /api/lead-statuses resolves → store.loaded = true, notify() fires
    //      an early re-render.  Lead-status skeleton clears.
    //   2. /api/lead-substatuses is held → store.subsLoaded stays false.
    //   3. We call window.populateLeadStatusFilter() (React bundle) so the
    //      test lead-status key appears as a dropdown option, then select it.
    //   4. React re-renders with leadStatus set and store.subsLoaded false
    //      → the sub-status skeleton ([data-testid="substatus-skeleton"]) shows.
    //   5. Release /api/lead-substatuses → store.subsLoaded = true, notify().
    //   6. Skeleton disappears; test lead-status chip appears.
    console.log('\n  [E] sub-status skeleton loading state');

    const subSkelTab = await browser.newPage();
    await subSkelTab.setCacheEnabled(false);
    await injectSession(subSkelTab, adminClient.cookie);

    let resolveSubstatusReq;
    const substatusReqCaught = new Promise(res => { resolveSubstatusReq = res; });
    let pendingSubstatusReq = null;

    await subSkelTab.setRequestInterception(true);
    subSkelTab.on('request', req => {
      const url = req.url();
      // Hold only /api/lead-substatuses (with optional query string).
      if (/\/api\/lead-substatuses(\?|$)/.test(url) && !pendingSubstatusReq) {
        pendingSubstatusReq = req;
        resolveSubstatusReq(req);
        // Deliberately do NOT call req.continue() — we hold the request.
      } else {
        req.continue();
      }
    });

    await subSkelTab.goto(`${BASE}/customers`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    // Wait until Puppeteer has caught the /api/lead-substatuses request (up to 5 s).
    const subReqCatchOk = await Promise.race([
      substatusReqCaught.then(() => true),
      new Promise(res => setTimeout(() => res(false), 5000)),
    ]);
    record(
      '/api/lead-substatuses request is intercepted in-flight',
      'request intercepted within 5 s',
      `caught=${subReqCatchOk}`,
      subReqCatchOk,
    );

    // Wait for /api/lead-statuses to resolve and the lead-status FormControl
    // to become visible (store.loaded = true → notify() → re-render).
    const leadStatusVisible = await subSkelTab.waitForFunction(
      () => {
        const sel = document.getElementById('lead-status-filter');
        if (!sel) return false;
        const fc = sel.closest('.MuiFormControl-root');
        if (!fc) return false;
        return window.getComputedStyle(fc).visibility === 'visible';
      },
      { timeout: 8000 },
    ).then(() => true).catch(() => false);
    record(
      'lead-status FormControl becomes visible while /api/lead-substatuses is held',
      'FormControl visibility === visible within 8 s',
      `visible=${leadStatusVisible}`,
      leadStatusVisible,
    );

    // Populate the dropdown so the test lead-status option is available.
    // window.populateLeadStatusFilter is exposed by the React bundle (it is no
    // longer defined in workflow-core.js); the typeof guard is a no-op on pages
    // where the React island has not yet mounted.
    await subSkelTab.evaluate(async () => {
      if (typeof loadLeadStatuses === 'function') await loadLeadStatuses();
      if (typeof populateLeadStatusFilter === 'function') populateLeadStatusFilter();
    });
    await new Promise(r => setTimeout(r, 200));

    // Select the test lead status programmatically.  Use the React-compatible
    // setter so the synthetic change event triggers setLeadStatus().
    const selectedOk = await subSkelTab.evaluate((lsKey) => {
      const sel = document.getElementById('lead-status-filter');
      if (!sel) return false;
      const hasOpt = Array.from(sel.options).some(o => o.value === lsKey);
      if (!hasOpt) return false;
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype, 'value',
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(sel, lsKey);
      } else {
        sel.value = lsKey;
      }
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, LS_KEY);
    record(
      'test lead-status option is selectable in the dropdown',
      `option value="${LS_KEY}" found and selected`,
      `selectedOk=${selectedOk}`,
      selectedOk,
    );

    // Give React a tick to re-render with the new leadStatus value.
    await new Promise(r => setTimeout(r, 300));

    // ── assert sub-status skeleton is visible ──
    const subSkelVisible = await subSkelTab.evaluate(() => {
      const skel = document.querySelector('[data-testid="substatus-skeleton"]');
      if (!skel) return false;
      const st = window.getComputedStyle(skel);
      return st.display !== 'none' && st.visibility !== 'hidden';
    });
    record(
      'sub-status skeleton is present in DOM while /api/lead-substatuses is in-flight',
      '[data-testid="substatus-skeleton"] visible after lead-status selected',
      `visible=${subSkelVisible}`,
      subSkelVisible,
    );

    // ── release the held /api/lead-substatuses request ──
    if (pendingSubstatusReq) {
      try { pendingSubstatusReq.continue(); } catch {}
    }

    // ── assert sub-status skeleton disappears ──
    const subSkelGone = await subSkelTab.waitForFunction(
      () => !document.querySelector('[data-testid="substatus-skeleton"]'),
      { timeout: 5000 },
    ).then(() => true).catch(() => false);
    record(
      'sub-status skeleton disappears after /api/lead-substatuses resolves',
      '[data-testid="substatus-skeleton"] absent within 5 s',
      `gone=${subSkelGone}`,
      subSkelGone,
    );

    // ── assert sub-status chip appears ──
    // The chip label text should contain SS_LABEL (the test sub-status label).
    const chipVisible = await subSkelTab.waitForFunction(
      (label) => {
        const chips = document.querySelectorAll('.MuiChip-label');
        return Array.from(chips).some(c => c.textContent.includes(label));
      },
      { timeout: 5000 },
      SS_LABEL,
    ).then(() => true).catch(() => false);
    record(
      'sub-status chip appears after /api/lead-substatuses resolves',
      `MuiChip with label "${SS_LABEL}" visible within 5 s`,
      `chipVisible=${chipVisible}`,
      chipVisible,
    );

    await subSkelTab.close();

    // ── (F) sub-status chip rename — BroadcastChannel path ───────────────────
    // Open a customers tab, select the test lead status so sub-status chips
    // render, PATCH the sub-status label via the admin API, then post a
    // `lead_substatuses_changed` BroadcastChannel message from a second tab.
    // Asserts the chip text updates without a full page reload.
    console.log('\n  [F] sub-status chip rename — BroadcastChannel path');

    // Look up the numeric id of the test sub-status so we can PATCH it.
    const ssListRes = await adminClient.get('/api/admin/lead-substatuses');
    const ssRow = Array.isArray(ssListRes.json)
      && ssListRes.json.find(s => s.substatus_key === SS_KEY && s.status_key === LS_KEY);
    record(
      '[F] GET /api/admin/lead-substatuses returns the test sub-status',
      `status=200 and substatus_key "${SS_KEY}" present`,
      `status=${ssListRes.status} found=${!!ssRow}`,
      ssListRes.status === 200 && !!ssRow,
    );

    if (ssRow) {
      const chipBcTab = await browser.newPage();
      await chipBcTab.setCacheEnabled(false);
      await injectSession(chipBcTab, adminClient.cookie);

      const chipAdminTab = await browser.newPage();
      await chipAdminTab.setCacheEnabled(false);
      await injectSession(chipAdminTab, adminClient.cookie);

      await chipBcTab.goto(`${BASE}/customers`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      // Wait for the React mount + initial /api/lead-substatuses to resolve.
      await new Promise(r => setTimeout(r, 800));

      // Bootstrap the filter and select the test lead status so chips appear.
      await bootstrapFilterAndSelect(chipBcTab, LS_KEY);
      await new Promise(r => setTimeout(r, 400));

      // Assert the initial chip is visible with the original SS_LABEL.
      const chipFInit = await waitForChipLabel(chipBcTab, SS_LABEL, 5000);
      record(
        '[F] initial sub-status chip shows SS_LABEL after lead-status selected',
        `MuiChip with label "${SS_LABEL}" visible within 5 s`,
        `visible=${chipFInit}`,
        chipFInit,
      );

      // Rename the sub-status label via the admin API.
      const ssPatchF = await adminClient.patch(
        `/api/admin/lead-substatuses/${ssRow.id}`,
        { label: SS_LABEL_BC },
      );
      record(
        '[F] PATCH /api/admin/lead-substatuses/:id renames the sub-status label',
        `status=200 label="${SS_LABEL_BC}"`,
        `status=${ssPatchF.status} label="${ssPatchF.json?.label}"`,
        ssPatchF.status === 200 && ssPatchF.json?.label === SS_LABEL_BC,
      );

      // Load a page in adminTab so a BroadcastChannel is available, then post.
      await chipAdminTab.goto(`${BASE}/customers`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      await new Promise(r => setTimeout(r, 300));
      await chipAdminTab.evaluate(() => {
        new BroadcastChannel('lead_substatuses_changed').postMessage('changed');
      });

      // The listener on chipBcTab calls loadLeadSubstatuses() → notify() →
      // React re-renders the sub-status chips with the new label.
      const chipFBcUpdated = await waitForChipLabel(chipBcTab, SS_LABEL_BC, 7000);
      record(
        '[F] BroadcastChannel message updates sub-status chip to renamed label',
        `MuiChip with label "${SS_LABEL_BC}" within 7 s`,
        `found=${chipFBcUpdated}`,
        chipFBcUpdated,
      );

      // Original label must be gone from the chip list.
      const chipFBcStale = await chipBcTab.evaluate((lbl) => {
        const chips = document.querySelectorAll('.MuiChip-label');
        return Array.from(chips).some(c => c.textContent.includes(lbl));
      }, SS_LABEL);
      record(
        '[F] original sub-status chip label is absent after BroadcastChannel rename',
        `no MuiChip with label "${SS_LABEL}"`,
        `stalePresent=${chipFBcStale}`,
        !chipFBcStale,
      );

      await chipBcTab.close();
      await chipAdminTab.close();
    }

    // ── (G) sub-status chip rename — visibilitychange path ────────────────────
    // Open a fresh customers tab, select the test lead status, then rename the
    // sub-status server-side and synthesise a hidden→visible visibilitychange.
    // Asserts the chip updates to the new label without a full page reload.
    console.log('\n  [G] sub-status chip rename — visibilitychange path');

    // Re-fetch ssRow in case the id changed (it won't, but keeps (G) independent).
    const ssListRes2 = await adminClient.get('/api/admin/lead-substatuses');
    const ssRow2 = Array.isArray(ssListRes2.json)
      && ssListRes2.json.find(s => s.substatus_key === SS_KEY && s.status_key === LS_KEY);

    if (ssRow2) {
      const chipVisTab = await browser.newPage();
      await chipVisTab.setCacheEnabled(false);
      await injectSession(chipVisTab, adminClient.cookie);

      await chipVisTab.goto(`${BASE}/customers`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await new Promise(r => setTimeout(r, 800));

      await bootstrapFilterAndSelect(chipVisTab, LS_KEY);
      await new Promise(r => setTimeout(r, 400));

      // Confirm the chip now shows SS_LABEL_BC (the state left by section F).
      const chipGInit = await waitForChipLabel(chipVisTab, SS_LABEL_BC, 5000);
      record(
        '[G] sub-status chip shows BC-renamed label before visibilitychange rename',
        `MuiChip with label "${SS_LABEL_BC}" visible within 5 s`,
        `visible=${chipGInit}`,
        chipGInit,
      );

      // Rename server-side so the next /api/lead-substatuses returns SS_LABEL_VIS.
      const ssPatchG = await adminClient.patch(
        `/api/admin/lead-substatuses/${ssRow2.id}`,
        { label: SS_LABEL_VIS },
      );
      record(
        '[G] second PATCH renames sub-status label for visibilitychange test',
        `status=200 label="${SS_LABEL_VIS}"`,
        `status=${ssPatchG.status} label="${ssPatchG.json?.label}"`,
        ssPatchG.status === 200 && ssPatchG.json?.label === SS_LABEL_VIS,
      );

      // Synthesise the hidden → visible transition (mirrors section B).
      await chipVisTab.evaluate(() => {
        const proto   = Document.prototype;
        const ownDesc = Object.getOwnPropertyDescriptor(proto, 'visibilityState')
                     || Object.getOwnPropertyDescriptor(document, 'visibilityState');

        Object.defineProperty(document, 'visibilityState',
          { get: () => 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        if (ownDesc) {
          Object.defineProperty(document, 'visibilityState', ownDesc);
        } else {
          Object.defineProperty(document, 'visibilityState',
            { get: () => 'visible', configurable: true });
        }
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // The visibilitychange handler calls loadLeadSubstatuses() → notify() →
      // React re-renders with the updated label.
      const chipGVisUpdated = await waitForChipLabel(chipVisTab, SS_LABEL_VIS, 7000);
      record(
        '[G] visibilitychange updates sub-status chip to renamed label',
        `MuiChip with label "${SS_LABEL_VIS}" within 7 s`,
        `found=${chipGVisUpdated}`,
        chipGVisUpdated,
      );

      const chipGVisStale = await chipVisTab.evaluate((lbl) => {
        const chips = document.querySelectorAll('.MuiChip-label');
        return Array.from(chips).some(c => c.textContent.includes(lbl));
      }, SS_LABEL_BC);
      record(
        '[G] BC-renamed sub-status chip label is absent after visibilitychange refresh',
        `no MuiChip with label "${SS_LABEL_BC}"`,
        `stalePresent=${chipGVisStale}`,
        !chipGVisStale,
      );

      await chipVisTab.close();
    }

  } finally {
    await browser.close().catch(() => {});
  }

  // ── summary & report ──────────────────────────────────────────────────────
  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

// ── report writer ─────────────────────────────────────────────────────────────
async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Lead-Status Label Rename Sync — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:lead-status-sync\``,
    '',
    '## Summary',
    '',
    `- Passed: ${findings.filter(f => f.ok).length} / ${findings.length}`,
    `- Failed: ${findings.filter(f => !f.ok).length} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **(API pre-checks)**: verifies `GET /api/admin/lead-statuses` and `GET /api/lead-statuses`',
    '  both surface the test status before any browser tabs are opened.',
    '- **(A) BroadcastChannel path**: renames a lead-status label via',
    '  `PATCH /api/admin/lead-statuses/:key`, then posts a `lead_statuses_changed`',
    '  BroadcastChannel message from a second same-browser tab, and asserts the',
    '  `#lead-status-filter` dropdown on the Customers page reflects the new label',
    '  text (exercising the `_lsChannel.addEventListener("message", …)` handler',
    '  in `workflow-core.js` lines 353–361).  Also asserts the stale label is gone.',
    '- **(B) visibilitychange path**: renames the label again server-side, then',
    '  synthesises a hidden→visible visibilitychange event sequence and asserts',
    '  the dropdown updates (exercising the',
    '  `document.addEventListener("visibilitychange", …)` handler in',
    '  `workflow-core.js` lines 340–347).  Also asserts the stale label is gone.',
    '- **(C) count format**: verifies every filter option carries a "(N)" count',
    '  suffix after the React filter dropdown re-renders, confirming label+count',
    '  are rendered together correctly.',
    '- **(D) skeleton loading state**: intercepts `GET /api/lead-statuses` via',
    '  Puppeteer request interception, holds the response in-flight, and asserts',
    '  that the MUI `Skeleton` element is present and visible next to',
    '  `#lead-status-filter` while the `FormControl` is `visibility:hidden`.',
    '  Releases the request and asserts the skeleton is removed from the DOM',
    '  within 5 s and the `FormControl` becomes `visibility:visible`.',
    '  Exercises the `{!store.loaded && <Skeleton …/>}` branch and the',
    '  `visibility: store.loaded ? "visible" : "hidden"` guard in',
    '  `src/react/pages/CustomersPage.tsx`.',
    '- **(E) sub-status skeleton loading state**: intercepts `GET /api/lead-substatuses`',
    '  while letting `GET /api/lead-statuses` resolve normally so',
    '  `store.loaded` becomes true (lead-status filter renders) while',
    '  `store.subsLoaded` stays false. Populates the lead-status filter via',
    '  `window.populateLeadStatusFilter()` (React bundle), programmatically selects the test lead',
    '  status, and asserts that `[data-testid="substatus-skeleton"]` is visible.',
    '  Releases the request and asserts the skeleton is removed and the test',
    '  sub-status chip (`SS_LABEL`) appears within 5 s.',
    '  Exercises the `{!store.subsLoaded && leadStatus && … <Skeleton …/>}` branch',
    '  in `src/react/pages/CustomersPage.tsx`.',
    '- **(F) sub-status chip rename — BroadcastChannel path**: looks up the numeric',
    '  id of the test sub-status via `GET /api/admin/lead-substatuses`, opens a',
    '  customers tab, selects the test lead status so sub-status chips are visible,',
    '  then renames the sub-status label via `PATCH /api/admin/lead-substatuses/:id`.',
    '  Posts a `lead_substatuses_changed` BroadcastChannel message from a second',
    '  tab and asserts the chip text updates to the new label without a full reload.',
    '  Also asserts the old label is absent. Exercises the `subBc.addEventListener`',
    '  → `refresh()` → `loadLeadSubstatuses()` → `notify()` path in',
    '  `src/react/pages/CustomersPage.tsx`.',
    '- **(G) sub-status chip rename — visibilitychange path**: opens a fresh',
    '  customers tab, selects the test lead status (chips show BC-renamed label',
    '  from section F), renames the sub-status again via the admin API, then',
    '  synthesises a hidden→visible `visibilitychange` sequence. Asserts the chip',
    '  updates to the new label and the prior label is absent. Exercises the',
    '  `document.addEventListener("visibilitychange", onVisibility)` → `refresh()`',
    '  → `loadLeadSubstatuses()` → `notify()` path for sub-status chip re-renders.',
    '',
    '## Notes',
    '',
    '- The test server strips `HUBSPOT_TOKEN` so `loadAllContacts()` returns 503.',
    '  Contact counts in the filter options will therefore all be 0 in CI.',
    '  The `bootstrapFilter()` helper calls `loadLeadStatuses()` +',
    '  `window.populateLeadStatusFilter()` (exposed by the React bundle, not',
    '  workflow-core.js) directly in the page context to establish the initial',
    '  filter state independently of the HubSpot contact load.',
  ];
  const outPath = path.join(dir, 'lead-status-sync.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/lead-status-sync.md`);
}

main();
