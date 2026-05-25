'use strict';
// test/react-admin-tabs/run.js
//
// End-to-end smoke test for the React island mounted into the admin panel
// (`src/react/main.tsx`). Confirms that the bundle built into
// `public/react/main.js` actually renders the Search (#tab-search) and
// Design System (#tab-designsystem) panels with their expected React-owned
// markup. A broken Vite build, a missed `MOUNTS` entry, or a regression on
// the self-mount path would surface here instead of waiting for an admin to
// click the tab in production.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:react-admin-tabs
//   # or against the shared DB:
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:react-admin-tabs

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

async function waitForSelectorInPanel(page, panelId, selector, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate((pid, sel) => {
      const panel = document.getElementById(pid);
      if (!panel) return false;
      return !!panel.querySelector(sel);
    }, panelId, selector);
    if (found) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
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

  // The React bundle is built into public/react/main.js by `npm run build:react`.
  // Without it the admin tabs would simply be empty and every probe would
  // fail with a confusing "selector not found" — surface this prerequisite
  // explicitly instead.
  const bundlePath = path.resolve(__dirname, '..', '..', 'public', 'react', 'main.js');
  if (!fs.existsSync(bundlePath)) {
    console.error(
      '\n  ✘ public/react/main.js is missing.\n'
      + '    Run `npm run build:react` before this test.\n',
    );
    process.exit(2);
  }

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  react-admin-tabs smoke  run=${runId}`);
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

  // Static-asset pre-check: bundle must be served by Express.
  try {
    const r = await fetch(`${BASE}/react/main.js`);
    record(
      'GET /react/main.js serves the built bundle',
      'status=200 with non-empty body',
      `status=${r.status} length=${r.headers.get('content-length') || 'n/a'}`,
      r.status === 200,
    );
  } catch (e) {
    record('GET /react/main.js serves the built bundle', 'status=200', `error: ${e.message}`, false);
  }

  const adminClient = await login(users.admin.email, PASSWORD);

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
    const page = await browser.newPage();
    await page.setCacheEnabled(false);

    // Surface in-page errors that are plausibly related to the React island.
    // Ignore generic 404s for unrelated static assets (favicon, storybook
    // index, source maps) so the smoke test only fails on real React-mount
    // breakages.
    const pageErrors = [];
    // "Failed to load resource" console errors don't carry a URL in the
    // text — the response listener below covers 404 detection for paths we
    // actually care about (`/react/*`), so we ignore those messages here.
    const IGNORE_RE = /(favicon\.ico|\/storybook\/|\.map\b|Failed to load resource)/;
    page.on('pageerror', (err) => { pageErrors.push(String(err)); });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (IGNORE_RE.test(text)) return;
      pageErrors.push(`console.error: ${text}`);
    });
    page.on('response', (res) => {
      if (res.status() !== 404) return;
      const url = res.url();
      if (IGNORE_RE.test(url)) return;
      if (/\/react\//.test(url)) pageErrors.push(`404: ${url}`);
    });

    await injectSession(page, adminClient.cookie);

    // Use domcontentloaded — admin.html issues many background fetches that
    // never quiesce when HubSpot is stripped.
    await page.goto(`${BASE}/admin`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    // Give the React bundle a tick to evaluate and self-mount. The MOUNTS
    // table targets both tabs unconditionally, so both panels should be
    // populated even before any tab button is clicked.
    await new Promise(r => setTimeout(r, 800));

    // ── Search tab ───────────────────────────────────────────────────────
    await page.evaluate(() => {
      if (typeof window.switchTab === 'function') window.switchTab('search');
    });

    const searchPanelExists = await page.evaluate(() =>
      !!document.getElementById('tab-search'),
    );
    record(
      '#tab-search mount point exists in admin.html',
      'element with id="tab-search" present',
      `present=${searchPanelExists}`,
      searchPanelExists,
    );

    const searchMounted = await page.evaluate(() => {
      const el = document.getElementById('tab-search');
      return !!el && el.dataset.dsRendered === '1';
    });
    record(
      'React island flags #tab-search as mounted (data-ds-rendered="1")',
      'data-ds-rendered="1" on #tab-search',
      `flagged=${searchMounted}`,
      searchMounted,
    );

    const searchRowAppeared = await waitForSelectorInPanel(page, 'tab-search', '.ss-action-row', 6000);
    const searchRowCount = await page.evaluate(() => {
      const el = document.getElementById('tab-search');
      return el ? el.querySelectorAll('.ss-action-row').length : 0;
    });
    record(
      '#tab-search renders SearchSettingsPage rows (.ss-action-row)',
      'at least one .ss-action-row inside #tab-search',
      `appeared=${searchRowAppeared} rowCount=${searchRowCount}`,
      searchRowAppeared && searchRowCount > 0,
    );

    // ── Design System tab ────────────────────────────────────────────────
    await page.evaluate(() => {
      if (typeof window.switchTab === 'function') window.switchTab('designsystem');
    });

    const dsPanelExists = await page.evaluate(() =>
      !!document.getElementById('tab-designsystem'),
    );
    record(
      '#tab-designsystem mount point exists in admin.html',
      'element with id="tab-designsystem" present',
      `present=${dsPanelExists}`,
      dsPanelExists,
    );

    const dsMounted = await page.evaluate(() => {
      const el = document.getElementById('tab-designsystem');
      return !!el && el.dataset.dsRendered === '1';
    });
    record(
      'React island flags #tab-designsystem as mounted (data-ds-rendered="1")',
      'data-ds-rendered="1" on #tab-designsystem',
      `flagged=${dsMounted}`,
      dsMounted,
    );

    const dsSectionAppeared = await waitForSelectorInPanel(page, 'tab-designsystem', '.ds-section', 6000);
    const dsSectionCount = await page.evaluate(() => {
      const el = document.getElementById('tab-designsystem');
      return el ? el.querySelectorAll('.ds-section').length : 0;
    });
    record(
      '#tab-designsystem renders DesignSystemPage sections (.ds-section)',
      'at least one .ds-section inside #tab-designsystem',
      `appeared=${dsSectionAppeared} sectionCount=${dsSectionCount}`,
      dsSectionAppeared && dsSectionCount > 0,
    );

    record(
      'no uncaught page errors while React island mounts',
      '0 pageerror / console.error events',
      `count=${pageErrors.length}${pageErrors.length ? ' first=' + JSON.stringify(pageErrors[0]).slice(0, 200) : ''}`,
      pageErrors.length === 0,
    );

    await page.close();
  } finally {
    await browser.close().catch(() => {});
  }

  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# React Admin Tabs — Smoke Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:react-admin-tabs\``,
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
    '- **(static)** Confirms Express serves the built `/react/main.js` bundle.',
    '- **(Search tab)** Asserts `#tab-search` exists, is flagged by',
    '  `src/react/main.tsx` with `data-ds-rendered="1"`, and contains at',
    '  least one `.ss-action-row` rendered by `<SearchSettingsPage/>`.',
    '- **(Design System tab)** Asserts `#tab-designsystem` exists, is',
    '  flagged the same way, and contains at least one `.ds-section`',
    '  rendered by `<DesignSystemPage/>`.',
    '- **(runtime errors)** Asserts the React mount produced no `pageerror`',
    '  or `console.error` events.',
    '',
    '## Notes',
    '',
    '- Requires `public/react/main.js` to exist; the test pre-flights for it',
    '  and refuses to run otherwise. Run `npm run build:react` first.',
    '- The test server strips `HUBSPOT_TOKEN`, but the React island does not',
    '  depend on HubSpot for either panel, so both tabs render normally.',
  ];
  const outPath = path.join(dir, 'react-admin-tabs.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/react-admin-tabs.md`);
}

main();
