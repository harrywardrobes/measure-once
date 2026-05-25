'use strict';
// test/invoice-panel-hidden/run.js
//
// End-to-end test confirming that the invoice panel (#inv-panel) is hidden
// on every dashboard page when not explicitly opened, and becomes visible
// when openInvoicePanel() is simulated on the invoices page.
//
// Checks:
//   - Home, Trades, Projects, Survey, Invoices: #inv-panel has
//     `visibility: hidden` via computed style (no inv-panel-open class).
//   - Invoices page: adding the inv-panel-open class makes visibility: visible.
//
// This guards against stylesheet regressions where MUI emotion, Tailwind,
// or other CSS overrides the `.inv-panel` hiding rules in app-styles.css.
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

async function injectSession(page, jar) {
  const kv = parseCookieKV(jar);
  if (!kv) return;
  const { hostname } = new URL(BASE);
  await page.setCookie({
    name: kv.name, value: kv.value,
    domain: hostname, path: '/', httpOnly: true,
  });
}

async function pollPage(page, fn, arg, timeoutMs = 8000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = await page.evaluate(fn, arg);
    if (got) return got;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return page.evaluate(fn, arg);
}

// Returns the computed visibility of #inv-panel ('hidden', 'visible', or null
// if the element is missing).
async function getPanelVisibility(page) {
  return page.evaluate(() => {
    const panel = document.getElementById('inv-panel');
    if (!panel) return null;
    return window.getComputedStyle(panel).visibility;
  });
}

// Returns true if #inv-panel is present in the DOM.
async function waitForPanel(page) {
  return pollPage(page, () => !!document.getElementById('inv-panel'), null, 8000);
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
    'Loads five dashboard pages as an admin user and asserts that `#inv-panel`',
    'has `visibility: hidden` via computed style on each page before the panel',
    'is opened. On the invoices page, also adds the `inv-panel-open` class and',
    'confirms `visibility` becomes `visible`.',
    '',
    'Guards against stylesheet regressions where MUI emotion, Tailwind, or',
    'other CSS overrides the `.inv-panel` hiding rules in `app-styles.css`.',
    '',
    '## Relevant files',
    '',
    '- `public/chrome.js` — injects `#inv-panel` into every dashboard page',
    '- `public/app-styles.css` — `.inv-panel { visibility: hidden }` + `.inv-panel-open { visibility: visible !important }`',
    '- `public/invoices-core.js` — `openInvoicePanel()` adds `inv-panel-open`',
  ];
  const outPath = path.join(dir, 'invoice-panel-hidden.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log('  Report: test-results/invoice-panel-hidden.md');
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  invoice-panel-hidden  CSS visibility regression E2E\n');

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

  // Pages to verify the panel is hidden on load.
  const PAGES = [
    { label: 'Home',     path: '/' },
    { label: 'Trades',   path: '/trades' },
    { label: 'Projects', path: '/projects' },
    { label: 'Survey',   path: '/survey' },
    { label: 'Invoices', path: '/invoices' },
  ];

  try {
    // ── F1: panel hidden on each page ───────────────────────────────────────
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
        const panelPresent = await waitForPanel(page);
        record(
          `${label}: #inv-panel present in DOM (injected by chrome.js)`,
          'present',
          panelPresent ? 'present' : 'absent',
          !!panelPresent,
        );

        if (panelPresent) {
          const visibility = await getPanelVisibility(page);
          record(
            `${label}: #inv-panel visibility === "hidden" on load`,
            'hidden',
            visibility ?? 'null',
            visibility === 'hidden',
          );
        }
      }

      await page.close();
    }

    // ── F2: panel becomes visible when inv-panel-open class is added ─────────
    {
      const page = await browser.newPage();
      await page.setCacheEnabled(false);
      page.on('pageerror', (e) => console.log('    [invoices open pageerror]', String(e).slice(0, 200)));

      const { hostname } = new URL(BASE);
      await page.setCookie({
        name: parseCookieKV(adminClient.cookie)?.name,
        value: parseCookieKV(adminClient.cookie)?.value,
        domain: hostname, path: '/', httpOnly: true,
      });

      const resp = await page.goto(`${BASE}/invoices`, { waitUntil: 'domcontentloaded', timeout: 20000 });

      record(
        'Invoices open: page loads (HTTP 200)',
        '200',
        String(resp ? resp.status() : 0),
        resp && resp.ok(),
      );

      if (resp && resp.ok()) {
        const panelPresent = await waitForPanel(page);

        if (panelPresent) {
          // Simulate openInvoicePanel() by adding the class directly
          // (avoids needing QB API credentials).
          await page.evaluate(() => {
            document.getElementById('inv-panel').classList.add('inv-panel-open');
          });

          // Allow the CSS transition to start (transition-delay: 0s on open).
          await new Promise(r => setTimeout(r, 100));

          const visibilityAfterOpen = await getPanelVisibility(page);
          record(
            'Invoices open: #inv-panel visibility === "visible" after adding inv-panel-open',
            'visible',
            visibilityAfterOpen ?? 'null',
            visibilityAfterOpen === 'visible',
          );

          // Also confirm no-open class = hidden again.
          await page.evaluate(() => {
            document.getElementById('inv-panel').classList.remove('inv-panel-open');
          });

          // After removal the CSS applies `visibility: hidden` with a 0.25s
          // transition-delay, so we need to wait for it.
          await new Promise(r => setTimeout(r, 400));

          const visibilityAfterClose = await getPanelVisibility(page);
          record(
            'Invoices open: #inv-panel visibility === "hidden" after removing inv-panel-open',
            'hidden',
            visibilityAfterClose ?? 'null',
            visibilityAfterClose === 'hidden',
          );
        } else {
          record(
            'Invoices open: #inv-panel present (prerequisite for open test)',
            'present',
            'absent',
            false,
          );
        }
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
