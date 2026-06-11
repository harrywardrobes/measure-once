'use strict';
const { makeSkip } = require('../helpers/report');

const PROBE_LABELS = [
  '(H) pill primary text updates in place after sub-status rename via BroadcastChannel',
  '(I) pill primary text updates in place after sub-status rename via visibilitychange',
];

// test/lead-status-sync/customer-detail.js
//
// End-to-end live test: customer-detail lead-status tracker stays in sync with
// admin-side renames/reorders of lead statuses and sub-statuses, both via
// BroadcastChannel and via visibilitychange (tab-focus refresh).
//
// Sibling of test/lead-status-sync/run.js (which covers the Customers-page
// filter dropdown). This file covers the per-contact tracker built in
// _renderWorkflowStagesImpl (public/customer-detail.js) and the BC/visibility
// handlers that call renderWorkflowStages in workflow-core.js lines 482–534.
//
// The test server runs without HUBSPOT_TOKEN, so loading a real contact via
// /api/contacts/:id 503s and the customer-detail page replaces #workflow-view
// with an error. We compensate by seeding state.selectedContact with the
// lead-status under test and driving renderWorkflowStages() directly — the
// same entry point the BroadcastChannel + visibilitychange handlers invoke to
// refresh the CustomerDetailHeader pill.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:lead-status-sync-customer-detail
//   # or against the shared DB with the privtest- prefix cleanup:
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:lead-status-sync-customer-detail

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
// Three lead statuses: two visible (one is "current"), one excluded from sales
// (must NOT appear in the rail). Keys are PRIVTEST_-prefixed for cleanup.
const KEY_A = 'PRIVTEST_LS_DT_A';
const KEY_B = 'PRIVTEST_LS_DT_B';
const KEY_X = 'PRIVTEST_LS_DT_X'; // excluded_from_sales
const LABEL_A_ORIG = 'PrivTest DT Status A';
const LABEL_A_BC   = 'PrivTest DT A Renamed BC';
const LABEL_A_VIS  = 'PrivTest DT A Renamed Vis';
const LABEL_B      = 'PrivTest DT Status B';
const LABEL_X      = 'PrivTest DT Excluded';

const SUB_A_KEY    = 'STEP_ONE';
const SUB_A_LABEL  = 'PrivTest DT Substep One';
const SUB_A_RENAME = 'PrivTest DT Substep One Renamed';
const SUB_A2_KEY   = 'STEP_TWO';
const SUB_A2_LABEL = 'PrivTest DT Substep Two';

const CONTACT_ID = '999999999';

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

// Seed an in-page contact for the tracker tests. The real customer-detail
// bootstrap replaces #workflow-view with an error when the contact 503s; we
// load lead statuses + sub-statuses, set state.selectedContact to the chosen
// hs_lead_status, then call renderWorkflowStages so the header pill renderer
// runs against the live data we just seeded.
//
// IMPORTANT: stamp window.__renderToken so the BC/visibilitychange assertions
// can prove the tracker re-rendered in place (no full page reload).
async function bootstrapTracker(page, currentLs, currentSub = '', role = 'admin') {
  return page.evaluate(async (lsKey, subVal, userRole) => {
    // React manages its own DOM — do NOT wipe #workflow-view's innerHTML here.
    // Seed the globals and let renderWorkflowStages() drive a React re-render.
    if (typeof loadLeadStatuses === 'function')   await loadLeadStatuses();
    if (typeof loadLeadSubstatuses === 'function') await loadLeadSubstatuses();
    state.selectedContact = {
      id: '999999999',
      properties: {
        hs_lead_status:    lsKey,
        hw_lead_substatus: subVal,
        firstname: 'Priv', lastname: 'Test', email: 'privtest@privtest.local',
      },
    };
    state.selectedContactId = '999999999';
    state.user = { privilege_level: userRole };
    window.__moHeaderUser = { privilege_level: userRole };
    state.focusedLeadStatus = null; // let renderer clamp to current
    window.__renderToken = window.__renderToken || ('tok_' + Math.random().toString(36).slice(2));
    if (typeof renderWorkflowStages === 'function') renderWorkflowStages();
    return { renderToken: window.__renderToken };
  }, currentLs, currentSub, role);
}

async function waitFor(page, predFn, args = {}, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(predFn, args);
    if (ok) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
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
  console.log(`\n  lead-status-sync customer-detail E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  const PRIVTEST_KEYS = [KEY_A, KEY_B, KEY_X];

  // Pre-clean stale fixtures.
  await cleanupTestData(pool);
  await pool.query(`DELETE FROM lead_substatuses WHERE status_key = ANY($1)`, [PRIVTEST_KEYS]);
  await pool.query(`DELETE FROM lead_status_config WHERE key = ANY($1)`, [PRIVTEST_KEYS]);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}`);

  // Lead statuses: sort_order is monotonically increasing & high to avoid
  // colliding with real production rows. KEY_X is excluded_from_sales and
  // must NOT appear in the rail.
  await pool.query(
    `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
     VALUES ($1, $2, 990, false),
            ($3, $4, 991, false),
            ($5, $6, 992, true)
     ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label,
       sort_order = EXCLUDED.sort_order, excluded_from_sales = EXCLUDED.excluded_from_sales`,
    [KEY_A, LABEL_A_ORIG, KEY_B, LABEL_B, KEY_X, LABEL_X],
  );

  // Two sub-statuses for KEY_A (focused entry in our test), in admin order.
  await pool.query(
    `INSERT INTO lead_substatuses (status_key, substatus_key, label, sort_order)
     VALUES ($1, $2, $3, 1), ($1, $4, $5, 2)`,
    [KEY_A, SUB_A_KEY, SUB_A_LABEL, SUB_A2_KEY, SUB_A2_LABEL],
  );
  console.log(`  Inserted 3 lead statuses (2 visible, 1 excluded) + 2 sub-statuses\n`);

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
      await pool.query(`DELETE FROM lead_substatuses WHERE status_key = ANY($1)`, [PRIVTEST_KEYS]);
      await pool.query(`DELETE FROM lead_status_config WHERE key = ANY($1)`, [PRIVTEST_KEYS]);
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

  // ── API pre-checks ─────────────────────────────────────────────────────────
  const adminClient = await login(users.admin.email, PASSWORD);

  const subRes = await adminClient.get('/api/admin/lead-substatuses');
  const subRowA = Array.isArray(subRes.json)
    ? subRes.json.find(r => r.status_key === KEY_A && r.substatus_key === SUB_A_KEY)
    : null;
  const subRowA2 = Array.isArray(subRes.json)
    ? subRes.json.find(r => r.status_key === KEY_A && r.substatus_key === SUB_A2_KEY)
    : null;
  record(
    'GET /api/admin/lead-substatuses returns the seeded sub-statuses',
    `status=200 and rows for (${KEY_A}, ${SUB_A_KEY}) and (${KEY_A}, ${SUB_A2_KEY}) present`,
    `status=${subRes.status} foundA=${!!subRowA} foundA2=${!!subRowA2}`,
    subRes.status === 200 && !!subRowA && !!subRowA2,
  );
  const SUB_A_ID  = subRowA?.id;
  const SUB_A2_ID = subRowA2?.id;

  const pubLs = await adminClient.get('/api/lead-statuses');
  const visibleKeys = Array.isArray(pubLs.json)
    ? pubLs.json.filter(r => !r.is_null_row).map(r => r.key)
    : [];
  const hasA = visibleKeys.includes(KEY_A);
  const hasB = visibleKeys.includes(KEY_B);
  record(
    'GET /api/lead-statuses returns both visible test statuses',
    `keys include ${KEY_A} and ${KEY_B}`,
    `keys present: A=${hasA} B=${hasB}`,
    pubLs.status === 200 && hasA && hasB,
  );

  // ── puppeteer ──────────────────────────────────────────────────────────────
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

  try {
    // ── tab open & initial render ─────────────────────────────────────────────
    console.log('\n  [0] initial render on /customers/:id');

    const detailTab = await browser.newPage();
    await detailTab.setCacheEnabled(false);
    await injectSession(detailTab, adminClient.cookie);

    await detailTab.goto(`${BASE}/customers/${CONTACT_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    // Poll until the page bootstrap functions are defined, which means the
    // DOMContentLoaded handler has run and the initial /api/contacts/:id call
    // has had time to settle (503 under the stripped HUBSPOT_TOKEN).
    await waitFor(detailTab, () =>
      typeof state !== 'undefined' &&
      typeof renderWorkflowStages === 'function' &&
      typeof loadLeadStatuses === 'function',
    {}, 10000);

    const { renderToken: initialToken } = await bootstrapTracker(detailTab, KEY_A, '');

    // ── (C) Unified picker: sub-status rows appear indented beneath parent ────
    console.log('\n  [C] Unified picker: sub-status rows appear indented beneath parent');

    // Re-seed state with KEY_A active and no sub-status so the picker test
    // starts from a clean baseline regardless of the renames above.
    await bootstrapTracker(detailTab, KEY_A, '');

    // Also ensure state.contacts includes the contact so openLeadStatusPicker
    // can find stalePrevStatus before the async GET returns.
    await detailTab.evaluate((cid, key) => {
      if (!Array.isArray(state.contacts)) state.contacts = [];
      const existing = state.contacts.find(c => c.id === cid);
      if (existing) {
        existing.properties = { ...existing.properties, hs_lead_status: key, hw_lead_substatus: '' };
      } else {
        state.contacts.push({
          id: cid,
          properties: {
            hs_lead_status: key, hw_lead_substatus: '',
            firstname: 'Priv', lastname: 'Test', email: 'privtest@privtest.local',
          },
        });
      }
    }, CONTACT_ID, KEY_A);

    // Render the lead-status pill into #workflow-header (already in the DOM).
    await detailTab.evaluate(() => {
      if (typeof renderWorkflowHeader === 'function') renderWorkflowHeader();
    });
    // Poll until the pill is present in the header.
    await waitFor(detailTab, () =>
      !!document.querySelector('#workflow-header .lead-status-badge'), {}, 5000);

    // Enable request interception so:
    //   GET  /api/contacts/:id → returns mocked contact (avoids 503 noise)
    //   PATCH /api/contacts/:id → returns 200 so _quickSetLeadStatusWithSub
    //                              doesn't roll back the optimistic update.
    // All other requests pass through untouched.
    await detailTab.setRequestInterception(true);
    const patchedBodies = [];
    const _reqHandler = req => {
      const url    = req.url();
      const method = req.method();
      if (method === 'PATCH' && url.includes(`/api/contacts/${CONTACT_ID}`)) {
        try { patchedBodies.push(JSON.parse(req.postData() || '{}')); } catch {}
        req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: CONTACT_ID, properties: {} }),
        });
      } else if (method === 'GET' && url.includes(`/api/contacts/${CONTACT_ID}`) &&
                 !url.includes('/localdata') && !url.includes('/notes') &&
                 !url.includes('/tasks')) {
        req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: CONTACT_ID,
            properties: {
              hs_lead_status: KEY_A, hw_lead_substatus: '',
              firstname: 'Priv', lastname: 'Test', email: 'privtest@privtest.local',
            },
          }),
        });
      } else {
        req.continue();
      }
    };
    detailTab.on('request', _reqHandler);

    const pillExists = await detailTab.evaluate(() =>
      !!document.querySelector('#workflow-header .lead-status-badge.lsb-clickable'));
    record(
      'lead-status pill is rendered in #workflow-header',
      'pill with class lsb-clickable is present',
      `found=${pillExists}`,
      pillExists,
    );

    if (pillExists) {
      await detailTab.click('#workflow-header .lead-status-badge.lsb-clickable');

      // Wait for the picker popup.
      await detailTab.waitForSelector('#card-picker-popup', { timeout: 6000 }).catch(() => {});
      const pickerOpen = await detailTab.evaluate(() => !!document.getElementById('card-picker-popup'));
      record(
        'clicking pill opens the unified picker popup (#card-picker-popup)',
        '#card-picker-popup appears in DOM',
        `found=${pickerOpen}`,
        pickerOpen,
      );

      if (pickerOpen) {
        // Assert sub-status rows are present and appear after their parent row.
        // Scope sub-status detection to rows immediately after KEY_A's parent
        // so real statuses in a shared DB don't shift the global index.
        const subRows = await detailTab.evaluate((key) => {
          const popup = document.getElementById('card-picker-popup');
          if (!popup) return { subCount: 0, parentIdx: -1, firstSubIdx: -1, subLabels: [] };
          const opts      = Array.from(popup.querySelectorAll('.card-picker-opt'));
          const parentIdx = opts.findIndex(o => o.dataset.leadStatus === key);
          // Collect sub-status rows that belong to KEY_A — they appear directly
          // after the parent and before the next non-sub option.
          const ownSubOpts = [];
          let firstSubIdx  = -1;
          if (parentIdx !== -1) {
            for (let i = parentIdx + 1; i < opts.length; i++) {
              if (!opts[i].classList.contains('card-picker-opt--sub')) break;
              ownSubOpts.push(opts[i]);
              if (firstSubIdx === -1) firstSubIdx = i;
            }
          }
          return {
            subCount:  ownSubOpts.length,
            parentIdx,
            firstSubIdx,
            subLabels: ownSubOpts.map(o => o.textContent.trim()),
          };
        }, KEY_A);

        record(
          'picker shows sub-status rows (card-picker-opt--sub) for the active parent',
          `at least 2 sub-status rows present`,
          `subCount=${subRows.subCount} subLabels=${JSON.stringify(subRows.subLabels)}`,
          subRows.subCount >= 2,
        );

        record(
          'sub-status rows appear after their parent row in the picker',
          `firstSubIdx > parentIdx`,
          `parentIdx=${subRows.parentIdx} firstSubIdx=${subRows.firstSubIdx}`,
          subRows.parentIdx !== -1 && subRows.firstSubIdx > subRows.parentIdx,
        );

        // ── (D) Clicking a sub-status fires exactly one PATCH with both fields ─
        console.log('\n  [D] Clicking sub-status fires exactly one PATCH with hs_lead_status + hw_lead_substatus');

        patchedBodies.length = 0;

        // Capture the label of KEY_A's first sub-status row before clicking so
        // probe E can verify the pill reflects that exact label.
        // Scope to KEY_A's own sub-statuses (immediately after the parent row)
        // to avoid clicking a sub-status belonging to a different real status.
        const clickedSubLabel = await detailTab.evaluate((key) => {
          const popup = document.getElementById('card-picker-popup');
          if (!popup) return '';
          const opts      = Array.from(popup.querySelectorAll('.card-picker-opt'));
          const parentIdx = opts.findIndex(o => o.dataset.leadStatus === key);
          if (parentIdx === -1) return '';
          for (let i = parentIdx + 1; i < opts.length; i++) {
            const o = opts[i];
            if (!o.classList.contains('card-picker-opt--sub')) break;
            const label = o.textContent.trim();
            o.click();
            return label;
          }
          return '';
        }, KEY_A);

        // Poll (Node-side) until the intercepted PATCH request has been captured.
        await (async () => {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            if (patchedBodies.length > 0) break;
            await new Promise(r => setTimeout(r, 100));
          }
        })();

        record(
          'clicking sub-status row fires exactly one PATCH request',
          'patchedBodies.length === 1',
          `count=${patchedBodies.length}`,
          patchedBodies.length === 1,
        );

        const pBody = patchedBodies[0] || {};
        record(
          'PATCH body contains both hs_lead_status and hw_lead_substatus',
          `hs_lead_status="${KEY_A}" hw_lead_substatus starts with "${KEY_A}__"`,
          `hs_lead_status="${pBody.hs_lead_status}" hw_lead_substatus="${pBody.hw_lead_substatus}"`,
          pBody.hs_lead_status === KEY_A &&
          String(pBody.hw_lead_substatus || '').toUpperCase().startsWith(`${KEY_A}__`),
        );

        // ── (E) Pill text starts with the selected sub-status label ───────────
        console.log('\n  [E] Pill label reflects selected sub-status');

        // Re-render the header so the pill reflects the optimistic state update.
        await detailTab.evaluate(() => {
          if (typeof renderWorkflowHeader === 'function') renderWorkflowHeader();
        });
        // Poll until the pill shows a .ls-pill-parent span (sub-status selected).
        await waitFor(detailTab, () =>
          !!document.querySelector('#workflow-header .lead-status-badge .ls-pill-parent'), {}, 5000);

        const pillLabel = await detailTab.evaluate(() => {
          const pill = document.querySelector('#workflow-header .lead-status-badge');
          if (!pill) return { text: '', hasParent: false, primaryText: '' };
          const parentSpan = pill.querySelector('.ls-pill-parent');
          // The primary text is the pill's text without the parent-span content.
          let primaryText = pill.textContent.trim();
          if (parentSpan) {
            primaryText = primaryText.slice(0, primaryText.length - parentSpan.textContent.length).trim();
          }
          return {
            text:        pill.textContent.trim(),
            hasParent:   !!parentSpan,
            primaryText,
          };
        });

        record(
          'pill has .ls-pill-parent span and primary text matches the clicked sub-status label',
          `hasParent=true primaryText="${clickedSubLabel}"`,
          `hasParent=${pillLabel.hasParent} primaryText="${pillLabel.primaryText}" fullText="${pillLabel.text}"`,
          pillLabel.hasParent && pillLabel.primaryText === clickedSubLabel,
        );

        // ── (F) BC + visibilitychange: pill reflects updated sub-status label ─
        console.log('\n  [F] BC + visibilitychange: pill reflects renamed sub-status label');

        // Rename the active sub-status via admin PATCH and fan-out via BC.
        const SUB_A_FINAL = 'PrivTest DT Substep One Final';
        const patchSubFinal = await adminClient.patch(
          `/api/admin/lead-substatuses/${SUB_A_ID}`,
          { label: SUB_A_FINAL },
        );
        record(
          'PATCH /api/admin/lead-substatuses/:id renames sub-status for pill BC test',
          `status=200 label="${SUB_A_FINAL}"`,
          `status=${patchSubFinal.status} label="${patchSubFinal.json?.label}"`,
          patchSubFinal.status === 200 && patchSubFinal.json?.label === SUB_A_FINAL,
        );

        // Open a second tab as BC sender (BC does not deliver to self).
        const senderTab2 = await browser.newPage();
        await senderTab2.setCacheEnabled(false);
        await injectSession(senderTab2, adminClient.cookie);
        await senderTab2.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        // Poll until the customers page has bootstrapped enough to use BroadcastChannel.
        await waitFor(senderTab2, () => typeof state !== 'undefined', {}, 8000);

        await senderTab2.evaluate(() => {
          new BroadcastChannel('lead_substatuses_changed').postMessage('changed');
        });

        const pillBcUpdated = await waitFor(detailTab, (args) => {
          const pill = document.querySelector('#workflow-header .lead-status-badge');
          if (!pill) return false;
          return (pill.textContent || '').includes(args.label);
        }, { label: SUB_A_FINAL }, 8000);

        const pillBcText = await detailTab.evaluate(() => {
          const pill = document.querySelector('#workflow-header .lead-status-badge');
          return pill ? pill.textContent.trim() : '';
        });
        record(
          'BC lead_substatuses_changed updates pill to renamed sub-status (no reload)',
          `pill contains "${SUB_A_FINAL}" within 8 s`,
          `found=${pillBcUpdated} pillText="${pillBcText}"`,
          pillBcUpdated,
        );

        // Rename again for the visibilitychange probe.
        const SUB_A_VIS_FINAL = 'PrivTest DT Substep One Vis';
        const patchSubVisFinal = await adminClient.patch(
          `/api/admin/lead-substatuses/${SUB_A_ID}`,
          { label: SUB_A_VIS_FINAL },
        );
        record(
          'second sub-status PATCH for visibilitychange pill test succeeds',
          `status=200 label="${SUB_A_VIS_FINAL}"`,
          `status=${patchSubVisFinal.status} label="${patchSubVisFinal.json?.label}"`,
          patchSubVisFinal.status === 200 && patchSubVisFinal.json?.label === SUB_A_VIS_FINAL,
        );

        // Synthesise hidden → visible visibilitychange sequence.
        await detailTab.evaluate(() => {
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

        const pillVisUpdated = await waitFor(detailTab, (args) => {
          const pill = document.querySelector('#workflow-header .lead-status-badge');
          if (!pill) return false;
          return (pill.textContent || '').includes(args.label);
        }, { label: SUB_A_VIS_FINAL }, 8000);

        const pillVisText = await detailTab.evaluate(() => {
          const pill = document.querySelector('#workflow-header .lead-status-badge');
          return pill ? pill.textContent.trim() : '';
        });
        record(
          'visibilitychange updates pill to renamed sub-status (no reload)',
          `pill contains "${SUB_A_VIS_FINAL}" within 8 s`,
          `found=${pillVisUpdated} pillText="${pillVisText}"`,
          pillVisUpdated,
        );

        await senderTab2.close();

        // ── (G) Clear status from the unified picker also clears sub-status ───
        console.log('\n  [G] Unified picker "Clear status" clears both hs_lead_status and hw_lead_substatus');

        // After (D)/(E)/(F) state.selectedContact has hs_lead_status=KEY_A
        // and hw_lead_substatus=KEY_A__STEP_ONE (the value never changed —
        // only its label was renamed). Re-open the picker against that state.
        const pillStillThere = await detailTab.evaluate(() =>
          !!document.querySelector('#workflow-header .lead-status-badge.lsb-clickable'));
        record(
          'lead-status pill is still clickable before Clear-status probe',
          'pill with class lsb-clickable is present',
          `found=${pillStillThere}`,
          pillStillThere,
        );

        if (pillStillThere) {
          await detailTab.click('#workflow-header .lead-status-badge.lsb-clickable');
          await detailTab.waitForSelector('#card-picker-popup .card-picker-opt--clear', { timeout: 6000 })
            .catch(() => {});

          const clearBtnState = await detailTab.evaluate(() => {
            const btn = document.querySelector('#card-picker-popup .card-picker-opt--clear');
            return {
              present:  !!btn,
              disabled: btn ? (btn.disabled || btn.classList.contains('card-picker-opt--disabled')) : true,
              text:     btn ? btn.textContent.trim() : '',
            };
          });
          record(
            'unified picker shows an enabled "Clear status" button when a status is set',
            'card-picker-opt--clear button present and enabled',
            `present=${clearBtnState.present} disabled=${clearBtnState.disabled} text="${clearBtnState.text}"`,
            clearBtnState.present && !clearBtnState.disabled,
          );

          patchedBodies.length = 0;

          await detailTab.evaluate(() => {
            const btn = document.querySelector('#card-picker-popup .card-picker-opt--clear');
            if (btn) btn.click();
          });

          // Poll (Node-side) until the intercepted PATCH request has been captured.
          await (async () => {
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
              if (patchedBodies.length > 0) break;
              await new Promise(r => setTimeout(r, 100));
            }
          })();

          record(
            'clicking "Clear status" fires exactly one PATCH request',
            'patchedBodies.length === 1',
            `count=${patchedBodies.length}`,
            patchedBodies.length === 1,
          );

          const clrBody = patchedBodies[0] || {};
          record(
            'PATCH body clears hs_lead_status',
            `hs_lead_status === ""`,
            `hs_lead_status=${JSON.stringify(clrBody.hs_lead_status)}`,
            clrBody.hs_lead_status === '',
          );
          record(
            'PATCH body clears hw_lead_substatus alongside hs_lead_status',
            `hw_lead_substatus === ""`,
            `hw_lead_substatus=${JSON.stringify(clrBody.hw_lead_substatus)}`,
            clrBody.hw_lead_substatus === '',
          );

          // Re-render the header so the pill reflects the optimistic state.
          await detailTab.evaluate(() => {
            if (typeof renderWorkflowHeader === 'function') renderWorkflowHeader();
          });
          // Poll until the pill transitions to the lsb-empty (no status) state.
          await waitFor(detailTab, () =>
            !!document.querySelector('#workflow-header .lead-status-badge.lsb-empty'), {}, 5000);

          const emptyPill = await detailTab.evaluate(() => {
            const pill = document.querySelector('#workflow-header .lead-status-badge');
            if (!pill) return { present: false };
            return {
              present:  true,
              isEmpty:  pill.classList.contains('lsb-empty'),
              text:     pill.textContent.trim(),
              hasParent: !!pill.querySelector('.ls-pill-parent'),
            };
          });
          const nullLabel = await detailTab.evaluate(() =>
            (typeof NULL_LEAD_STATUS_LABEL !== 'undefined' && NULL_LEAD_STATUS_LABEL) || 'No status');
          record(
            'pill reverts to the "No status" empty state after Clear status',
            `pill has class lsb-empty, text="${nullLabel}", no .ls-pill-parent span`,
            `present=${emptyPill.present} isEmpty=${emptyPill.isEmpty} text="${emptyPill.text}" hasParent=${emptyPill.hasParent}`,
            emptyPill.present && emptyPill.isEmpty && emptyPill.text === nullLabel && !emptyPill.hasParent,
          );
        }
      }
    }

    // Tear down request interception before closing the tab.
    detailTab.off('request', _reqHandler);
    await detailTab.setRequestInterception(false).catch(() => {});

    // ── (H) BC: pill primary text updates when contact has substatus set ──────
    // Distinct from [A2] (which seeds an empty hw_lead_substatus) and [F]
    // (which checks the full pill textContent after a picker interaction).
    // This probe explicitly seeds the contact WITH hw_lead_substatus pointing at
    // SUB_A_KEY from the start, verifies the pill's primary text shows the
    // current sub-status label, renames via PATCH, fans out via
    // BroadcastChannel, and asserts the pill primary text updates in place.
    //
    // The customer-detail header is a React component (CustomerDetailHeader.tsx)
    // that reads contact.properties.hw_lead_substatus and renders the sub-status
    // label as the pill's primary text (with the parent status label in
    // .ls-pill-parent). It listens to lead_substatuses_changed BC and calls
    // fetchLeadSubstatuses() to pick up renamed labels. We re-enable request
    // interception so the fetchContact() call (triggered by renderWorkflowHeader)
    // returns a mocked contact that already has hw_lead_substatus set.
    console.log('\n  [H] BC: pill primary text updates when contact has sub-status set');

    const CHIP_BC_LABEL   = 'PrivTest DT Chip BC Label';
    const CHIP_BC_RENAMED = 'PrivTest DT Chip BC Renamed';
    const hwSubVal        = `${KEY_A}__${SUB_A_KEY}`;

    // Set the sub-status label to a known value before seeding.
    const patchChipBcInit = await adminClient.patch(
      `/api/admin/lead-substatuses/${SUB_A_ID}`,
      { label: CHIP_BC_LABEL },
    );
    record(
      'PATCH /api/admin/lead-substatuses/:id sets initial label for chip BC probe',
      `status=200 label="${CHIP_BC_LABEL}"`,
      `status=${patchChipBcInit.status} label="${patchChipBcInit.json?.label}"`,
      patchChipBcInit.status === 200 && patchChipBcInit.json?.label === CHIP_BC_LABEL,
    );

    // Re-enable request interception so the React component's fetchContact()
    // returns a mocked contact that has hw_lead_substatus already set.
    await detailTab.setRequestInterception(true);
    const _chipReqHandler = req => {
      const url    = req.url();
      const method = req.method();
      if (method === 'GET' && url.includes(`/api/contacts/${CONTACT_ID}`) &&
          !url.includes('/localdata') && !url.includes('/notes') &&
          !url.includes('/tasks')) {
        req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: CONTACT_ID,
            properties: {
              hs_lead_status: KEY_A, hw_lead_substatus: hwSubVal,
              firstname: 'Priv', lastname: 'Test', email: 'privtest@privtest.local',
            },
          }),
        });
      } else {
        req.continue();
      }
    };
    detailTab.on('request', _chipReqHandler);

    // Also seed the vanilla-JS state and ensure workflow-header is in the DOM.
    await bootstrapTracker(detailTab, KEY_A, hwSubVal);
    await detailTab.evaluate(() => {
      const wv = document.getElementById('workflow-view');
      if (wv && !document.getElementById('workflow-header')) {
        const hdr = document.createElement('div');
        hdr.id = 'workflow-header';
        wv.insertBefore(hdr, wv.firstChild);
      }
      // Trigger the React component's fetchContact() via the registered
      // renderWorkflowHeader dispatcher.
      if (typeof renderWorkflowHeader === 'function') renderWorkflowHeader();
    });
    // Poll until React has fetched the contact and rendered the pill with the
    // expected initial sub-status label (avoids an arbitrary fixed delay for
    // the async fetchContact() → re-render cycle).
    await waitFor(detailTab, (args) => {
      const pill = document.querySelector('#workflow-header .lead-status-badge');
      if (!pill) return false;
      const parentSpan = pill.querySelector('.ls-pill-parent');
      let primary = pill.textContent.trim();
      if (parentSpan) primary = primary.slice(0, primary.length - parentSpan.textContent.length).trim();
      return primary === args.label;
    }, { label: CHIP_BC_LABEL }, 10000);

    // Capture the render token to verify no full-page reload occurs.
    const chipToken = await detailTab.evaluate(() => window.__renderToken);

    const chipBeforeBc = await detailTab.evaluate(() => {
      const pill = document.querySelector('#workflow-header .lead-status-badge');
      if (!pill) return null;
      const parentSpan = pill.querySelector('.ls-pill-parent');
      let primary = pill.textContent.trim();
      if (parentSpan) {
        primary = primary.slice(0, primary.length - parentSpan.textContent.length).trim();
      }
      return primary;
    });
    record(
      'pill primary text shows current sub-status label when hw_lead_substatus is set',
      `primary="${CHIP_BC_LABEL}"`,
      `primary="${chipBeforeBc}"`,
      chipBeforeBc === CHIP_BC_LABEL,
    );

    // Rename the sub-status and broadcast from a second tab.
    const patchChipBcRename = await adminClient.patch(
      `/api/admin/lead-substatuses/${SUB_A_ID}`,
      { label: CHIP_BC_RENAMED },
    );
    record(
      'PATCH renames sub-status for chip BC rename probe',
      `status=200 label="${CHIP_BC_RENAMED}"`,
      `status=${patchChipBcRename.status} label="${patchChipBcRename.json?.label}"`,
      patchChipBcRename.status === 200 && patchChipBcRename.json?.label === CHIP_BC_RENAMED,
    );

    const senderTab3 = await browser.newPage();
    await senderTab3.setCacheEnabled(false);
    await injectSession(senderTab3, adminClient.cookie);
    await senderTab3.goto(`${BASE}/customers`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Poll until the customers page has bootstrapped enough to use BroadcastChannel.
    await waitFor(senderTab3, () => typeof state !== 'undefined', {}, 8000);

    await senderTab3.evaluate(() => {
      new BroadcastChannel('lead_substatuses_changed').postMessage('changed');
    });

    // The React component's BC handler calls fetchLeadSubstatuses() which
    // fetches /api/lead-substatuses (passed through). React re-renders with
    // the new label and updates the pill primary text.
    const chipBcUpdated = await waitFor(detailTab, (args) => {
      const pill = document.querySelector('#workflow-header .lead-status-badge');
      if (!pill) return false;
      const parentSpan = pill.querySelector('.ls-pill-parent');
      let primary = pill.textContent.trim();
      if (parentSpan) {
        primary = primary.slice(0, primary.length - parentSpan.textContent.length).trim();
      }
      return primary === args.label;
    }, { label: CHIP_BC_RENAMED }, 8000);

    const chipBcSnap = await detailTab.evaluate((tok) => {
      const pill = document.querySelector('#workflow-header .lead-status-badge');
      const parentSpan = pill && pill.querySelector('.ls-pill-parent');
      let primary = pill ? pill.textContent.trim() : null;
      if (primary !== null && parentSpan) {
        primary = primary.slice(0, primary.length - parentSpan.textContent.length).trim();
      }
      return {
        primary,
        hasParent:      !!(pill && pill.querySelector('.ls-pill-parent')),
        renderToken:    window.__renderToken,
        tokenPreserved: window.__renderToken === tok,
      };
    }, chipToken);
    record(
      'BC lead_substatuses_changed updates pill primary text to renamed sub-status (no reload)',
      `primary="${CHIP_BC_RENAMED}" within 8 s, render token preserved`,
      `found=${chipBcUpdated} primary="${chipBcSnap.primary}" hasParent=${chipBcSnap.hasParent} tokenPreserved=${chipBcSnap.tokenPreserved}`,
      chipBcUpdated && chipBcSnap.tokenPreserved,
    );

    await senderTab3.close();

    // ── (I) visibilitychange: pill primary text updates when substatus set ────
    console.log('\n  [I] visibilitychange: pill primary text shows renamed sub-status label');

    const CHIP_VIS_RENAMED = 'PrivTest DT Chip Vis Renamed';
    const patchChipVis = await adminClient.patch(
      `/api/admin/lead-substatuses/${SUB_A_ID}`,
      { label: CHIP_VIS_RENAMED },
    );
    record(
      'PATCH renames sub-status for chip visibilitychange probe',
      `status=200 label="${CHIP_VIS_RENAMED}"`,
      `status=${patchChipVis.status} label="${patchChipVis.json?.label}"`,
      patchChipVis.status === 200 && patchChipVis.json?.label === CHIP_VIS_RENAMED,
    );

    // Synthesise hidden → visible visibilitychange sequence.
    // The React component's visibilitychange handler calls fetchLeadSubstatuses()
    // which fetches /api/lead-substatuses (passed through) with the new label.
    await detailTab.evaluate(() => {
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

    const chipVisUpdated = await waitFor(detailTab, (args) => {
      const pill = document.querySelector('#workflow-header .lead-status-badge');
      if (!pill) return false;
      const parentSpan = pill.querySelector('.ls-pill-parent');
      let primary = pill.textContent.trim();
      if (parentSpan) {
        primary = primary.slice(0, primary.length - parentSpan.textContent.length).trim();
      }
      return primary === args.label;
    }, { label: CHIP_VIS_RENAMED }, 8000);

    const chipVisSnap = await detailTab.evaluate((tok) => {
      const pill = document.querySelector('#workflow-header .lead-status-badge');
      const parentSpan = pill && pill.querySelector('.ls-pill-parent');
      let primary = pill ? pill.textContent.trim() : null;
      if (primary !== null && parentSpan) {
        primary = primary.slice(0, primary.length - parentSpan.textContent.length).trim();
      }
      return {
        primary,
        hasParent:      !!(pill && pill.querySelector('.ls-pill-parent')),
        renderToken:    window.__renderToken,
        tokenPreserved: window.__renderToken === tok,
      };
    }, chipToken);
    record(
      'visibilitychange updates pill primary text to renamed sub-status (no reload)',
      `primary="${CHIP_VIS_RENAMED}" within 8 s, render token preserved`,
      `found=${chipVisUpdated} primary="${chipVisSnap.primary}" hasParent=${chipVisSnap.hasParent} tokenPreserved=${chipVisSnap.tokenPreserved}`,
      chipVisUpdated && chipVisSnap.tokenPreserved,
    );

    // Tear down chip-probe request interception.
    detailTab.off('request', _chipReqHandler);
    await detailTab.setRequestInterception(false).catch(() => {});

    await detailTab.close();

    // ── (G) Viewer role: pill is read-only and does NOT open the picker ──────
    // Regression guard for the `canEditPipeline()` gate in
    // _renderWorkflowHeaderImpl (public/customer-detail.js lines 808–832).
    // If that guard ever regresses, viewer-role users would see a clickable
    // pill that opens the unified picker and can submit status changes.
    console.log('\n  [G] Viewer role: lead-status pill is read-only (no picker)');

    const viewerClient = await login(users.viewer.email, PASSWORD);

    // Use a fresh browser context so the viewer session cookie does not
    // clobber the admin session in the default context above.
    const viewerCtx = await (browser.createBrowserContext
      ? browser.createBrowserContext()
      : browser.createIncognitoBrowserContext());
    const viewerTab = await viewerCtx.newPage();
    await viewerTab.setCacheEnabled(false);

    // Inject the viewer session cookie into this context only.
    {
      const kv = parseCookieKV(viewerClient.cookie);
      if (kv) {
        const { hostname } = new URL(BASE);
        await viewerTab.setCookie({
          name: kv.name, value: kv.value,
          domain: hostname, path: '/', httpOnly: true,
        });
      }
    }

    await viewerTab.goto(`${BASE}/customers/${CONTACT_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    // Poll until the page bootstrap functions are defined (DOMContentLoaded +
    // initial /api/contacts/:id call settled under the stripped HUBSPOT_TOKEN).
    await waitFor(viewerTab, () =>
      typeof state !== 'undefined' &&
      typeof renderWorkflowStages === 'function' &&
      typeof loadLeadStatuses === 'function',
    {}, 10000);

    // Re-establish the workflow-header mount + contact state and render the
    // pill (mirrors what the real page does after selectContact() succeeds).
    // The page bootstrap can't render its own header because /api/contacts/:id
    // 503s under the stripped HUBSPOT_TOKEN, so we inject a #workflow-header
    // mount and seed the contact state directly.
    await bootstrapTracker(viewerTab, KEY_A, '', 'viewer');
    await viewerTab.evaluate(() => {
      const wv = document.getElementById('workflow-view');
      if (wv && !document.getElementById('workflow-header')) {
        const hdr = document.createElement('div');
        hdr.id = 'workflow-header';
        wv.insertBefore(hdr, wv.firstChild);
      }
      if (typeof renderWorkflowHeader === 'function') renderWorkflowHeader();
    });
    // Poll until the pill is present in the viewer's header.
    await waitFor(viewerTab, () =>
      !!document.querySelector('#workflow-header .lead-status-badge'), {}, 5000);

    const viewerPill = await viewerTab.evaluate(() => {
      const pill = document.querySelector('#workflow-header .lead-status-badge');
      return {
        present:    !!pill,
        clickable:  !!pill && pill.classList.contains('lsb-clickable'),
        hasOnclick: !!pill && !!pill.getAttribute('onclick'),
      };
    });
    record(
      'viewer sees a lead-status pill (read-only)',
      'pill present in #workflow-header',
      `present=${viewerPill.present}`,
      viewerPill.present,
    );
    record(
      'viewer pill does NOT have class lsb-clickable',
      'classList lacks "lsb-clickable"',
      `clickable=${viewerPill.clickable}`,
      !viewerPill.clickable,
    );
    record(
      'viewer pill has no onclick handler that would open the picker',
      'getAttribute("onclick") returns null/empty',
      `hasOnclick=${viewerPill.hasOnclick}`,
      !viewerPill.hasOnclick,
    );

    // Belt-and-braces: click the pill anyway and confirm no picker popup.
    if (viewerPill.present) {
      await viewerTab.click('#workflow-header .lead-status-badge').catch(() => {});
      // Intentional fixed wait: this is a negative assertion (picker must NOT
      // open). A poll-loop would return immediately when nothing appears, so a
      // brief fixed window is required to give the picker a realistic chance to
      // appear before we assert its absence.
      await new Promise(r => setTimeout(r, 500));
      const pickerOpenedForViewer = await viewerTab.evaluate(() =>
        !!document.getElementById('card-picker-popup'));
      record(
        'clicking the viewer pill does NOT open the unified picker popup',
        '#card-picker-popup is absent from DOM',
        `pickerOpened=${pickerOpenedForViewer}`,
        !pickerOpenedForViewer,
      );
    }

    await viewerTab.close();
    await viewerCtx.close().catch(() => {});

  } finally {
    await browser.close().catch(() => {});
  }

  // ── summary & report ──────────────────────────────────────────────────────
  const pass    = findings.filter(f => f.ok).length;
  const skipped = findings.filter(f => f.skipped).length;
  const fail    = findings.filter(f => !f.ok && !f.skipped).length;
  console.log(`\n  Results: ${pass} passed, ${skipped} skipped, ${fail} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

// ── report writer ─────────────────────────────────────────────────────────────
async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Lead-Status Tracker (customer-detail) Sync — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:lead-status-sync-customer-detail\``,
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
    '- **(C) Unified picker — sub-status rows indented**: re-bootstraps the contact',
    '  state with `KEY_A` active and no sub-status, enables Puppeteer request',
    '  interception to mock `GET /api/contacts/:id` and `PATCH /api/contacts/:id`,',
    '  clicks the `.lead-status-badge.lsb-clickable` pill in `#workflow-header`,',
    '  and asserts that `.card-picker-opt--sub` rows are present in the popup and',
    '  appear after the parent `.card-picker-opt[data-lead-status]` row.',
    '  Exercises `openLeadStatusPicker` in `workflow.js` with `showSubstatuses:true`.',
    '- **(D) Sub-status click fires exactly one PATCH with both fields**: captures the',
    '  first `.card-picker-opt--sub` row text, clicks it, and asserts',
    '  `patchedBodies.length === 1` (exactly one PATCH — duplicate-PATCH regressions',
    '  are caught). The intercepted body must contain `hs_lead_status` equal to the',
    '  parent status key and `hw_lead_substatus` starting with `STATUS__`. Exercises',
    '  `_quickSetLeadStatusWithSub` in `workflow.js`.',
    '- **(E) Pill primary text matches the clicked sub-status label**: after clicking,',
    '  calls `renderWorkflowHeader()` and asserts the pill (a) contains a',
    '  `.ls-pill-parent` span and (b) its primary text (pill text minus the parent',
    '  span text) equals the sub-status label captured in probe D. This catches',
    '  regressions where the pill shows the parent label instead of the sub-status',
    '  label. Exercises `_renderWorkflowHeaderImpl` lines 820–823 of',
    '  `customer-detail.js`.',
    '- **(G) Viewer role — read-only pill**: logs in as the seeded viewer-role user',
    '  in an isolated browser context, navigates to `/customers/:id`, re-renders the',
    '  workflow header, and asserts that the `.lead-status-badge` pill does NOT have class',
    '  `lsb-clickable` and has no `onclick` handler. Clicks the pill anyway and',
    '  confirms `#card-picker-popup` never appears. Regression guard for the',
    '  `canEditPipeline()` gate in `_renderWorkflowHeaderImpl`',
    '  (`public/customer-detail.js` lines 808–832).',
    '- **(F) BC + visibilitychange: pill reflects renamed sub-status**: renames the',
    '  selected sub-status via `PATCH /api/admin/lead-substatuses/:id` and fires',
    '  a `lead_substatuses_changed` BroadcastChannel message from a second tab;',
    '  asserts the pill text updates in place to the new label. Then renames again',
    '  and synthesises a hidden→visible `visibilitychange` sequence; asserts the',
    '  pill picks up the second rename without a full page reload.',
    '- **(G) Unified picker "Clear status" clears both fields**: re-opens the picker',
    '  while the contact still has `hs_lead_status=KEY_A` and an active sub-status,',
    '  clicks the `.card-picker-opt--clear` button (calls',
    '  `quickSetLeadStatus(contactId, "")` in `workflow.js`), and asserts the',
    '  intercepted PATCH body sets both `hs_lead_status` and `hw_lead_substatus`',
    '  to `""` (regression guard: the bare clear-status call previously left a',
    '  stale `hw_lead_substatus` value attached to the contact). Then calls',
    '  `renderWorkflowHeader()` and asserts the pill reverts to the `lsb-empty`',
    '  "No status" empty state with no `.ls-pill-parent` span.',
    '- **(H) BC — pill primary text rename (substatus pre-set)**: seeds the contact',
    '  with `hw_lead_substatus` set to `KEY_A__STEP_ONE` (the contact already has',
    '  a sub-status chosen). Re-enables request interception so the React',
    '  `CustomerDetailHeader` component\'s `fetchContact()` call returns the mocked',
    '  contact with `hw_lead_substatus` set. Renames the sub-status via',
    '  `PATCH /api/admin/lead-substatuses/:id`, posts `lead_substatuses_changed`',
    '  from a second tab, and asserts the pill\'s primary text (the sub-status',
    '  label — checked via `#workflow-header .lead-status-badge` minus',
    '  `.ls-pill-parent` text) updates in place to the new label within 8 s',
    '  (render token preserved — no full reload). Distinct from probe A2 (empty',
    '  `hw_lead_substatus`, row-text check) and probe F (full pill `textContent`',
    '  after picker interaction).',
    '- **(I) visibilitychange — pill primary text rename (substatus pre-set)**:',
    '  renames the sub-status again and synthesises a hidden→visible',
    '  `visibilitychange` event sequence; asserts the pill primary text picks up',
    '  the new label without a full page reload (render token preserved). Guards',
    '  the visibilitychange handler in `CustomerDetailPage.tsx` that calls',
    '  `fetchLeadSubstatuses` on tab focus.',
    '',
    'Every BC/visibilitychange assertion (probes H–I) also checks `window.__renderToken` is',
    'preserved across the re-render, proving the tracker updated in place (no full',
    'page reload).',
    '',
    '## Notes',
    '',
    '- The test server strips `HUBSPOT_TOKEN`, so `GET /api/contacts/:id` 503s and',
    '  the customer-detail page replaces `#workflow-view` with an error. The',
    '  `bootstrapTracker` helper loads lead statuses + sub-statuses (which come from',
    '  PostgreSQL, not HubSpot), seeds `state.selectedContact`, and calls',
    '  `renderWorkflowStages()` — the same entry point the BC/visibilitychange',
    '  handlers in `workflow-core.js` use to update the header pill.',
    '- For probes C–F, Puppeteer request interception mocks `GET` and `PATCH` on',
    '  `/api/contacts/:id` so `openLeadStatusPicker` and `_quickSetLeadStatusWithSub`',
    '  complete successfully without HubSpot. All other requests are passed through.',
  ];
  const outPath = path.join(dir, 'lead-status-sync-customer-detail.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/lead-status-sync-customer-detail.md`);
}

main();
