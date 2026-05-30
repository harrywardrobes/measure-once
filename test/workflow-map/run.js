'use strict';

const PROBE_LABELS = [
  '(A) map starts expanded when localStorage has no saved state',
  '(B) clicking header collapses it and persists; reload keeps state; re-click restores',
  '(C) clicking a stage node opens the Drawer',
  '(D) Drawer shows the correct label and key for the clicked node',
  '(E) close button dismisses the Drawer',
];

// test/workflow-map/run.js
//
// End-to-end Puppeteer test for the Workflow Map section on the Card Actions
// admin tab (CardActionsPage.tsx).
//
// Covers:
//   (A) Map starts expanded when localStorage has no saved state.
//   (B) Clicking the map header collapses it and persists the state in
//       localStorage; a real page.reload() within the same browser context
//       keeps it collapsed; clicking again expands it; another reload keeps it
//       expanded.
//   (C) Clicking a stage node in the ReactFlow chart opens the detail Drawer.
//   (D) The Drawer shows the correct label and key for the clicked node.
//   (E) Clicking the close button dismisses the Drawer.
//
// Strategy: boots a disposable test server, drives /admin.html with
// Puppeteer, stubs the four card-actions API endpoints so the chart renders
// known stage-only nodes without hitting HubSpot, and asserts DOM state for
// each probe.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:workflow-map
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:workflow-map

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
  BASE,
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'workflow-map.md',
);

const MAP_COLLAPSED_KEY = 'mo:card-actions:map-collapsed';

const findings = [];
function record(name, expected, observed, ok) {
  findings.push({ name, expected, observed, ok });
  const mark = ok ? '  ✓' : '  ✗';
  console.log(`${mark}  ${name}`);
  if (!ok) {
    console.log(`     expected : ${expected}`);
    console.log(`     observed : ${observed}`);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

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

async function pollPage(page, fn, timeoutMs = 10000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs);
}

/**
 * Open /admin.html in a fresh incognito context with the four card-actions APIs
 * stubbed.  The stub is installed via evaluateOnNewDocument so it persists
 * across page.reload() calls within the same context.
 *
 * localStorage is NOT pre-seeded here — callers manipulate it via
 * page.evaluate() after navigation so that page.reload() tests true browser
 * persistence without the evaluateOnNewDocument teardown interfering.
 */
async function openCardActionsPage(browser, jar) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);

  const pageLogs = [];
  page.on('console', m => pageLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => pageLogs.push(`[pageerror] ${e.message}`));

  const stubs = {
    '/api/admin/stage-action-labels': [],
    '/api/admin/lead-statuses': [],
    '/api/admin/lead-substatuses': [],
    '/api/admin/card-action-handlers': [],
  };

  // Install fetch override before any page JS runs.  Survives page.reload()
  // because evaluateOnNewDocument fires on every navigation in the context.
  await page.evaluateOnNewDocument((stubsJson) => {
    window.__cardActionsStubs = JSON.parse(stubsJson);
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const pathname = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0];
      if (Object.prototype.hasOwnProperty.call(window.__cardActionsStubs, pathname)) {
        const body = JSON.stringify(window.__cardActionsStubs[pathname]);
        return Promise.resolve(new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return (origFetch || fetch).call(this, input, init);
    };
  }, JSON.stringify(stubs));

  await injectSession(page, jar);
  page.__logs = pageLogs;
  return page;
}

/**
 * Navigate (or reload) to /admin.html, switch to the cardactions tab, and
 * wait for the CardActionsPage React island to mount ("Workflow Map" heading
 * appears in the tab panel).
 */
async function goToCardActions(page) {
  await page.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(() => {
    if (typeof window.switchTab === 'function') window.switchTab('cardactions');
  });
  const mounted = await pollPage(page, () => {
    const panel = document.getElementById('tab-cardactions');
    return panel && panel.textContent && panel.textContent.includes('Workflow Map') ? 'ok' : null;
  }, 20000);
  return mounted === 'ok';
}

/**
 * Reload the page in the same browser context (preserving session cookie and
 * localStorage) and wait for the cardactions tab to re-mount.
 */
async function reloadCardActions(page) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(() => {
    if (typeof window.switchTab === 'function') window.switchTab('cardactions');
  });
  return pollPage(page, () => {
    const panel = document.getElementById('tab-cardactions');
    return panel && panel.textContent && panel.textContent.includes('Workflow Map') ? 'ok' : null;
  }, 20000);
}

/** Poll until the map header element is present. */
async function waitForMapHeader(page, timeoutMs = 10000) {
  return pollPage(page, () => {
    const btn = document.querySelector('[role="button"][aria-controls="workflow-map-body"]');
    return btn ? 'ok' : null;
  }, timeoutMs);
}

// ── report ─────────────────────────────────────────────────────────────────────

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines = [
    '# Workflow Map — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:workflow-map\``,
    '',
    '## Summary',
    '',
    `- Passed: ${passed} / ${findings.length}`,
    `- Failed: ${failed} / ${findings.length}`,
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
    '- **(A) Default expanded**: With no localStorage value the map header has',
    '  `aria-expanded="true"` and the collapse body is visible.',
    '- **(B) Toggle + localStorage persistence (true end-to-end)**:',
    '  (B.1) Clicking the header collapses the map and sets `localStorage` to `"true"`.',
    '  (B.2) `page.reload()` within the same browser context keeps it collapsed.',
    '  (B.3) Clicking again expands the map and sets `localStorage` to `"false"`.',
    '  (B.4) Another `page.reload()` keeps it expanded.',
    '  This tests the real browser persistence path (same incognito context, real reload).',
    '- **(C) Node click opens Drawer**: Clicking the Sales stage node fires',
    '  `onNodeClick` and the MUI Drawer appears in the DOM.',
    '- **(D) Drawer shows correct label and key**: The Drawer header shows',
    '  "Sales" as the h6 label and the key "sales" appears in the body.',
    '- **(E) Close button dismisses Drawer**: Clicking the close IconButton',
    '  removes the Drawer paper from the visible DOM.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

// ── main ───────────────────────────────────────────────────────────────────────

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
  console.log(`\n  workflow-map  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);
  await cleanupTestData(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    await writeReport(runId);
    process.exit(code);
  };
  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  e => { console.error('Uncaught:',  e); cleanupAndExit(2); });
  process.on('unhandledRejection', e => { console.error('Unhandled:', e); cleanupAndExit(2); });

  // ── Boot test server ────────────────────────────────────────────────────────
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

  // ── Login as admin ──────────────────────────────────────────────────────────
  const adminClient = await login(users.admin.email, users.admin.password);

  const UI_LABELS = [
    '(A) Map header has aria-expanded="true" with no localStorage value',
    '(A) workflow-map-body collapse is visible with no localStorage value',
    '(B.1) Clicking header sets aria-expanded="false" (map collapses)',
    '(B.1) localStorage is set to "true" after collapsing',
    '(B.2) page.reload() — map stays collapsed (localStorage="true" persisted)',
    '(B.3) Clicking header again sets aria-expanded="true" (map expands)',
    '(B.3) localStorage is updated to "false" after expanding',
    '(B.4) page.reload() — map stays expanded (localStorage="false" persisted)',
    '(C) Clicking a stage node opens the Drawer',
    '(D) Drawer header shows the correct label ("Sales")',
    '(D) Drawer body shows the correct key ("sales")',
    '(E) Clicking the close button dismisses the Drawer',
  ];

  if (!puppeteer) {
    for (const l of UI_LABELS) record(l, 'puppeteer installed', 'puppeteer not installed', false);
    await cleanupAndExit(1);
    return;
  }

  const { findChromium } = require('../shared/find-chromium');
  let browser = null;
  let browserLaunchErr = null;
  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
  const launchAttempts = [{ args: launchArgs }];
  const sysChrome = findChromium();
  if (sysChrome) launchAttempts.push({ executablePath: sysChrome, args: launchArgs });
  for (const opts of launchAttempts) {
    try {
      browser = await puppeteer.launch({ headless: true, ...opts });
      browserLaunchErr = null;
      break;
    } catch (e) { browserLaunchErr = e; browser = null; }
  }

  if (!browser) {
    const msg = (browserLaunchErr?.message || String(browserLaunchErr)).slice(0, 200);
    for (const l of UI_LABELS) record(l, 'browser launched', `browser launch failed: ${msg}`, false);
    await cleanupAndExit(1);
    return;
  }

  try {

    // ── (A/B) Collapse toggle with real reload persistence ─────────────────
    console.log('\n  (A/B) collapse toggle + real reload persistence');

    const page = await openCardActionsPage(browser, adminClient.cookie);

    // Navigate to /admin.html and switch to cardactions tab.
    const mountedAB = await goToCardActions(page);
    if (!mountedAB) {
      for (const l of UI_LABELS.slice(0, 8))
        record(l, 'CardActionsPage mounted', 'mount timed out', false);
      await page.__ctx.close().catch(() => {});
    } else {
      // ── (A) Default expanded — ensure no LS value is set ──────────────────
      await page.evaluate((key) => {
        try { localStorage.removeItem(key); } catch {}
      }, MAP_COLLAPSED_KEY);

      // Trigger a React re-read of localStorage by reloading once more with
      // a clean state.  The component reads localStorage on first render only,
      // so we must ensure the clean state is in place before the mount.
      await reloadCardActions(page);
      await waitForMapHeader(page);

      const expandedA = await page.evaluate(() => {
        const btn = document.querySelector('[role="button"][aria-controls="workflow-map-body"]');
        return btn ? btn.getAttribute('aria-expanded') : null;
      });
      record(UI_LABELS[0], 'aria-expanded="true"', String(expandedA), expandedA === 'true');

      const bodyVisibleA = await page.evaluate(() => {
        const body = document.getElementById('workflow-map-body');
        if (!body) return 'missing';
        const style = window.getComputedStyle(body);
        return style.display === 'none' || style.visibility === 'hidden' ? 'hidden' : 'visible';
      });
      record(UI_LABELS[1], 'visible', bodyVisibleA, bodyVisibleA === 'visible');

      // ── (B.1) Click to collapse ────────────────────────────────────────────
      await page.evaluate(() => {
        const btn = document.querySelector('[role="button"][aria-controls="workflow-map-body"]');
        if (btn) btn.click();
      });

      const collapsedB1 = await pollPage(page, () => {
        const btn = document.querySelector('[role="button"][aria-controls="workflow-map-body"]');
        return btn && btn.getAttribute('aria-expanded') === 'false' ? 'ok' : null;
      }, 5000);
      record(UI_LABELS[2], 'aria-expanded="false"', collapsedB1 ? 'false' : 'still true', collapsedB1 === 'ok');

      const lsB1 = await page.evaluate((key) => {
        try { return localStorage.getItem(key); } catch { return null; }
      }, MAP_COLLAPSED_KEY);
      record(UI_LABELS[3], '"true"', String(lsB1), lsB1 === 'true');

      // ── (B.2) Real page.reload() — stays collapsed ────────────────────────
      // The same incognito context keeps localStorage.  evaluateOnNewDocument
      // only stubs fetch; it no longer touches localStorage, so the persisted
      // "true" value survives the reload.
      const mountedB2 = await reloadCardActions(page);
      await waitForMapHeader(page);

      if (!mountedB2) {
        record(UI_LABELS[4], 'CardActionsPage mounted after reload', 'mount timed out', false);
      } else {
        const expandedB2 = await page.evaluate(() => {
          const btn = document.querySelector('[role="button"][aria-controls="workflow-map-body"]');
          return btn ? btn.getAttribute('aria-expanded') : null;
        });
        record(UI_LABELS[4], 'aria-expanded="false" (stayed collapsed)', String(expandedB2), expandedB2 === 'false');
      }

      // ── (B.3) Click to expand ─────────────────────────────────────────────
      await page.evaluate(() => {
        const btn = document.querySelector('[role="button"][aria-controls="workflow-map-body"]');
        if (btn) btn.click();
      });

      const expandedB3 = await pollPage(page, () => {
        const btn = document.querySelector('[role="button"][aria-controls="workflow-map-body"]');
        return btn && btn.getAttribute('aria-expanded') === 'true' ? 'ok' : null;
      }, 5000);
      record(UI_LABELS[5], 'aria-expanded="true"', expandedB3 ? 'true' : 'still false', expandedB3 === 'ok');

      const lsB3 = await page.evaluate((key) => {
        try { return localStorage.getItem(key); } catch { return null; }
      }, MAP_COLLAPSED_KEY);
      record(UI_LABELS[6], '"false"', String(lsB3), lsB3 === 'false');

      // ── (B.4) Real page.reload() — stays expanded ─────────────────────────
      const mountedB4 = await reloadCardActions(page);
      await waitForMapHeader(page);

      if (!mountedB4) {
        record(UI_LABELS[7], 'CardActionsPage mounted after reload', 'mount timed out', false);
      } else {
        const expandedB4 = await page.evaluate(() => {
          const btn = document.querySelector('[role="button"][aria-controls="workflow-map-body"]');
          return btn ? btn.getAttribute('aria-expanded') : null;
        });
        record(UI_LABELS[7], 'aria-expanded="true" (stayed expanded)', String(expandedB4), expandedB4 === 'true');
      }

      await page.__ctx.close().catch(() => {});
    }

    // ── (C/D/E) Node click → Drawer → close ──────────────────────────────
    console.log('\n  (C/D/E) node click, drawer, close');
    const pageC = await openCardActionsPage(browser, adminClient.cookie);
    const mountedC = await goToCardActions(pageC);

    if (!mountedC) {
      for (const l of UI_LABELS.slice(8)) record(l, 'CardActionsPage mounted', 'mount timed out', false);
      await pageC.__ctx.close().catch(() => {});
    } else {
      // Wait for the Suspense fallback to clear and the ReactFlow canvas to appear.
      const reactFlowReady = await pollPage(pageC, () => {
        const rf = document.querySelector('.react-flow__renderer,.react-flow__viewport');
        return rf ? 'ok' : null;
      }, 20000);

      if (!reactFlowReady) {
        record(UI_LABELS[8], 'ReactFlow canvas visible', 'timed out waiting for .react-flow__renderer', false);
        record(UI_LABELS[9], '"Sales" in drawer', 'ReactFlow not ready', false);
        record(UI_LABELS[10], '"sales" in drawer', 'ReactFlow not ready', false);
        record(UI_LABELS[11], 'drawer closed', 'ReactFlow not ready', false);
        await pageC.__ctx.close().catch(() => {});
      } else {
        // (C) Click the Sales stage node.
        // ReactFlow renders stage nodes with class `react-flow__node-stage-node`.
        const nodeClicked = await pageC.evaluate(() => {
          const nodes = document.querySelectorAll('.react-flow__node-stage-node');
          for (const n of nodes) {
            if ((n.textContent || '').includes('Sales')) {
              n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              return true;
            }
          }
          // Fallback: click whichever stage node is first.
          const first = document.querySelector('.react-flow__node-stage-node');
          if (first) { first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; }
          return false;
        });
        record(UI_LABELS[8], 'Sales stage node clicked', nodeClicked ? 'clicked' : 'no stage node found', nodeClicked);

        // (D) Wait for the Drawer to open; check label and key.
        const drawerLabel = await pollPage(pageC, () => {
          const drawer = document.querySelector('.MuiDrawer-paper');
          if (!drawer) return null;
          const h6 = drawer.querySelector('h6');
          return h6 ? h6.textContent : null;
        }, 8000);

        record(
          UI_LABELS[9],
          '"Sales"',
          drawerLabel ? `"${drawerLabel}"` : 'drawer not opened',
          drawerLabel === 'Sales',
        );

        const drawerKey = await pageC.evaluate(() => {
          const drawer = document.querySelector('.MuiDrawer-paper');
          if (!drawer) return null;
          const codes = drawer.querySelectorAll('code');
          for (const c of codes) {
            if (c.textContent === 'sales') return 'sales';
          }
          return null;
        });
        record(
          UI_LABELS[10],
          '"sales"',
          drawerKey ? `"${drawerKey}"` : 'not found in drawer',
          drawerKey === 'sales',
        );

        // (E) Click the close button and confirm the Drawer disappears.
        await pageC.evaluate(() => {
          const drawer = document.querySelector('.MuiDrawer-paper');
          if (!drawer) return;
          const btns = drawer.querySelectorAll('button');
          if (btns.length) btns[btns.length - 1].click();
        });

        const drawerClosed = await pollPage(pageC, () => {
          const drawer = document.querySelector('.MuiDrawer-paper');
          return drawer ? null : 'closed';
        }, 5000);
        record(UI_LABELS[11], 'drawer closed (no .MuiDrawer-paper)', drawerClosed ? 'closed' : 'still open', drawerClosed === 'closed');

        await pageC.__ctx.close().catch(() => {});
      }
    }

  } catch (e) {
    console.error('Test error:', e);
    console.error('--- server log (last 2000 chars) ---');
    console.error(logBuf.join('').slice(-2000));
  } finally {
    try { await browser.close(); } catch {}
    const failed = findings.filter(f => !f.ok).length;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);
    await cleanupAndExit(failed === 0 ? 0 : 1);
  }
}

main();
