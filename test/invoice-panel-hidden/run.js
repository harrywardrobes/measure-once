'use strict';
// test/invoice-panel-hidden/run.js
//
// End-to-end regression test confirming that the legacy #inv-panel static
// element is gone from every dashboard page (migrated to InvoiceDetailDrawer),
// and that no MUI Drawer is visibly open on initial page load.
//
// Checks:
//   - Home, Trades, Projects, Survey, Invoices, Calendar:
//       (A) #inv-panel is NOT present in the DOM (old static panel removed)
//       (B) No [data-testid="invoice-detail-drawer"] element has its paper
//           in a translated-open state on initial load
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:invoice-panel-hidden
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:invoice-panel-hidden

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

async function pollPage(page, fn, arg, timeoutMs = 8000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = await page.evaluate(fn, arg);
    if (got !== null && got !== undefined) return got;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return page.evaluate(fn, arg);
}

// Wait until the React bundle has mounted (checks for known React mount markers).
async function waitForReact(page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      // The React bundle sets data-ds-rendered="1" on mount elements.
      return document.querySelector('[data-ds-rendered="1"]') !== null
        || document.querySelector('[data-testid]') !== null
        || document.readyState === 'complete';
    });
    if (ready) return;
    await new Promise(r => setTimeout(r, 150));
  }
}

// ── report ────────────────────────────────────────────────────────────────────

async function writeReport(findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Invoice panel hidden — CSS regression test',
    '',
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:invoice-panel-hidden\``,
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
    'Loads six dashboard pages as an admin user and asserts:',
    '- `#inv-panel` (the old static panel) is NOT present in the DOM — it has been',
    '  replaced by the React InvoiceDetailDrawer component.',
    '- No MUI Drawer with data-testid="invoice-detail-drawer" is open on initial load.',
    '',
    '## Relevant files',
    '',
    '- `src/react/components/InvoiceDetailDrawer.tsx` — shared MUI Drawer component',
    '- `src/react/pages/customer-detail/InvoicesSection.tsx` — customer detail integration',
    '- `src/react/pages/ProjectsPage.tsx` — projects page integration',
    '- `src/react/pages/StandaloneInvoicesPage.tsx` — invoices page integration',
  ];
  const outPath = path.join(dir, 'invoice-panel-hidden.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log('  Report: test-results/invoice-panel-hidden.md');
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  invoice-panel-hidden  drawer migration regression E2E\n');

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

  const runId = `invpanel-${Date.now().toString(36)}`;
  await cleanupTestData(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded  admin=${users.admin.email}`);

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

  const adminClient = await login(users.admin.email, users.admin.password);
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

  // Pages to verify the old panel is gone and no drawer is open.
  const PAGES = [
    { label: 'Home',     path: '/' },
    { label: 'Trades',   path: '/trades' },
    { label: 'Projects', path: '/projects' },
    { label: 'Survey',   path: '/survey' },
    { label: 'Invoices', path: '/invoices' },
    { label: 'Calendar', path: '/calendar' },
  ];

  try {
    for (const { label, path: pagePath } of PAGES) {
      const page = await browser.newPage();
      await page.setCacheEnabled(false);
      page.on('pageerror', (e) => console.log(`    [${label} pageerror]`, String(e).slice(0, 200)));

      const { hostname } = new URL(BASE);
      await page.setCookie({
        name: parseCookieKV(adminClient.cookie)?.name,
        value: parseCookieKV(adminClient.cookie)?.value,
        domain: hostname, path: '/', httpOnly: true,
      });

      const resp = await page.goto(`${BASE}${pagePath}`, { waitUntil: 'domcontentloaded', timeout: 20000 });

      record(
        `${label}: page loads (HTTP 200)`,
        '200',
        String(resp ? resp.status() : 0),
        resp && resp.ok(),
      );

      if (resp && resp.ok()) {
        // Wait briefly for React to mount
        await waitForReact(page);
        await new Promise(r => setTimeout(r, 500));

        // (A) Old static #inv-panel must NOT be in the DOM
        const panelPresent = await page.evaluate(() => !!document.getElementById('inv-panel'));
        record(
          `${label}: #inv-panel (old static panel) absent from DOM`,
          'absent',
          panelPresent ? 'present' : 'absent',
          !panelPresent,
        );

        // (B) No MUI Drawer with invoice-detail-drawer testid should be open on load.
        // MUI Drawer renders a .MuiDrawer-paper element; when open=false the paper
        // has transform: translateX(100%) (off-screen). We check the element is
        // either absent or not translated to translateX(0).
        const drawerOpenOnLoad = await page.evaluate(() => {
          const drawer = document.querySelector('[data-testid="invoice-detail-drawer"]');
          if (!drawer) return false;
          const paper = drawer.querySelector('.MuiDrawer-paper');
          if (!paper) return false;
          const style = window.getComputedStyle(paper);
          const transform = style.transform || style.webkitTransform || '';
          // translateX(0) means the drawer is open; anything else means closed
          return transform === 'matrix(1, 0, 0, 1, 0, 0)' || transform === 'none';
        });
        record(
          `${label}: InvoiceDetailDrawer not open on initial load`,
          'closed',
          drawerOpenOnLoad ? 'open' : 'closed',
          !drawerOpenOnLoad,
        );
      }

      await page.close();
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
