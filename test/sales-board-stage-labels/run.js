'use strict';
// test/sales-board-stage-labels/run.js
//
// End-to-end test: Sales board column headers update when a
// `lead_statuses_changed` BroadcastChannel message is received, without a
// page reload.
//
// The SalesBoardPage React component (src/react/pages/SalesBoardPage.tsx)
// opens a BroadcastChannel('lead_statuses_changed') and calls forceUpdate()
// on every message. The re-render re-reads window.state?.workflow so any
// change to state.workflow.stages[key].label is immediately visible.
//
// BOOTSTRAP WORKAROUND
// --------------------
// The test server strips HUBSPOT_TOKEN, so bootstrap() on /sales fails when
// loadOpenLeads() and loadWorkflowStages() both 503. The bootstrap error
// handler replaces #sales-view innerHTML with an error message, which
// destroys the #sales-board-mount React island. The test compensates by:
//   1. Waiting for bootstrap to finish (and fail).
//   2. Re-injecting a fresh #sales-board-mount div into #sales-view.
//   3. Calling window.__reactIslandMount() to remount the React component
//      (the SalesBoardPage lazy chunk is already cached from the first
//      attempt, so the remount is fast).
//   4. Seeding window.state.workflow with known stage labels and dispatching
//      the `sales-board-data-ready` event.
//
// This is identical in spirit to how test/lead-status-sync/customer-detail.js
// re-injects #workflow-stages after the HubSpot 503 clears #workflow-view.
//
// This test exercises two update paths:
//   (A) BroadcastChannel  — another tab posts lead_statuses_changed → re-render
//   (B) visibilitychange  — tab gains focus → re-render
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:sales-board-stage-labels
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:sales-board-stage-labels

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
const LABEL_SALES_ORIG = 'PrivTest Sales Stage';
const LABEL_SALES_BC   = 'PrivTest Sales BC Renamed';
const LABEL_SALES_VIS  = 'PrivTest Sales Vis Renamed';
const LABEL_DV_ORIG    = 'PrivTest DV Stage';
const LABEL_DV_BC      = 'PrivTest DV BC Renamed';

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

// Wait for bootstrap() to complete on the /sales page.
// In the test server (no HubSpot token) bootstrap throws and replaces
// #sales-view with an error message. We wait until #sales-view no longer
// contains #sales-board-mount — that signals the error handler has run.
// Fall back after timeoutMs regardless so the test can still proceed.
async function waitForBootstrapFail(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = await page.evaluate(() => {
      const sv = document.getElementById('sales-view');
      if (!sv) return true; // page may have navigated away
      // Error handler replaced innerHTML → mount point is gone
      return !document.getElementById('sales-board-mount');
    });
    if (done) return;
    await new Promise(r => setTimeout(r, 200));
  }
}

// Re-inject a fresh #sales-board-mount into #sales-view, call
// window.__reactIslandMount() to remount the SalesBoardPage lazy component,
// seed window.state.workflow with the supplied labels, then dispatch the
// `sales-board-data-ready` event so the component re-renders immediately.
//
// Also stamps window.__noReloadProof so later assertions can confirm that
// no page reload occurred (a reload would clear the value).
async function bootstrapBoard(page, salesLabel, dvLabel) {
  return page.evaluate(async (sl, dvl) => {
    // Re-inject the mount point that bootstrap destroyed.
    let sv = document.getElementById('sales-view');
    if (!sv) {
      // Fallback: re-create the whole panel.
      const tabCustomers = document.getElementById('tab-customers');
      if (tabCustomers) {
        sv = tabCustomers.querySelector('aside') || tabCustomers;
      }
    }
    if (sv) {
      sv.innerHTML = '<div id="sales-board-mount" style="flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden"></div>';
    }

    // Remount the React island on the new element.
    if (typeof window.__reactIslandMount === 'function') {
      window.__reactIslandMount();
    }

    // Seed the workflow with controlled stage labels.
    if (!window.state) window.state = {};
    window.state.workflow = {
      stages: {
        sales:       { label: sl,  statuses: [] },
        designvisit: { label: dvl, statuses: [] },
        survey:      { label: 'Survey', statuses: [] },
      },
    };

    // Stamp no-reload proof before any BC messages are sent.
    if (!window.__noReloadProof) {
      window.__noReloadProof = 'proof_' + Math.random().toString(36).slice(2);
    }

    // Notify the React component to re-read state and re-render.
    document.dispatchEvent(new CustomEvent('sales-board-data-ready'));

    return window.__noReloadProof;
  }, salesLabel, dvLabel);
}

// Update the sales stage label in the already-seeded workflow, leave the
// rest intact.
async function updateSalesLabel(page, newLabel) {
  await page.evaluate((sl) => {
    if (window.state && window.state.workflow && window.state.workflow.stages) {
      window.state.workflow.stages.sales.label = sl;
    }
  }, newLabel);
}

// Poll until the Sales board column area contains text exactly matching
// `label`, or until `timeoutMs` elapses.  Text search is immune to MUI
// class-name changes across versions.
async function waitForColumnText(page, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate((lbl) => {
      const mount = document.getElementById('sales-board-mount');
      if (!mount) return false;
      // Walk all text-leaf nodes and look for an exact match.
      const walker = document.createTreeWalker(mount, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if ((node.textContent || '').trim() === lbl) return true;
      }
      return false;
    }, label);
    if (found) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

// Return all text leaves in #sales-board-mount that look like stage labels
// (short strings, not empty, not purely numeric).
async function getColumnTexts(page) {
  return page.evaluate(() => {
    const mount = document.getElementById('sales-board-mount');
    if (!mount) return [];
    const results = [];
    const walker = document.createTreeWalker(mount, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.textContent || '').trim();
      if (t && t.length > 1 && t.length < 60 && !/^\d+$/.test(t)) {
        results.push(t);
      }
    }
    return [...new Set(results)];
  });
}

async function getReloadProof(page) {
  return page.evaluate(() => window.__noReloadProof || null);
}

// Wait for #sales-board-mount to contain at least one text node with `label`.
// If `keepRetrying` is true, keep re-dispatching sales-board-data-ready every
// 500 ms in case the React component hasn't registered its listener yet.
async function waitForBoardWithRetry(page, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Re-fire the event periodically in case the lazy chunk hasn't loaded yet.
    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('sales-board-data-ready'));
    });
    const found = await waitForColumnText(page, label, 600);
    if (found) return true;
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

  // Check that the React bundle has been built.
  const bundlePath = path.resolve(__dirname, '..', '..', 'public', 'react', 'main.js');
  if (!fs.existsSync(bundlePath)) {
    console.error(
      '\n  ✘ public/react/main.js is missing.\n'
      + '    Run `npm run build:react` before this test.\n',
    );
    process.exit(2);
  }

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  sales-board-stage-labels E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}`);

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
    try { await cleanupTestData(pool); } catch {}
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

  const adminClient = await login(users.admin.email, PASSWORD);

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
    // salesTab  — has the Sales board with the BroadcastChannel listener
    // senderTab — simulates another tab broadcasting lead_statuses_changed
    //
    // BroadcastChannel does NOT deliver to the same port that sent the message,
    // so the post from senderTab arrives at salesTab's BC listener.
    console.log('\n  [A] BroadcastChannel path');

    const salesTab = await browser.newPage();
    await salesTab.setCacheEnabled(false);
    await injectSession(salesTab, adminClient.cookie);

    // Capture page errors to aid debugging.
    const pageErrors = [];
    salesTab.on('pageerror', e => pageErrors.push(String(e)));

    const senderTab = await browser.newPage();
    await senderTab.setCacheEnabled(false);
    await injectSession(senderTab, adminClient.cookie);

    // Navigate to /sales and wait for bootstrap() to finish (and fail due
    // to missing HUBSPOT_TOKEN). After it fails, #sales-view is replaced
    // with an error message, destroying #sales-board-mount.
    await salesTab.goto(`${BASE}/sales`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });
    await waitForBootstrapFail(salesTab, 8000);

    // Re-inject the mount point and remount the React component.
    const initialToken = await bootstrapBoard(salesTab, LABEL_SALES_ORIG, LABEL_DV_ORIG);

    // waitForBoardWithRetry keeps re-dispatching `sales-board-data-ready`
    // every ~600 ms until the React component registers its listener (lazy
    // chunk download) and re-renders with the custom label, or until 15 s.
    const initVisible = await waitForBoardWithRetry(salesTab, LABEL_SALES_ORIG, 15000);
    const initTexts   = await getColumnTexts(salesTab);
    record(
      'custom sales stage label appears in column header after board bootstrap',
      `text "${LABEL_SALES_ORIG}" visible in #sales-board-mount within 15 s`,
      `found=${initVisible} texts: ${JSON.stringify(initTexts.slice(0, 8))}`,
      initVisible,
      pageErrors.length ? `pageErrors: ${pageErrors.slice(0, 3).join('; ')}` : '',
    );

    if (!initVisible) {
      // Cannot exercise BC path without the board rendering.
      await writeReport(runId, findings);
      await browser.close().catch(() => {});
      await cleanupAndExit(1);
      return;
    }

    // Update the workflow label in the sales tab (simulates a background data
    // refresh that would occur after the admin renames a workflow stage).
    await updateSalesLabel(salesTab, LABEL_SALES_BC);

    // Open the sender tab on a page that loads the app scripts so the
    // BroadcastChannel API is available, then post the channel message.
    // BroadcastChannel does NOT deliver messages to the same context that
    // sent them, so this reliably reaches salesTab's listener.
    await senderTab.goto(`${BASE}/sales`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await new Promise(r => setTimeout(r, 400));
    await senderTab.evaluate(() => {
      new BroadcastChannel('lead_statuses_changed').postMessage('changed');
    });

    // The BroadcastChannel listener in SalesBoardPage calls forceUpdate()
    // which increments `tick`, causing a re-render that re-reads
    // window.state.workflow.stages.sales.label.
    const bcUpdated = await waitForColumnText(salesTab, LABEL_SALES_BC, 8000);
    const textsAfterBc = await getColumnTexts(salesTab);
    record(
      'BroadcastChannel lead_statuses_changed updates Sales column header (no reload)',
      `text "${LABEL_SALES_BC}" visible within 8 s`,
      `found=${bcUpdated} texts: ${JSON.stringify(textsAfterBc.slice(0, 8))}`,
      bcUpdated,
    );

    const staleGone = !textsAfterBc.includes(LABEL_SALES_ORIG);
    record(
      'original Sales label is absent from column header after BroadcastChannel rename',
      `"${LABEL_SALES_ORIG}" not in board texts`,
      `stalePresent=${!staleGone} texts: ${JSON.stringify(textsAfterBc.slice(0, 8))}`,
      staleGone,
    );

    const dvBcUpdated = textsAfterBc.includes(LABEL_DV_ORIG);
    record(
      'Design Visit column header is still present after BroadcastChannel update',
      `text "${LABEL_DV_ORIG}" still in board`,
      `found=${dvBcUpdated} texts: ${JSON.stringify(textsAfterBc.slice(0, 8))}`,
      dvBcUpdated,
    );

    // Confirm no page reload occurred (window.__noReloadProof persists).
    const tokenAfterBc = await getReloadProof(salesTab);
    record(
      'page was not reloaded — __noReloadProof survives BroadcastChannel update',
      `token="${initialToken}"`,
      `token="${tokenAfterBc}"`,
      tokenAfterBc === initialToken,
    );

    await salesTab.close();
    await senderTab.close();

    // ── (B) visibilitychange path ─────────────────────────────────────────────
    // Fresh tab; re-inject board, seed labels, verify initial state, then
    // rename the label in-page and synthesise hidden→visible. The component's
    // visibilitychange handler calls forceUpdate() → re-reads workflow.
    console.log('\n  [B] visibilitychange path');

    const visTab = await browser.newPage();
    await visTab.setCacheEnabled(false);
    await injectSession(visTab, adminClient.cookie);
    await visTab.goto(`${BASE}/sales`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });
    await waitForBootstrapFail(visTab, 8000);

    const visToken = await bootstrapBoard(visTab, LABEL_SALES_BC, LABEL_DV_ORIG);
    const preVisVisible = await waitForBoardWithRetry(visTab, LABEL_SALES_BC, 15000);
    record(
      'BC-renamed label visible in visibilitychange tab after board bootstrap',
      `text "${LABEL_SALES_BC}" visible`,
      `found=${preVisVisible}`,
      preVisVisible,
    );

    if (preVisVisible) {
      // Update the workflow label without firing an event (the component
      // should only pick it up on the next visibilitychange→visible transition).
      await updateSalesLabel(visTab, LABEL_SALES_VIS);

      // Synthesise hidden → visible.
      // The SalesBoardPage handler only runs when visibilityState === 'visible'.
      await visTab.evaluate(() => {
        const proto   = Document.prototype;
        const ownDesc = Object.getOwnPropertyDescriptor(proto, 'visibilityState')
                     || Object.getOwnPropertyDescriptor(document, 'visibilityState');

        // Step 1: hidden (handler skips).
        Object.defineProperty(document, 'visibilityState',
          { get: () => 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        // Step 2: visible (handler fires → forceUpdate → re-reads workflow).
        if (ownDesc) {
          Object.defineProperty(document, 'visibilityState', ownDesc);
        } else {
          Object.defineProperty(document, 'visibilityState',
            { get: () => 'visible', configurable: true });
        }
        document.dispatchEvent(new Event('visibilitychange'));
      });

      const visUpdated = await waitForColumnText(visTab, LABEL_SALES_VIS, 8000);
      const textsAfterVis = await getColumnTexts(visTab);
      record(
        'visibilitychange updates Sales column header to renamed label (no reload)',
        `text "${LABEL_SALES_VIS}" visible within 8 s`,
        `found=${visUpdated} texts: ${JSON.stringify(textsAfterVis.slice(0, 8))}`,
        visUpdated,
      );

      const staleAfterVis = textsAfterVis.includes(LABEL_SALES_BC);
      record(
        'BC-renamed label absent after visibilitychange refresh',
        `"${LABEL_SALES_BC}" not in board texts`,
        `stalePresent=${staleAfterVis}`,
        !staleAfterVis,
      );

      const visTokenAfter = await getReloadProof(visTab);
      record(
        'page was not reloaded — __noReloadProof survives visibilitychange update',
        `token="${visToken}"`,
        `token="${visTokenAfter}"`,
        visTokenAfter === visToken,
      );
    }

    await visTab.close();

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
    '# Sales Board Stage Labels Sync — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:sales-board-stage-labels\``,
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
    '- **Setup**: navigates to `/sales`, waits for bootstrap to fail (no',
    '  HubSpot token), re-injects `#sales-board-mount`, calls',
    '  `window.__reactIslandMount()` to remount `SalesBoardPage`, then seeds',
    '  `window.state.workflow` with known stage labels and dispatches',
    '  `sales-board-data-ready`.',
    '- **(A) BroadcastChannel path**: updates `state.workflow.stages.sales.label`',
    '  in the sales tab, posts `lead_statuses_changed` from a second same-browser',
    '  tab, and asserts the column header reflects the updated label within 8 s.',
    '  Exercises the `new BroadcastChannel("lead_statuses_changed")` listener in',
    '  `SalesBoardPage` that calls `forceUpdate()`. Also verifies the stale label',
    '  is gone and `window.__noReloadProof` is preserved (no page reload).',
    '- **(B) visibilitychange path**: updates `state.workflow.stages.sales.label`,',
    '  synthesises a hidden→visible visibilitychange event, and asserts the',
    '  column header updates — exercising the `visibilitychange` handler in',
    '  `SalesBoardPage` that also calls `forceUpdate()`.',
  ];
  const report = lines.join('\n') + '\n';
  const outFile = path.join(dir, 'sales-board-stage-labels.md');
  fs.writeFileSync(outFile, report, 'utf8');
  console.log(`\n  Report written → ${outFile}`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(2);
});
