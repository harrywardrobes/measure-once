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

const { pollUntil } = require('../helpers/poll');

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

// Card chip rename labels used by sections (K) and (L).
const SS_LABEL_CARD_BC  = 'PrivTest Card BC';
const SS_LABEL_CARD_VIS = 'PrivTest Card Vis';

// SSE broadcast label used by section (H).
const LABEL_SSE = 'PrivTest Renamed SSE';

// New lead-status fixture created in probe [I] and deleted in probe [J].
const LS_KEY_NEW  = 'PRIVTEST_LS_SYNC_NEW';
const LABEL_NEW   = 'PrivTest Created New';

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

// Poll until the functions bootstrapFilter/bootstrapFilterAndSelect rely on are
// defined in the page context.  workflow-core.js registers them synchronously
// on evaluation; the React bundle exposes populateLeadStatusFilter after mount.
// Replaces post-goto fixed delays throughout the test.
async function waitForBootstrapFns(page, timeoutMs = 10000) {
  await pollUntil(
    page,
    () => (typeof loadLeadStatuses === 'function' && typeof populateLeadStatusFilter === 'function') ? 'ok' : null,
    timeoutMs,
    150,
  );
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
  return !!(await pollUntil(
    page,
    (lbl) => {
      const sel = document.getElementById('lead-status-filter');
      if (!sel) return null;
      return Array.from(sel.options).some(o => o.textContent.startsWith(lbl)) ? true : null;
    },
    timeoutMs,
    150,
    [label],
  ));
}

// Poll the #lead-status-filter <select> until no <option> whose text starts
// with `label` remains, or until `timeoutMs` elapses.
async function waitForFilterLabelGone(page, label, timeoutMs = 6000) {
  return !!(await pollUntil(
    page,
    (lbl) => {
      const sel = document.getElementById('lead-status-filter');
      if (!sel) return null;
      return Array.from(sel.options).some(o => o.textContent.startsWith(lbl)) ? null : true;
    },
    timeoutMs,
    150,
    [label],
  ));
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
  return !!(await pollUntil(
    page,
    (lbl) => {
      const chips = document.querySelectorAll('.MuiChip-label');
      return Array.from(chips).some(c => c.textContent.includes(lbl)) ? true : null;
    },
    timeoutMs,
    150,
    [label],
  ));
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
  await pool.query(`DELETE FROM lead_substatuses WHERE status_key = $1`, [LS_KEY_NEW]);
  await pool.query(`DELETE FROM lead_status_config WHERE key = $1`, [LS_KEY_NEW]);

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
      await pool.query(`DELETE FROM lead_substatuses WHERE status_key = $1`, [LS_KEY_NEW]);
      await pool.query(`DELETE FROM lead_status_config WHERE key = $1`, [LS_KEY_NEW]);
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

    // Wait for the page scripts to evaluate (loadLeadStatuses and
    // populateLeadStatusFilter must be defined before bootstrapFilter runs).
    await waitForBootstrapFns(customerTab);

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
    // BroadcastChannel is a native browser API — no scripts need to evaluate
    // before we can post from this tab.
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
    await waitForBootstrapFns(visTab);
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
    await waitForBootstrapFns(countTab);
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
    // Poll for the #lead-status-filter <select> to have at least one option,
    // so the programmatic selection below is guaranteed to find it.
    await pollUntil(
      subSkelTab,
      (lsKey) => {
        const sel = document.getElementById('lead-status-filter');
        return (sel && Array.from(sel.options).some(o => o.value === lsKey)) ? true : null;
      },
      6000,
      150,
      [LS_KEY],
    );

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

    // Poll for the sub-status skeleton to appear after React re-renders with the
    // newly selected lead-status value.  Replaces the fixed 300 ms delay.
    await pollUntil(
      subSkelTab,
      () => {
        const skel = document.querySelector('[data-testid="substatus-skeleton"]');
        if (!skel) return null;
        const st = window.getComputedStyle(skel);
        return (st.display !== 'none' && st.visibility !== 'hidden') ? true : null;
      },
      5000,
      100,
    );

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
      // Wait for page scripts to evaluate before bootstrapping the filter.
      await waitForBootstrapFns(chipBcTab);

      // Bootstrap the filter and select the test lead status so chips appear.
      // waitForChipLabel below polls until the chip is visible — no extra delay needed.
      await bootstrapFilterAndSelect(chipBcTab, LS_KEY);

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
      // BroadcastChannel is native — no scripts need to evaluate first.
      await chipAdminTab.goto(`${BASE}/customers`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
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
      await waitForBootstrapFns(chipVisTab);

      await bootstrapFilterAndSelect(chipVisTab, LS_KEY);
      // waitForChipLabel below polls until the chip is visible — no extra delay needed.

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

    // ── (H) SSE broadcast path ────────────────────────────────────────────────
    // Verify the full server-side SSE broadcast path end-to-end:
    //   admin PATCH → server broadcasts `lead_statuses_changed` SSE → a page
    //   whose WorkflowDataContext has an active EventSource receives the event
    //   and re-posts it as a BroadcastChannel('lead_statuses_changed') message →
    //   a second tab (the customers page) has its useLeadStatusSync BC listener
    //   call refresh() and update the filter dropdown.
    //
    // Two-page setup:
    //   sseListenerTab  — /customers (filter dropdown, BC listener in useLeadStatusSync)
    //   sseRelayTab     — /customers/:id (WorkflowDataProvider wraps CustomerDetailPage,
    //                     so WorkflowDataContext's EventSource connects here; this page
    //                     also performs the PATCH via in-page fetch())
    //
    // The mutation is performed from within the browser context (fetch() call inside
    // sseRelayTab) rather than from Node, mirroring the real admin-panel flow.
    // The filter update on sseListenerTab must happen via the production
    // WorkflowDataContext → BroadcastChannel bridge without any manual BC post or
    // visibilitychange from the test harness.
    console.log('\n  [H] SSE broadcast path');

    // ── open Page 1: /customers (filter listener) ─────────────────────────────
    const sseListenerTab = await browser.newPage();
    await sseListenerTab.setCacheEnabled(false);
    await injectSession(sseListenerTab, adminClient.cookie);

    await sseListenerTab.goto(`${BASE}/customers`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await waitForBootstrapFns(sseListenerTab);

    // Seed the filter so the dropdown is populated with the current LABEL_VIS.
    await bootstrapFilter(sseListenerTab);

    const optsBeforeSse = await getFilterOptions(sseListenerTab);
    const hasVisLabel = optsBeforeSse.some(t => t.startsWith(LABEL_VIS));
    record(
      '[H] sseListenerTab filter shows LABEL_VIS before SSE-triggered rename',
      `option starting with "${LABEL_VIS}"`,
      `found=${hasVisLabel} options: ${JSON.stringify(optsBeforeSse.filter(t => t !== 'All statuses').slice(0, 6))}`,
      hasVisLabel,
    );

    // Attach a passive BC spy: sets a window flag when any BC message arrives.
    // This is purely diagnostic — it does NOT post any new BC messages itself.
    await sseListenerTab.evaluate(() => {
      window.__h_bc_received = false;
      const spy = new BroadcastChannel('lead_statuses_changed');
      spy.addEventListener('message', () => { window.__h_bc_received = true; });
      // Keep spy open throughout the probe.
      window.__h_bc_spy = spy;
    });

    // ── open Page 2: /customers/:id (WorkflowDataContext SSE relay + mutator) ─
    // CustomerDetailPage is wrapped in WorkflowDataProvider in main.tsx, so
    // WorkflowDataContext mounts here and its SSE EventSource will connect after
    // its built-in 500 ms delay.  We use a dummy contact ID — the detail page
    // will show an empty/error state but WorkflowDataContext still mounts.
    const sseRelayTab = await browser.newPage();
    await sseRelayTab.setCacheEnabled(false);
    await injectSession(sseRelayTab, adminClient.cookie);

    await sseRelayTab.goto(`${BASE}/customers/sse-probe-dummy`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    // Wait for WorkflowDataContext's 500 ms initialTimer + SSE handshake.
    // 2.5 s is conservative; the connection typically opens in < 300 ms.
    await new Promise(r => setTimeout(r, 2500));

    // Perform the PATCH from within the browser context of sseRelayTab.
    // The page already has the admin session cookie, so credentials are included
    // automatically for this same-origin fetch.
    const patchResult = await sseRelayTab.evaluate(async (url, key, label) => {
      try {
        const res = await fetch(
          `${url}/api/admin/lead-statuses/${encodeURIComponent(key)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label }),
          },
        );
        const body = await res.json();
        return { status: res.status, label: body.label };
      } catch (e) {
        return { status: 0, error: String(e) };
      }
    }, BASE, LS_KEY, LABEL_SSE);

    record(
      '[H] in-page PATCH renames lead-status to LABEL_SSE',
      `status=200 label="${LABEL_SSE}"`,
      `status=${patchResult.status} label="${patchResult.label}"`,
      patchResult.status === 200 && patchResult.label === LABEL_SSE,
    );

    // ── wait for the BC spy flag on Page 1 ────────────────────────────────────
    // The server broadcasts SSE → sseRelayTab's WorkflowDataContext receives it
    // → posts BroadcastChannel('lead_statuses_changed') → sseListenerTab's spy
    // and useLeadStatusSync listener both fire.
    await pollUntil(sseListenerTab, () => window.__h_bc_received);
    const bcFlagSet = await sseListenerTab.evaluate(() => !!window.__h_bc_received);
    record(
      '[H] BroadcastChannel message received on sseListenerTab (SSE relay verified)',
      'window.__h_bc_received = true within 8 s',
      `received=${bcFlagSet}`,
      bcFlagSet,
    );

    // ── assert filter dropdown updated on Page 1 ──────────────────────────────
    // useLeadStatusSync's BC listener calls refresh() → loadLeadStatuses() →
    // populateLeadStatusFilter() → the select options reflect LABEL_SSE.
    const sseUpdated = await waitForFilterLabel(sseListenerTab, LABEL_SSE, 8000);
    const optsAfterSse = await getFilterOptions(sseListenerTab);
    record(
      '[H] SSE broadcast causes sseListenerTab filter dropdown to show LABEL_SSE',
      `option starting with "${LABEL_SSE}" within 8 s`,
      `found=${sseUpdated} options: ${JSON.stringify(optsAfterSse.filter(t => t !== 'All statuses').slice(0, 6))}`,
      sseUpdated,
    );

    const staleAfterSse = optsAfterSse.some(t => t.startsWith(LABEL_VIS));
    record(
      '[H] LABEL_VIS absent from sseListenerTab filter after SSE-triggered rename',
      `no option starting with "${LABEL_VIS}"`,
      `stalePresent=${staleAfterSse}`,
      !staleAfterSse,
    );

    await sseListenerTab.evaluate(() => { try { window.__h_bc_spy?.close(); } catch { /**/ } });
    await sseListenerTab.close();
    await sseRelayTab.close();

    // ── (I) SSE broadcast — POST (create) path ────────────────────────────────
    // Sends POST /api/admin/lead-statuses from a browser tab that has
    // WorkflowDataContext's SSE EventSource open.  Asserts that a separate
    // customers tab picks up the new label via SSE → BroadcastChannel → re-render,
    // without any manual BC post or visibilitychange from the test harness.
    console.log('\n  [I] SSE broadcast — POST (create) path');

    const iListenerTab = await browser.newPage();
    await iListenerTab.setCacheEnabled(false);
    await injectSession(iListenerTab, adminClient.cookie);

    await iListenerTab.goto(`${BASE}/customers`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await waitForBootstrapFns(iListenerTab);
    await bootstrapFilter(iListenerTab);

    // Confirm LABEL_SSE (from [H]) is the current state before the POST.
    const optsBeforeI = await getFilterOptions(iListenerTab);
    const hasSseLabelI = optsBeforeI.some(t => t.startsWith(LABEL_SSE));
    record(
      '[I] iListenerTab filter shows LABEL_SSE before POST-create',
      `option starting with "${LABEL_SSE}"`,
      `found=${hasSseLabelI} options: ${JSON.stringify(optsBeforeI.filter(t => t !== 'All statuses').slice(0, 6))}`,
      hasSseLabelI,
    );

    // Attach a passive BC spy on the listener tab.
    await iListenerTab.evaluate(() => {
      window.__i_bc_received = false;
      const spy = new BroadcastChannel('lead_statuses_changed');
      spy.addEventListener('message', () => { window.__i_bc_received = true; });
      window.__i_bc_spy = spy;
    });

    // Open the SSE relay tab (WorkflowDataContext mounts here and opens the
    // EventSource).  Use a dummy contact ID so the page loads quickly.
    const iRelayTab = await browser.newPage();
    await iRelayTab.setCacheEnabled(false);
    await injectSession(iRelayTab, adminClient.cookie);

    await iRelayTab.goto(`${BASE}/customers/sse-probe-dummy`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    // Wait for WorkflowDataContext's 500 ms initialTimer + SSE handshake.
    await new Promise(r => setTimeout(r, 2500));

    // POST the new lead-status from within the browser context (same-origin
    // session cookie, mirrors the real admin-panel flow).
    const postResult = await iRelayTab.evaluate(async (url, key, label) => {
      try {
        const res = await fetch(`${url}/api/admin/lead-statuses`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, label }),
        });
        const body = await res.json();
        return { status: res.status, key: body.key, label: body.label };
      } catch (e) {
        return { status: 0, error: String(e) };
      }
    }, BASE, LS_KEY_NEW, LABEL_NEW);

    record(
      '[I] in-page POST creates new lead-status LABEL_NEW',
      `status=201 key="${LS_KEY_NEW}" label="${LABEL_NEW}"`,
      `status=${postResult.status} key="${postResult.key}" label="${postResult.label}"`,
      postResult.status === 201 && postResult.key === LS_KEY_NEW && postResult.label === LABEL_NEW,
    );

    // Wait for the BC spy flag on the listener tab.
    await pollUntil(iListenerTab, () => window.__i_bc_received);
    const iBcFlagSet = await iListenerTab.evaluate(() => !!window.__i_bc_received);
    record(
      '[I] BroadcastChannel message received on iListenerTab after POST (SSE relay verified)',
      'window.__i_bc_received = true within 8 s',
      `received=${iBcFlagSet}`,
      iBcFlagSet,
    );

    // Assert the new label appears in the filter dropdown on the listener tab.
    const iLabelAppeared = await waitForFilterLabel(iListenerTab, LABEL_NEW, 8000);
    const optsAfterI = await getFilterOptions(iListenerTab);
    record(
      '[I] SSE broadcast (POST) causes iListenerTab filter dropdown to show LABEL_NEW',
      `option starting with "${LABEL_NEW}" within 8 s`,
      `found=${iLabelAppeared} options: ${JSON.stringify(optsAfterI.filter(t => t !== 'All statuses').slice(0, 6))}`,
      iLabelAppeared,
    );

    await iListenerTab.evaluate(() => { try { window.__i_bc_spy?.close(); } catch { /**/ } });

    // ── (J) SSE broadcast — DELETE path ──────────────────────────────────────
    // Deletes the status created in [I] from the same relay tab (SSE EventSource
    // is still open).  Asserts the deleted label disappears from the listener
    // tab's filter dropdown via the same SSE → BroadcastChannel → re-render path.
    console.log('\n  [J] SSE broadcast — DELETE path');

    // Attach a fresh BC spy on the same listener tab.
    await iListenerTab.evaluate(() => {
      window.__j_bc_received = false;
      const spy = new BroadcastChannel('lead_statuses_changed');
      spy.addEventListener('message', () => { window.__j_bc_received = true; });
      window.__j_bc_spy = spy;
    });

    // Send DELETE from the relay tab's browser context.
    const deleteResult = await iRelayTab.evaluate(async (url, key) => {
      try {
        const res = await fetch(
          `${url}/api/admin/lead-statuses/${encodeURIComponent(key)}`,
          { method: 'DELETE' },
        );
        const body = await res.json();
        return { status: res.status, ok: body.ok };
      } catch (e) {
        return { status: 0, error: String(e) };
      }
    }, BASE, LS_KEY_NEW);

    record(
      '[J] in-page DELETE removes LABEL_NEW lead-status',
      `status=200 ok=true`,
      `status=${deleteResult.status} ok=${deleteResult.ok}`,
      deleteResult.status === 200 && deleteResult.ok === true,
    );

    // Wait for the BC spy flag on the listener tab.
    await pollUntil(iListenerTab, () => window.__j_bc_received);
    const jBcFlagSet = await iListenerTab.evaluate(() => !!window.__j_bc_received);
    record(
      '[J] BroadcastChannel message received on iListenerTab after DELETE (SSE relay verified)',
      'window.__j_bc_received = true within 8 s',
      `received=${jBcFlagSet}`,
      jBcFlagSet,
    );

    // Assert the deleted label is gone from the filter dropdown.
    const jLabelGone = await waitForFilterLabelGone(iListenerTab, LABEL_NEW, 8000);
    const optsAfterJ = await getFilterOptions(iListenerTab);
    record(
      '[J] SSE broadcast (DELETE) causes iListenerTab filter dropdown to remove LABEL_NEW',
      `no option starting with "${LABEL_NEW}" within 8 s`,
      `gone=${jLabelGone} options: ${JSON.stringify(optsAfterJ.filter(t => t !== 'All statuses').slice(0, 6))}`,
      jLabelGone,
    );

    await iListenerTab.evaluate(() => { try { window.__j_bc_spy?.close(); } catch { /**/ } });
    await iListenerTab.close();
    await iRelayTab.close();

    // ── (K) Customer-card substatus chip rename — BroadcastChannel path ───────
    // Intercept /api/contacts-all to return a synthetic contact whose
    // hs_lead_status / hw_lead_substatus fields match the test fixtures.
    // This causes CustomerCard to render the substatus chip.  After the
    // chip is visible, rename the sub-status via the admin API, post a
    // `lead_substatuses_changed` BroadcastChannel message from a second tab,
    // and assert the chip text on the card updates in place without a reload.
    //
    // This probes the substatusMap memo in CustomersPage.tsx (line ~1203):
    //   }, [store.subsLoaded, store.subsVersion]);
    // which recomputes whenever loadLeadSubstatuses() increments subsVersion.
    console.log('\n  [K] Customer-card substatus chip rename — BroadcastChannel path');

    // Look up the current ssRow so we can PATCH it.
    const ssListResK = await adminClient.get('/api/admin/lead-substatuses');
    const ssRowK = Array.isArray(ssListResK.json)
      && ssListResK.json.find(s => s.substatus_key === SS_KEY && s.status_key === LS_KEY);
    record(
      '[K] GET /api/admin/lead-substatuses returns the test sub-status',
      `status=200 and substatus_key "${SS_KEY}" present`,
      `status=${ssListResK.status} found=${!!ssRowK}`,
      ssListResK.status === 200 && !!ssRowK,
    );

    if (ssRowK) {
      // Build the mock contact payload once; reused by both K and L.
      const mockContactsPayload = JSON.stringify({
        results: [
          {
            id: 'privtest-card-chip-contact',
            properties: {
              firstname: 'PrivTest',
              lastname: 'CardChip',
              email: 'privtest-card-chip@example.com',
              hs_lead_status: LS_KEY,
              hw_lead_substatus: SS_KEY,
            },
          },
        ],
        total: 1,
        totalPages: 1,
        page: 1,
      });

      // ── K setup: open two fresh tabs ──────────────────────────────────────────
      // chipCardBcTab: the tab under test — contacts are mocked so CustomerCard
      //   always renders with hs_lead_status=LS_KEY / hw_lead_substatus=SS_KEY.
      // chipCardAdminTab: a helper tab used only to post BroadcastChannel messages
      //   (BC.postMessage from a different page so the listener tab receives them).
      const chipCardBcTab = await browser.newPage();
      await chipCardBcTab.setCacheEnabled(false);
      await injectSession(chipCardBcTab, adminClient.cookie);

      const chipCardAdminTab = await browser.newPage();
      await chipCardAdminTab.setCacheEnabled(false);
      await injectSession(chipCardAdminTab, adminClient.cookie);

      // Intercept /api/contacts-all so the card always shows our test contact.
      // All other requests (including /api/lead-substatuses) pass through to the
      // real test server so the substatusMap store populates normally.
      await chipCardBcTab.setRequestInterception(true);
      chipCardBcTab.on('request', req => {
        if (/\/api\/contacts-all(\?|$)/.test(req.url())) {
          req.respond({
            status: 200,
            contentType: 'application/json',
            body: mockContactsPayload,
          });
        } else {
          req.continue();
        }
      });

      await chipCardBcTab.goto(`${BASE}/customers`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });

      // Wait for the CustomersPage lazy chunk to finish loading.
      // waitForBootstrapFns polls for window.loadLeadStatuses (15 s timeout);
      // window.loadLeadSubstatuses lives in the same chunk so it is guaranteed
      // to be defined by the time waitForBootstrapFns resolves.
      await waitForBootstrapFns(chipCardBcTab);

      // Explicitly call loadLeadSubstatuses() to prime store.substatuses before
      // polling the chip.  The mount-effect fires it automatically, but with an
      // instant contacts mock the card can render before the async fetch
      // resolves; this explicit call guarantees the store is populated first.
      await chipCardBcTab.evaluate(async () => {
        await window.loadLeadSubstatuses();
      });

      // The current sub-status label is SS_LABEL_VIS (left by section G).
      // Poll until the chip appears (requires substatusMap to be populated and
      // the CustomerCard to re-render via notify() → forceRender()).
      const chipKInit = await waitForChipLabel(chipCardBcTab, SS_LABEL_VIS, 6000);
      record(
        '[K] card substatus chip shows SS_LABEL_VIS on initial render',
        `MuiChip with label "${SS_LABEL_VIS}" visible within 6 s`,
        `visible=${chipKInit}`,
        chipKInit,
      );

      // Rename the sub-status via the admin API.
      const ssPatchK = await adminClient.patch(
        `/api/admin/lead-substatuses/${ssRowK.id}`,
        { label: SS_LABEL_CARD_BC },
      );
      record(
        '[K] PATCH /api/admin/lead-substatuses/:id renames sub-status for card chip test',
        `status=200 label="${SS_LABEL_CARD_BC}"`,
        `status=${ssPatchK.status} label="${ssPatchK.json?.label}"`,
        ssPatchK.status === 200 && ssPatchK.json?.label === SS_LABEL_CARD_BC,
      );

      // Navigate chipCardAdminTab to the same origin before posting the BC message.
      // BroadcastChannel is origin-scoped; a page at about:blank has a null origin
      // and cannot reach listeners on http://127.0.0.1:5050.
      await chipCardAdminTab.goto(`${BASE}/customers`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      // Post the BC message from a different same-origin tab so chipCardBcTab's
      // 'lead_substatuses_changed' listener receives it.  The listener calls
      // refresh() → loadLeadSubstatuses() → store.subsVersion increments →
      // notify() → forceRender() → substatusMap recomputes → CustomerCard
      // re-renders with the renamed label.
      await chipCardAdminTab.evaluate(() => {
        new BroadcastChannel('lead_substatuses_changed').postMessage('changed');
      });

      const chipKBcUpdated = await waitForChipLabel(chipCardBcTab, SS_LABEL_CARD_BC, 7000);
      record(
        '[K] BroadcastChannel message updates card substatus chip to renamed label',
        `MuiChip with label "${SS_LABEL_CARD_BC}" within 7 s`,
        `found=${chipKBcUpdated}`,
        chipKBcUpdated,
      );

      const chipKBcStale = await chipCardBcTab.evaluate((lbl) => {
        return Array.from(document.querySelectorAll('.MuiChip-label'))
          .some(c => c.textContent.trim() === lbl);
      }, SS_LABEL_VIS);
      record(
        '[K] SS_LABEL_VIS absent from card chip after BroadcastChannel rename',
        `no MuiChip with label "${SS_LABEL_VIS}"`,
        `stalePresent=${chipKBcStale}`,
        !chipKBcStale,
      );

      await chipCardBcTab.close();
      await chipCardAdminTab.close();

      // ── (L) Customer-card substatus chip rename — visibilitychange path ──────
      // Open a fresh customers tab (same contact mock), confirm chip shows the
      // BC-renamed label (SS_LABEL_CARD_BC, left by section K), rename again
      // server-side, synthesise hidden→visible visibilitychange, and assert the
      // card chip updates in place without a full reload.
      console.log('\n  [L] Customer-card substatus chip rename — visibilitychange path');

      const chipCardVisTab = await browser.newPage();
      await chipCardVisTab.setCacheEnabled(false);
      await injectSession(chipCardVisTab, adminClient.cookie);

      await chipCardVisTab.setRequestInterception(true);
      chipCardVisTab.on('request', req => {
        if (/\/api\/contacts-all(\?|$)/.test(req.url())) {
          req.respond({
            status: 200,
            contentType: 'application/json',
            body: mockContactsPayload,
          });
        } else {
          req.continue();
        }
      });

      await chipCardVisTab.goto(`${BASE}/customers`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });

      // Same explicit warm-up as section K: wait for the lazy chunk, then
      // prime store.substatuses so the chip is visible before the vis-rename.
      await waitForBootstrapFns(chipCardVisTab);
      await chipCardVisTab.evaluate(async () => {
        await window.loadLeadSubstatuses();
      });

      // DB label is SS_LABEL_CARD_BC (left by section K's PATCH).
      const chipLInit = await waitForChipLabel(chipCardVisTab, SS_LABEL_CARD_BC, 6000);
      record(
        '[L] card substatus chip shows SS_LABEL_CARD_BC before visibilitychange rename',
        `MuiChip with label "${SS_LABEL_CARD_BC}" visible within 6 s`,
        `visible=${chipLInit}`,
        chipLInit,
      );

      // Rename server-side so the next /api/lead-substatuses returns SS_LABEL_CARD_VIS.
      const ssPatchL = await adminClient.patch(
        `/api/admin/lead-substatuses/${ssRowK.id}`,
        { label: SS_LABEL_CARD_VIS },
      );
      record(
        '[L] PATCH /api/admin/lead-substatuses/:id renames sub-status for visibilitychange test',
        `status=200 label="${SS_LABEL_CARD_VIS}"`,
        `status=${ssPatchL.status} label="${ssPatchL.json?.label}"`,
        ssPatchL.status === 200 && ssPatchL.json?.label === SS_LABEL_CARD_VIS,
      );

      // Synthesise hidden → visible (mirrors sections B and G).
      // The onVisibility handler checks visibilityState === 'visible' before calling
      // refresh() → loadLeadSubstatuses() → store.subsVersion increments → notify()
      // → substatusMap memo recomputes → CustomerCard re-renders with new label.
      await chipCardVisTab.evaluate(() => {
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

      const chipLVisUpdated = await waitForChipLabel(chipCardVisTab, SS_LABEL_CARD_VIS, 7000);
      record(
        '[L] visibilitychange updates card substatus chip to renamed label',
        `MuiChip with label "${SS_LABEL_CARD_VIS}" within 7 s`,
        `found=${chipLVisUpdated}`,
        chipLVisUpdated,
      );

      const chipLVisStale = await chipCardVisTab.evaluate((lbl) => {
        return Array.from(document.querySelectorAll('.MuiChip-label'))
          .some(c => c.textContent.trim() === lbl);
      }, SS_LABEL_CARD_BC);
      record(
        '[L] SS_LABEL_CARD_BC absent from card chip after visibilitychange refresh',
        `no MuiChip with label "${SS_LABEL_CARD_BC}"`,
        `stalePresent=${chipLVisStale}`,
        !chipLVisStale,
      );

      await chipCardVisTab.close();
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
    '- **(H) SSE broadcast path** (two-page setup): opens two browser tabs.',
    '  `sseListenerTab` navigates to `/customers` (has `useLeadStatusSync`\'s',
    '  `BroadcastChannel(\'lead_statuses_changed\')` listener; carries the',
    '  filter dropdown). A passive BC spy sets `window.__h_bc_received` on any',
    '  incoming BC message — no BC re-post, so success depends entirely on the',
    '  production `WorkflowDataContext` → `BroadcastChannel` bridge.',
    '  `sseRelayTab` navigates to `/customers/:id` (CustomerDetailPage is wrapped',
    '  in `WorkflowDataProvider` in `main.tsx`), which causes `WorkflowDataContext`',
    '  to mount and open an `EventSource` to `GET /api/hubspot/webhook-events` after',
    '  its built-in 500 ms delay. After 2.5 s the relay tab PATCHes',
    '  `PATCH /api/admin/lead-statuses/:key` via an in-page `fetch()` call',
    '  (browser context, same-origin session cookie — mirrors the real admin flow).',
    '  The server broadcasts `lead_statuses_changed` SSE; `sseRelayTab`\'s',
    '  `WorkflowDataContext` EventSource fires and posts a',
    '  `BroadcastChannel(\'lead_statuses_changed\')` message; `sseListenerTab`\'s',
    '  `useLeadStatusSync` BC listener calls `refresh()` → `loadLeadStatuses()`',
    '  → `populateLeadStatusFilter()` → filter shows the new label. Asserts',
    '  (i) `window.__h_bc_received` is true within 8 s, (ii) the new label',
    '  appears in the filter dropdown within 8 s, (iii) the old label is absent.',
    '  Exercises: server-side SSE broadcast (lines ~4221–4224 of `server.js`),',
    '  the SSE → BC bridge in `WorkflowDataContext.tsx` lines ~319–324, and the',
    '  BC → `refresh()` path in `CustomersPage.tsx` `useLeadStatusSync`.',
    '- **(I) SSE broadcast — POST (create) path** (two-page setup): follows the',
    '  same two-tab pattern as [H]. `iListenerTab` navigates to `/customers` with',
    '  a passive `window.__i_bc_received` spy. `iRelayTab` opens `/customers/:id`',
    '  so `WorkflowDataContext` mounts its SSE `EventSource`. After 2.5 s,',
    '  `iRelayTab` calls `POST /api/admin/lead-statuses` with a fresh key',
    '  (`PRIVTEST_LS_SYNC_NEW`) and label (`PrivTest Created New`) via in-page',
    '  `fetch()`. The server broadcasts `lead_statuses_changed` SSE; the BC bridge',
    '  fires on `iListenerTab`; `useLeadStatusSync` calls `refresh()` →',
    '  `loadLeadStatuses()` → `populateLeadStatusFilter()`. Asserts (i)',
    '  `window.__i_bc_received` is true within 8 s, (ii) the new label appears',
    '  in the filter dropdown within 8 s. Exercises the POST SSE broadcast path',
    '  in `server.js` (lines ~4266–4269).',
    '- **(J) SSE broadcast — DELETE path** (continues on the same two tabs): reuses',
    '  `iListenerTab` and `iRelayTab` from [I]. Attaches a fresh',
    '  `window.__j_bc_received` spy on `iListenerTab`, then calls',
    '  `DELETE /api/admin/lead-statuses/PRIVTEST_LS_SYNC_NEW` from `iRelayTab`\'s',
    '  browser context. The server broadcasts `lead_statuses_changed` SSE; the BC',
    '  bridge fires; `useLeadStatusSync` refreshes the dropdown. Asserts (i)',
    '  `window.__j_bc_received` is true within 8 s, (ii) the deleted label is',
    '  absent from the filter dropdown within 8 s. Exercises the DELETE SSE',
    '  broadcast path in `server.js` (lines ~4555–4562).',
    '- **(K) Customer-card substatus chip rename — BroadcastChannel path**: intercepts',
    '  `GET /api/contacts-all` via Puppeteer request interception to return a',
    '  synthetic contact with `hs_lead_status: LS_KEY` and',
    '  `hw_lead_substatus: SS_KEY`. This causes `CustomerCard` to render the',
    '  per-contact substatus chip (line ~686 of `CustomersPage.tsx`). Renames the',
    '  sub-status label via `PATCH /api/admin/lead-substatuses/:id`, then posts a',
    '  `lead_substatuses_changed` BroadcastChannel message from a second tab.',
    '  Asserts the chip text on the card updates to the new label and the old',
    '  label is absent — without a full page reload. Exercises the',
    '  `subBc.addEventListener` → `loadLeadSubstatuses()` → `store.subsVersion++`',
    '  → `notify()` → `substatusMap` memo recompute path in `CustomersPage.tsx`.',
    '- **(L) Customer-card substatus chip rename — visibilitychange path**: opens a',
    '  fresh customers tab with the same `contacts-all` mock (contact with',
    '  `hs_lead_status: LS_KEY`, `hw_lead_substatus: SS_KEY`). Confirms the card',
    '  chip shows the BC-renamed label from [K], renames the sub-status again',
    '  server-side, then synthesises a hidden→visible `visibilitychange` sequence.',
    '  Asserts the card chip updates to the new label and the prior label is absent.',
    '  Exercises the `document.addEventListener("visibilitychange", onVisibility)`',
    '  → `loadLeadSubstatuses()` → `store.subsVersion++` → `substatusMap` recompute',
    '  path — the regression guard introduced in task #1923.',
    '',
    '## Notes',
    '',
    '- The test server strips `HUBSPOT_TOKEN` so `loadAllContacts()` returns 503.',
    '  Contact counts in the filter options will therefore all be 0 in CI.',
    '  The `bootstrapFilter()` helper calls `loadLeadStatuses()` +',
    '  `window.populateLeadStatusFilter()` (exposed by the React bundle, not',
    '  workflow-core.js) directly in the page context to establish the initial',
    '  filter state independently of the HubSpot contact load.',
    '- Sections (K) and (L) use Puppeteer `req.respond()` to intercept',
    '  `GET /api/contacts-all` and return a synthetic contact with the test',
    '  substatus keys so the card substatus chip renders. All other requests',
    '  (including `/api/lead-statuses` and `/api/lead-substatuses`) pass through',
    '  normally so `substatusMap` is populated from real database rows.',
  ];
  const outPath = path.join(dir, 'lead-status-sync.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/lead-status-sync.md`);
}

main();
