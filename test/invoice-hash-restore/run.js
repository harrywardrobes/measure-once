'use strict';
const { makeSkip } = require('../helpers/report');
// test/invoice-hash-restore/run.js
//
// Puppeteer probe: when the Customer Detail page is loaded
// with a URL hash of the form `#inv-{id}` and that invoice id is in the
// contact's matched invoice list, the InvoiceDetailDrawer should open
// automatically on mount.
//
// Also verifies that closing the drawer clears the hash.
//
// Probe (IH-A): load `/customers/99999#inv-testinv001`, intercept
//   `/api/quickbooks/status` → connected:true and
//   `/api/quickbooks/invoices` → one invoice whose BillEmail matches the
//   contact email; assert the MUI Drawer paper is visible (open).
//
// Probe (IH-B): close the drawer and assert the URL hash is cleared.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:invoice-hash-restore
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:invoice-hash-restore

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
  __dirname, '..', '..', 'test-results', 'invoice-hash-restore.md',
);

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
const skip = makeSkip(findings);

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

async function pollPage(page, fn, arg, timeoutMs = 12000, intervalMs = 200) {
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
}

const FAKE_CONTACT_ID = '99999';
const FAKE_INV_ID     = 'testinv001';
const FAKE_EMAIL      = 'hashtest@example.com';

const FAKE_CONTACT = {
  id: FAKE_CONTACT_ID,
  properties: {
    firstname: 'Hash', lastname: 'Test', email: FAKE_EMAIL,
    company: '', phone: '', hs_lead_status: null,
  },
};

const FAKE_INVOICE = {
  Id:          FAKE_INV_ID,
  DocNumber:   'INV-HASH-001',
  TxnDate:     '2025-06-01',
  DueDate:     '2025-07-01',
  TotalAmt:    500,
  Balance:     500,
  BillEmail:   { Address: FAKE_EMAIL },
  CustomerRef: { name: 'Hash Test', value: FAKE_CONTACT_ID },
};

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  const lines = [
    '# Invoice hash restore — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:invoice-hash-restore\``,
    '',
    '## Summary',
    '',
    `- Passed: ${passed} / ${findings.length}`,
    `- Skipped: ${skipped} / ${findings.length}`,
    `- Failed: ${failed} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`
    ),
    '',
    '## Coverage',
    '',
    '- **(IH-A)** Load `/customers/99999#inv-testinv001` with QB intercepted to',
    '  return a matching invoice; assert `InvoiceDetailDrawer` is open immediately.',
    '- **(IH-B)** Click the drawer close button; assert the URL hash is cleared.',
    '',
    '## Relevant files',
    '',
    '- `src/react/pages/customer-detail/InvoicesSection.tsx` — hash restore on mount',
    '- `src/react/components/InvoiceDetailDrawer.tsx` — MUI Drawer component',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

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
  console.log(`\n  invoice-hash-restore  run=${runId}`);
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

  const adminClient = await login(users.admin.email, users.admin.password);

  const UI_LABELS = [
    '[IH-A] InvoiceDetailDrawer opens when URL hash matches an invoice',
    '[IH-B] URL hash is cleared after closing the drawer',
  ];

  if (!puppeteer) {
    for (const l of UI_LABELS) skip(l, 'puppeteer installed', 'puppeteer not installed');
    await cleanupAndExit(1);
    return;
  }

  const { findChromium } = require('../shared/find-chromium');
  let browser = null;
  let browserLaunchErr = null;
  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
  const launchAttempts = [{ args: launchArgs }];
  const sysChrome = findChromium();
  if (sysChrome) launchAttempts.push({ executablePath: sysChrome, args: launchArgs });
  for (const opts of launchAttempts) {
    try {
      browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1280, height: 900 }, ...opts });
      browserLaunchErr = null;
      break;
    } catch (e) { browserLaunchErr = e; browser = null; }
  }

  if (!browser) {
    for (const l of UI_LABELS) {
      skip(l, 'browser launches', `error: ${browserLaunchErr?.message}`);
    }
    await cleanupAndExit(1);
    return;
  }

  const fakeContact = JSON.stringify(FAKE_CONTACT);
  const fakeInvoice = JSON.stringify(FAKE_INVOICE);
  const fakeContactId = FAKE_CONTACT_ID;
  const fakeInvId     = FAKE_INV_ID;

  let page = null;
  try {
    page = await browser.newPage();
    await page.setCacheEnabled(false);

    const pageLogs = [];
    page.on('console',   m => pageLogs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', e => pageLogs.push(`[pageerror] ${e.message}`));

    // Intercept QB and contact API calls with a fetch override injected before
    // any page JS runs — same pattern used by calendar-empty-state test.
    await page.evaluateOnNewDocument((contactJson, invoiceJson, contactId) => {
      const origFetch = window.fetch;
      window.fetch = function(input, init) {
        const url      = typeof input === 'string' ? input : (input && input.url) || '';
        const pathname = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0];

        if (pathname === `/api/contacts/${contactId}`) {
          return Promise.resolve(new Response(contactJson, {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }));
        }
        if (pathname === `/api/contacts/${contactId}/localdata`) {
          return Promise.resolve(new Response('[]', {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }));
        }
        if (pathname === `/api/contacts/${contactId}/tasks`) {
          return Promise.resolve(new Response(JSON.stringify({ results: [] }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }));
        }
        if (pathname === '/api/quickbooks/status') {
          return Promise.resolve(new Response(
            JSON.stringify({ connected: true, company: 'Test QB Co' }), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            }
          ));
        }
        if (pathname === '/api/quickbooks/invoices') {
          return Promise.resolve(new Response(
            invoiceJson, {
              status: 200, headers: { 'Content-Type': 'application/json' },
            }
          ));
        }
        if (pathname === '/api/lead-statuses' || pathname === '/api/lead-substatuses') {
          return Promise.resolve(new Response('[]', {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }));
        }
        if (pathname === '/api/workflow') {
          return Promise.resolve(new Response(JSON.stringify({ stages: {} }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }));
        }
        if (pathname.startsWith(`/api/design-visits`)) {
          return Promise.resolve(new Response('[]', {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }));
        }
        if (pathname.startsWith('/api/visits')) {
          return Promise.resolve(new Response('[]', {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }));
        }
        if (pathname.startsWith('/api/emails')) {
          return Promise.resolve(new Response(
            JSON.stringify({ connected: false, emails: [] }), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            }
          ));
        }
        if (pathname.startsWith('/api/whatsapp')) {
          return Promise.resolve(new Response(
            JSON.stringify({ enabled: false, messages: [] }), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            }
          ));
        }
        return origFetch.call(this, input, init);
      };
    }, fakeContact, JSON.stringify({ invoices: [FAKE_INVOICE] }), fakeContactId);

    await injectSession(page, adminClient.cookie);

    const targetUrl = `${BASE}/customers/${fakeContactId}#inv-${fakeInvId}`;
    console.log(`\n  Loading: ${targetUrl}`);
    const resp = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    record(
      'page loads (HTTP 200)',
      '200',
      String(resp ? resp.status() : 0),
      resp && resp.ok(),
    );

    if (!resp || !resp.ok()) {
      console.log('    page logs:', pageLogs.slice(-10).join('\n'));
      await browser.close().catch(() => {});
      await cleanupAndExit(1);
      return;
    }

    // ── [IH-A] Wait for the drawer to open ────────────────────────────────────
    console.log('\n  Probe IH-A: waiting for InvoiceDetailDrawer to open…');

    const drawerOpened = await pollPage(page, () => {
      const drawer = document.querySelector('[data-testid="invoice-detail-drawer"]');
      if (!drawer) return null;
      const paper = document.querySelector('[data-testid="invoice-drawer-paper"]');
      if (!paper) return null;
      // MUI Drawer: when open the paper's computed transform is matrix(1,0,0,1,0,0)
      // (no translation). When closed it is translateX(100%).
      const style     = window.getComputedStyle(paper);
      const transform = style.transform || style.webkitTransform || '';
      return (transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)')
        ? 'open'
        : null;
    }, null, 15000, 300);

    record(
      '[IH-A] InvoiceDetailDrawer opens when URL hash matches an invoice',
      'open',
      drawerOpened || 'not open (timeout)',
      drawerOpened === 'open',
      drawerOpened ? '' : pageLogs.slice(-15).join(' | '),
    );

    if (drawerOpened !== 'open') {
      await browser.close().catch(() => {});
      await cleanupAndExit(1);
      return;
    }

    // ── [IH-B] Close the drawer and check hash is cleared ─────────────────────
    console.log('  Probe IH-B: closing the drawer…');

    // Click the close button inside the drawer (MUI IconButton aria-label="Close")
    const closed = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="invoice-detail-drawer"] button[aria-label="Close"]')
        || document.querySelector('[data-testid="invoice-detail-drawer"] [aria-label="close"]')
        || document.querySelector('[data-testid="invoice-detail-drawer"] [aria-label="Close"]');
      if (!btn) return 'no-close-button';
      btn.click();
      return 'clicked';
    });

    if (closed !== 'clicked') {
      // Try pressing Escape as a fallback
      await page.keyboard.press('Escape');
    }

    // Wait for the hash to be cleared (history.replaceState removes it)
    const hashCleared = await pollPage(page, () => {
      return window.location.hash === '' ? 'cleared' : null;
    }, null, 5000, 200);

    record(
      '[IH-B] URL hash is cleared after closing the drawer',
      'cleared',
      hashCleared || `still: "${await page.evaluate(() => window.location.hash)}"`,
      hashCleared === 'cleared',
    );

  } catch (e) {
    record('test harness', 'no error', `error: ${e.message}`, false,
      (logBuf || []).slice(-20).join(''));
  } finally {
    if (page) {
      const pl = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="invoice-detail-drawer"]')).length
      ).catch(() => 0);
      console.log(`\n  Drawer elements in DOM: ${pl}`);
      await page.close().catch(() => {});
    }
    if (browser) await browser.close().catch(() => {});
  }

  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok && !f.skipped).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

main();
