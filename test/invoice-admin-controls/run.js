'use strict';
// test/invoice-admin-controls/run.js
//
// End-to-end test confirming that the invoice edit section and "Send to
// customer" button in public/invoices-core.js are gated by admin privilege:
//
//   - A manager-level user sees neither the "Edit invoice" section nor the
//     "Send to customer" button in the invoice detail panel.
//   - An admin user sees both controls.
//
// The guard in renderInvoicePanelBody() (task-900) is:
//   (state.user?.privilege_level ?? 'member') === 'admin'
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:invoice-admin-controls
//   PRIVTEST_ALLOW_SHARED_DB=1   npm run test:invoice-admin-controls

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

// Poll for a truthy result from `fn` evaluated inside the page.
async function pollPage(page, fn, arg, timeoutMs = 8000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = await page.evaluate(fn, arg);
    if (got) return got;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return page.evaluate(fn, arg);
}

// A minimal fake invoice that satisfies renderInvoicePanelBody()'s template.
const FAKE_INVOICE = {
  id:           'test-inv-001',
  docNumber:    'INV-TEST-001',
  customerName: 'Test Customer',
  txnDate:      '2025-01-15',
  dueDate:      '2025-02-15',
  balance:      '1200.00',
  totalAmt:     '1200.00',
  email:        'customer@example.com',
  memo:         '',
  lines: [
    { detailType: 'SalesItemLineDetail', description: 'Test item', qty: 1, unitPrice: 1200, amount: 1200 },
  ],
};

// Inject state.qb.panel and call renderInvoicePanelBody() inside the page,
// then return an object describing which admin controls are present.
async function probeAdminControls(page) {
  return page.evaluate((fakeInv) => {
    // Ensure the panel body element exists (injected by chrome.js).
    const body = document.getElementById('inv-panel-body');
    if (!body) return { error: 'inv-panel-body not found' };

    // Inject the fake invoice into state.
    if (typeof state === 'undefined') return { error: 'state not defined' };
    state.qb.panel = fakeInv;
    state.qb.panelContext = null; // single-invoice mode (no nav arrows)

    // Call the render function.
    if (typeof renderInvoicePanelBody !== 'function') {
      return { error: 'renderInvoicePanelBody not defined' };
    }
    renderInvoicePanelBody();

    // Inspect the rendered output for the two admin-gated elements.
    const editSection = !!body.querySelector('#inv-save-btn');
    const sendBtn     = !!body.querySelector('#inv-send-btn');
    const editHeader  = Array.from(body.querySelectorAll('h3'))
      .some(h => h.textContent.trim() === 'Edit invoice');

    return { editSection, sendBtn, editHeader, userPrivilege: state.user?.privilege_level ?? null };
  }, FAKE_INVOICE);
}

// ── report ────────────────────────────────────────────────────────────────────

async function writeReport(findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Invoice admin controls — privilege gate test',
    '',
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:invoice-admin-controls\``,
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
    '## What is tested',
    '',
    'Loads `/invoices` as a **manager** and as an **admin**, injects a fake',
    'invoice object into `state.qb.panel`, calls `renderInvoicePanelBody()`,',
    'and asserts:',
    '',
    '- Manager: `#inv-save-btn` absent, `#inv-send-btn` absent,',
    '  "Edit invoice" `<h3>` absent.',
    '- Admin: `#inv-save-btn` present, `#inv-send-btn` present,',
    '  "Edit invoice" `<h3>` present.',
    '',
    '## Relevant files',
    '',
    '- `public/invoices-core.js` — `renderInvoicePanelBody()` (lines ~422, ~455)',
    '- `public/chrome.js` — injects `#inv-panel-body` and panel DOM',
  ];
  const outPath = path.join(dir, 'invoice-admin-controls.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log('  Report: test-results/invoice-admin-controls.md');
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  invoice-admin-controls  privilege gate E2E\n');

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

  // ── DB safety check ────────────────────────────────────────────────────────
  const dbUrl = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Set DATABASE_URL_TEST or DATABASE_URL before running.');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL_TEST && process.env.PRIVTEST_ALLOW_SHARED_DB !== '1') {
    console.error(
      '\n  ✘ Refuses to run against the shared DATABASE_URL by default.\n'
      + '    Set DATABASE_URL_TEST=<disposable> or PRIVTEST_ALLOW_SHARED_DB=1.\n',
    );
    process.exit(2);
  }

  // ── React bundle check ─────────────────────────────────────────────────────
  const bundlePath = path.resolve(__dirname, '..', '..', 'public', 'react', 'main.js');
  if (!fs.existsSync(bundlePath)) {
    console.error('\n  ✘ public/react/main.js is missing — run `npm run build:react` first.\n');
    process.exit(2);
  }

  if (!puppeteer) {
    record('puppeteer available', 'require("puppeteer") resolves', 'module not installed', false);
    await writeReport(findings);
    process.exit(1);
    return;
  }

  const pool = new Pool({ connectionString: dbUrl });
  setPool(pool);

  const runId = `inv-${Date.now().toString(36)}`;
  await cleanupTestData(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded  manager=${users.manager.email}  admin=${users.admin.email}`);

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
    process.exit(code);
  };

  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:', e);  cleanupAndExit(2); });
  process.on('unhandledRejection', (e) => { console.error('Unhandled:', e); cleanupAndExit(2); });

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
    await writeReport(findings);
    await cleanupAndExit(1);
    return;
  }

  try {
    // ── Scenario A: manager — admin controls must be absent ─────────────────
    {
      const managerClient = await login(users.manager.email, users.manager.password);
      const page = await browser.newPage();
      await page.setCacheEnabled(false);
      page.on('pageerror', (e) => console.log('    [manager pageerror]', String(e).slice(0, 200)));
      page.on('console', (m) => {
        if (m.type() === 'error') console.log('    [manager console.error]', m.text().slice(0, 200));
      });

      await injectSession(page, managerClient.cookie);
      const resp = await page.goto(`${BASE}/invoices`, { waitUntil: 'domcontentloaded', timeout: 20000 });

      record(
        'MANAGER: /invoices page loads (HTTP 200)',
        '200',
        String(resp ? resp.status() : 0),
        resp && resp.ok(),
      );

      if (!resp || !resp.ok()) {
        await page.close();
      } else {
        // Wait for state.user to be populated by bootstrap().
        const userReady = await pollPage(page, () => {
          return typeof state !== 'undefined'
            && state.user
            && state.user.privilege_level === 'manager';
        }, null, 10000);

        record(
          'MANAGER: state.user.privilege_level === "manager" after bootstrap',
          'manager',
          userReady ? 'manager' : 'not populated',
          !!userReady,
        );

        // Also wait for chrome.js to have injected the panel body.
        const panelBodyReady = await pollPage(page, () => {
          return !!document.getElementById('inv-panel-body');
        }, null, 5000);

        record(
          'MANAGER: #inv-panel-body present in DOM (injected by chrome.js)',
          'present',
          panelBodyReady ? 'present' : 'absent',
          !!panelBodyReady,
        );

        const result = await probeAdminControls(page);

        if (result.error) {
          record('MANAGER: renderInvoicePanelBody() runs without error', 'no error', result.error, false);
        } else {
          record(
            'MANAGER: "Edit invoice" section header absent',
            'absent',
            result.editHeader ? 'present' : 'absent',
            !result.editHeader,
          );
          record(
            'MANAGER: #inv-save-btn (Save changes) absent',
            'absent',
            result.editSection ? 'present' : 'absent',
            !result.editSection,
          );
          record(
            'MANAGER: #inv-send-btn (Send to customer) absent',
            'absent',
            result.sendBtn ? 'present' : 'absent',
            !result.sendBtn,
          );
        }

        await page.close();
      }
    }

    // ── Scenario B: admin — admin controls must be present ──────────────────
    {
      const adminClient = await login(users.admin.email, users.admin.password);
      const page = await browser.newPage();
      await page.setCacheEnabled(false);
      page.on('pageerror', (e) => console.log('    [admin pageerror]', String(e).slice(0, 200)));
      page.on('console', (m) => {
        if (m.type() === 'error') console.log('    [admin console.error]', m.text().slice(0, 200));
      });

      await injectSession(page, adminClient.cookie);
      const resp = await page.goto(`${BASE}/invoices`, { waitUntil: 'domcontentloaded', timeout: 20000 });

      record(
        'ADMIN: /invoices page loads (HTTP 200)',
        '200',
        String(resp ? resp.status() : 0),
        resp && resp.ok(),
      );

      if (!resp || !resp.ok()) {
        await page.close();
      } else {
        // Wait for state.user to be populated by bootstrap().
        const userReady = await pollPage(page, () => {
          return typeof state !== 'undefined'
            && state.user
            && state.user.privilege_level === 'admin';
        }, null, 10000);

        record(
          'ADMIN: state.user.privilege_level === "admin" after bootstrap',
          'admin',
          userReady ? 'admin' : 'not populated',
          !!userReady,
        );

        // Wait for chrome.js to have injected the panel body.
        const panelBodyReady = await pollPage(page, () => {
          return !!document.getElementById('inv-panel-body');
        }, null, 5000);

        record(
          'ADMIN: #inv-panel-body present in DOM (injected by chrome.js)',
          'present',
          panelBodyReady ? 'present' : 'absent',
          !!panelBodyReady,
        );

        const result = await probeAdminControls(page);

        if (result.error) {
          record('ADMIN: renderInvoicePanelBody() runs without error', 'no error', result.error, false);
        } else {
          record(
            'ADMIN: "Edit invoice" section header present',
            'present',
            result.editHeader ? 'present' : 'absent',
            !!result.editHeader,
          );
          record(
            'ADMIN: #inv-save-btn (Save changes) present',
            'present',
            result.editSection ? 'present' : 'absent',
            !!result.editSection,
          );
          record(
            'ADMIN: #inv-send-btn (Send to customer) present',
            'present',
            result.sendBtn ? 'present' : 'absent',
            !!result.sendBtn,
          );
        }

        await page.close();
      }
    }
  } catch (e) {
    record('test harness', 'no error', `error: ${e.message}`, false,
      (logBuf || []).slice(-20).join(''));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);
  await writeReport(findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

main();
