'use strict';
// test/lead-status-sync/customer-detail-editable.js
//
// Isolated end-to-end test: the lead-status pill in #workflow-header is
// clickable (editable) for manager-role and admin-role users.
//
// This file intentionally boots its own fresh browser with no prior admin
// pages or request-interception sessions — mirroring the same isolation
// guarantee as the sibling viewer test.
//
// Regression guard for the `canEditPrivilege()` gate in
// _renderWorkflowHeaderImpl (public/customer-detail.js).
// If that gate ever regresses and strips lsb-clickable from manager/admin
// pills, or prevents the unified picker from opening, this suite will fail.
//
// canEditPrivilege() (public/core.js) currently allows: manager, admin.
// viewer and member are read-only; the sibling suite covers the viewer path.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:lead-status-sync-customer-detail-editable
//   # or against the shared DB with the privtest- prefix cleanup:
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:lead-status-sync-customer-detail-editable

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
const KEY_A      = 'PRIVTEST_LSE_A';
const KEY_B      = 'PRIVTEST_LSE_B';
const LABEL_A    = 'PrivTest Editable Status A';
const LABEL_B    = 'PrivTest Editable Status B';
const CONTACT_ID = '999999998';

// ── helpers ───────────────────────────────────────────────────────────────────
function parseCookieKV(jar) {
  if (!jar) return null;
  const idx = jar.indexOf('=');
  if (idx < 0) return null;
  return { name: jar.slice(0, idx), value: jar.slice(idx + 1) };
}

// Seed window.__moHeaderUser + state, load statuses from the server, and
// render the workflow header so the pill is present.
// Mirrors the same technique used by the viewer-isolation suite and
// probe [G] in customer-detail.js.
async function bootstrapHeader(page, lsKey, role) {
  return page.evaluate(async (currentLs, userRole) => {
    // React manages its own DOM — do NOT wipe #workflow-view's innerHTML here.
    // Just seed the globals and let renderWorkflowHeader() drive a React state
    // update (flushSync) so the component re-renders with the new contact.

    if (typeof loadLeadStatuses === 'function')    await loadLeadStatuses();
    if (typeof loadLeadSubstatuses === 'function') await loadLeadSubstatuses();

    state.selectedContact = {
      id: '999999998',
      properties: {
        hs_lead_status: currentLs,
        hw_lead_substatus: '',
        firstname: 'Editable', lastname: 'Test', email: 'editabletest@privtest.local',
      },
    };
    state.selectedContactId = '999999998';
    state.user = { privilege_level: userRole };
    window.__moHeaderUser = { privilege_level: userRole };
    state.focusedLeadStatus = null;

    if (typeof renderWorkflowHeader === 'function') renderWorkflowHeader();
  }, lsKey, role);
}

// Assert that the pill for a given role is editable (lsb-clickable and
// clicking it opens #card-picker-popup).
async function probeEditableRole(page, role, lsKey, record) {
  // Re-bootstrap for the current role so state is clean.
  await bootstrapHeader(page, lsKey, role);
  await new Promise(r => setTimeout(r, 300));

  const pillInfo = await page.evaluate(() => {
    const pill = document.querySelector('#workflow-header .lead-status-badge');
    return {
      present:   !!pill,
      clickable: !!pill && pill.classList.contains('lsb-clickable'),
    };
  });

  record(
    `[${role}] lead-status pill is present in #workflow-header`,
    'pill is present',
    `present=${pillInfo.present}`,
    pillInfo.present,
  );
  record(
    `[${role}] pill has class lsb-clickable`,
    'classList contains "lsb-clickable"',
    `clickable=${pillInfo.clickable}`,
    pillInfo.clickable,
  );

  // Click the pill and confirm the React LeadStatusPicker (MUI Popover) opens.
  // The picker is now a React component rendered as a MUI Popover portal — it
  // no longer uses the vanilla-JS #card-picker-popup DOM element (task #1382).
  if (pillInfo.present && pillInfo.clickable) {
    const pill = await page.$('#workflow-header .lead-status-badge');
    if (pill) {
      await pill.click();
      // Wait for the MUI Popover to render (it mounts into a portal at body level).
      await new Promise(r => setTimeout(r, 600));
    }

    const pickerResult = await page.evaluate(() => {
      // The React LeadStatusPicker renders as a MUI Popover portal.
      // Check for a Popover root or the "Clear status" button inside it.
      const popover = document.querySelector('[class*="MuiPopover-root"]');
      const clearBtn = Array.from(document.querySelectorAll('button')).find(
        b => b.textContent.includes('Clear status'),
      );
      return { popupCreated: !!(popover || clearBtn) };
    });

    record(
      `[${role}] clicking the pill opens the React LeadStatusPicker popover`,
      'MUI Popover is present in DOM',
      `pickerOpened=${pickerResult.popupCreated}`,
      pickerResult.popupCreated,
    );

    // Close the picker by pressing Escape for a clean state.
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 200));
  }
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
  console.log(`\n  lead-status editable-role pill isolation  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  const PRIVTEST_KEYS = [KEY_A, KEY_B];

  await cleanupTestData(pool);
  await pool.query(`DELETE FROM lead_status_config WHERE key = ANY($1)`, [PRIVTEST_KEYS]);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  manager=${users.manager.email}  admin=${users.admin.email}`);

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
    record('headless chromium launches', 'browser.launch() succeeds', `error: ${e.message}`, false);
    await writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

  // ── manager probe ──────────────────────────────────────────────────────────
  // Each role gets its own fresh incognito context — belt-and-braces isolation.
  try {
    console.log('\n  [manager] Manager role: lead-status pill is editable (picker opens)');

    const managerClient = await login(users.manager.email, PASSWORD);
    const managerCtx = await (browser.createBrowserContext
      ? browser.createBrowserContext()
      : browser.createIncognitoBrowserContext());
    const managerPage = await managerCtx.newPage();
    await managerPage.setCacheEnabled(false);

    const managerKV = parseCookieKV(managerClient.cookie);
    if (managerKV) {
      const { hostname } = new URL(BASE);
      await managerPage.setCookie({
        name: managerKV.name, value: managerKV.value,
        domain: hostname, path: '/', httpOnly: true,
      });
    }

    await managerPage.goto(`${BASE}/customers/${CONTACT_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await new Promise(r => setTimeout(r, 900));

    await probeEditableRole(managerPage, 'manager', KEY_A, record);

    await managerPage.close();
    await managerCtx.close().catch(() => {});

    // ── admin probe ────────────────────────────────────────────────────────
    console.log('\n  [admin] Admin role: lead-status pill is editable (picker opens)');

    const adminClient = await login(users.admin.email, PASSWORD);
    const adminCtx = await (browser.createBrowserContext
      ? browser.createBrowserContext()
      : browser.createIncognitoBrowserContext());
    const adminPage = await adminCtx.newPage();
    await adminPage.setCacheEnabled(false);

    const adminKV = parseCookieKV(adminClient.cookie);
    if (adminKV) {
      const { hostname } = new URL(BASE);
      await adminPage.setCookie({
        name: adminKV.name, value: adminKV.value,
        domain: hostname, path: '/', httpOnly: true,
      });
    }

    await adminPage.goto(`${BASE}/customers/${CONTACT_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await new Promise(r => setTimeout(r, 900));

    await probeEditableRole(adminPage, 'admin', KEY_A, record);

    await adminPage.close();
    await adminCtx.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }

  // ── summary & report ───────────────────────────────────────────────────────
  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

// ── report writer ──────────────────────────────────────────────────────────────
async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Lead-Status Editable-Role Pill — Isolated E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:lead-status-sync-customer-detail-editable\``,
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
    '- **Manager pill present**: navigates to `/customers/:id` as a manager-role user,',
    '  bootstraps the workflow header with `privilege_level: "manager"`, and asserts',
    '  `.lead-status-badge` is rendered inside `#workflow-header`.',
    '- **lsb-clickable class present**: asserts the pill carries the `lsb-clickable`',
    '  CSS class that enables click-to-open.',
    '- **Picker popover opens**: clicks the pill element and asserts a MUI Popover',
    '  (or the "Clear status" button inside it) appears in the DOM. The picker is',
    '  now a React LeadStatusPicker component (task #1382) — `#card-picker-popup`',
    '  is no longer used.',
    '- **Admin role**: repeats all four assertions with `privilege_level: "admin"` in',
    '  a fresh incognito context.',
    '',
    '## What this guards',
    '',
    '`canEditPrivilege()` in `public/core.js` controls whether the pill renders with',
    '`lsb-clickable` and an `onclick` that opens the unified lead-status picker.',
    'Any regression that removes `manager` or `admin` from that allow-list (e.g. a',
    'bad merge, an accidental tightening of the privilege check, or a rename of the',
    'privilege strings) will cause at least one probe here to fail.',
    '',
    '## Isolation guarantee',
    '',
    'This suite boots its own fresh browser instance with no prior admin pages',
    'loaded. Each role probe runs in a new incognito context so session cookies',
    'cannot leak between probes.',
    '',
    '## Notes',
    '',
    '- The test server strips `HUBSPOT_TOKEN`, so `GET /api/contacts/:id` 503s.',
    '  `bootstrapHeader` re-injects a minimal `#workflow-stages`/`#workflow-header`',
    '  mount and seeds `state.selectedContact` + `window.__moHeaderUser` directly,',
    '  then calls `renderWorkflowHeader()` — the same renderer path the page uses',
    '  after a successful contact load.',
  ];
  const outPath = path.join(dir, 'lead-status-sync-customer-detail-editable.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/lead-status-sync-customer-detail-editable.md`);
}

main();
