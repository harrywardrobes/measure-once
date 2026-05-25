'use strict';
// test/window-ui-smoke/run.js
//
// Smoke test: shared chrome includes must be present on every dashboard page.
//
// public/components.js attaches `window.UI = { skeletonLine, renderPill,
// renderEmptyState, renderTabBar, … }` and is included via an explicit
// `<script src="/components.js">` tag after `/chrome.js` on every dashboard
// HTML page. public/chrome.js attaches `window.getShortcut` and
// `window.handleAccessRequestSubmit`, and synchronously injects the top-nav
// header mount (`#app-header-mount`, populated by the React GlobalHeader
// island in /react/main.js) plus — on non-admin pages — the bottom-nav
// mount (`nav.bottom-nav#main-content`). If a new page is added in the
// future and the maintainer forgets either `<script src="/chrome.js">` or
// `<script src="/components.js">`, anything that calls those helpers /
// touches the chrome DOM will silently throw `ReferenceError` or render
// without the shared chrome. This test visits each dashboard route with an
// admin session and asserts that:
//   - `typeof window.UI === 'object'` with all four helpers
//   - `typeof window.getShortcut === 'function'`
//   - `typeof window.handleAccessRequestSubmit === 'function'`
//   - `#app-header-mount` exists in the DOM
//   - `nav.bottom-nav#main-content` exists on every non-admin route
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:window-ui-smoke
//   # or against the shared DB with the privtest- prefix cleanup:
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:window-ui-smoke

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

// Dashboard routes that include components.js. /customers/:id is also a real
// page but the task spec only lists the top-level routes; covering the listed
// 11 is sufficient to catch a missing script tag on any of the shared
// chrome/components includes.
const ROUTES = [
  '/',
  '/customers',
  '/sales',
  '/survey',
  '/projects',
  '/calendar',
  '/invoices',
  '/trades',
  '/ideas',
  '/admin',
  '/profile',
];

const REQUIRED_HELPERS = ['skeletonLine', 'renderPill', 'renderEmptyState', 'renderTabBar'];

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

function findChromium() {
  const { findChromium: shared } = require('../shared/find-chromium');
  return shared() || undefined;
}

function isAdminRoute(route) {
  return route === '/admin' || route.startsWith('/admin/');
}

async function main() {
  console.log('\n  shared chrome includes — smoke test\n');

  const findings = [];
  function record(name, expected, observed, ok, detail) {
    findings.push({ name, expected, observed, ok, detail: detail || '' });
    const mark = ok ? '  \u2713' : '  \u2717';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${JSON.stringify(expected)}`);
      console.log(`     observed : ${JSON.stringify(observed)}`);
      if (detail) console.log(`     detail   : ${detail}`);
    }
  }

  // ── DB safety check (mirror lead-status-sync) ────────────────────────────
  const dbUrl = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Set DATABASE_URL_TEST or DATABASE_URL before running.');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL_TEST && process.env.PRIVTEST_ALLOW_SHARED_DB !== '1') {
    console.error('Refusing to run against shared DATABASE_URL. Set DATABASE_URL_TEST or PRIVTEST_ALLOW_SHARED_DB=1.');
    process.exit(2);
  }

  if (!puppeteer) {
    record('puppeteer available', 'require("puppeteer") resolves',
      'module not installed', false,
      'Install puppeteer (npm i -D puppeteer) and rerun.');
    await writeReport(findings);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: dbUrl });
  setPool(pool);

  const runId = `ui-${Date.now().toString(36)}`;
  const { child, logBuf } = spawnServer();
  let browser;
  let exitCode = 0;
  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    await cleanupTestData(pool);

    const seeded = await seedUsers(pool, runId);
    const admin  = seeded.admin;

    const adminClient = await login(admin.email, admin.password);

    const executablePath = findChromium();
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 1200, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    for (const route of ROUTES) {
      const page = await browser.newPage();
      // Swallow runtime errors from per-page bootstrap (HubSpot is stripped in
      // the test server so many fetches 503) — we only care about whether the
      // shared components.js script tag executed.
      page.on('pageerror', () => {});
      page.on('console', () => {});
      try {
        await injectSession(page, adminClient.cookie);
        const resp = await page.goto(`${BASE}${route}`, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
        const status = resp ? resp.status() : 0;
        if (!resp || !resp.ok()) {
          record(`${route} — page loads (HTTP 200)`, 200, status, false,
            'Page did not return 200; window.UI check skipped.');
          continue;
        }

        // Wait briefly for the synchronous components.js <script> to evaluate.
        // It's a tiny IIFE included right after chrome.js so should be ready
        // by DOMContentLoaded, but poll for up to 5s to be safe across pages
        // with heavy inline init code.
        const adminPage = isAdminRoute(route);
        const ready = await page.waitForFunction(
          (helpers, adminPage) => {
            if (typeof window.UI !== 'object' || window.UI === null) return false;
            for (const h of helpers) {
              if (typeof window.UI[h] !== 'function') return false;
            }
            if (typeof window.getShortcut !== 'function') return false;
            if (typeof window.handleAccessRequestSubmit !== 'function') return false;
            if (!document.querySelector('#app-header-mount')) return false;
            if (!adminPage && !document.querySelector('nav.bottom-nav#main-content')) return false;
            return true;
          },
          { timeout: 5000 },
          REQUIRED_HELPERS,
          adminPage,
        ).then(() => true).catch(() => false);

        // Always re-evaluate to record per-symbol pass/fail for the report.
        const observed = await page.evaluate((helpers) => {
          const out = {
            typeofUI: typeof window.UI,
            uiMissing: [],
            getShortcut: typeof window.getShortcut,
            handleAccessRequestSubmit: typeof window.handleAccessRequestSubmit,
            hasHeader: !!document.querySelector('#app-header-mount'),
            hasBottomNav: !!document.querySelector('nav.bottom-nav#main-content'),
          };
          if (out.typeofUI === 'object' && window.UI) {
            out.uiMissing = helpers.filter(h => typeof window.UI[h] !== 'function');
          } else {
            out.uiMissing = helpers.slice();
          }
          return out;
        }, REQUIRED_HELPERS).catch(e => ({ error: String(e) }));

        const uiOk = observed && observed.typeofUI === 'object'
          && Array.isArray(observed.uiMissing) && observed.uiMissing.length === 0;
        record(
          `${route} — window.UI defined with required helpers`,
          `object with ${REQUIRED_HELPERS.join(', ')}`,
          uiOk ? 'present' : JSON.stringify({ typeofUI: observed?.typeofUI, missing: observed?.uiMissing }),
          !!uiOk,
          uiOk ? '' : 'Likely missing <script src="/components.js"> after chrome.js in the page HTML.',
        );

        const getShortcutOk = observed && observed.getShortcut === 'function';
        record(
          `${route} — window.getShortcut defined`,
          'function',
          observed?.getShortcut || 'missing',
          !!getShortcutOk,
          getShortcutOk ? '' : 'Likely missing <script src="/chrome.js"> in the page HTML.',
        );

        const handlerOk = observed && observed.handleAccessRequestSubmit === 'function';
        record(
          `${route} — window.handleAccessRequestSubmit defined`,
          'function',
          observed?.handleAccessRequestSubmit || 'missing',
          !!handlerOk,
          handlerOk ? '' : 'Likely missing <script src="/chrome.js"> in the page HTML.',
        );

        const headerOk = observed && observed.hasHeader;
        record(
          `${route} — #app-header-mount mounted`,
          'present',
          headerOk ? 'present' : 'missing',
          !!headerOk,
          headerOk ? '' : 'chrome.js did not inject the #app-header-mount placeholder — likely missing <script src="/chrome.js">.',
        );

        if (!adminPage) {
          const navOk = observed && observed.hasBottomNav;
          record(
            `${route} — nav.bottom-nav#main-content mounted`,
            'present',
            navOk ? 'present' : 'missing',
            !!navOk,
            navOk ? '' : 'chrome.js did not inject the bottom-nav — likely missing <script src="/chrome.js">.',
          );
        }

        if (!ready) {
          // waitForFunction timed out but per-symbol records already captured
          // the specific failure(s); nothing else to do here.
        }
      } catch (e) {
        record(`${route} — shared chrome includes present`,
          'page loads and chrome globals are set',
          `error: ${e.message}`, false);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } catch (e) {
    record('test harness setup', 'no error', `error: ${e.message}`, false,
      (logBuf || []).slice(-20).join(''));
    exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { await cleanupTestData(pool); } catch {}
    try { await pool.end(); } catch {}
    try { child.kill('SIGTERM'); } catch {}
  }

  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);
  await writeReport(findings);
  process.exit(fail > 0 || exitCode ? 1 : 0);
}

async function writeReport(findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Shared chrome includes — Smoke Test',
    '',
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:window-ui-smoke\``,
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
    'Visits each dashboard route below with an admin session and asserts:',
    '',
    '- `window.UI` is an object with `skeletonLine`, `renderPill`,',
    '  `renderEmptyState`, `renderTabBar` (from `public/components.js`)',
    '- `window.getShortcut` is a function (from `public/chrome.js`)',
    '- `window.handleAccessRequestSubmit` is a function (from `public/chrome.js`)',
    '- `#app-header-mount` is mounted (injected by `public/chrome.js`,',
    '  populated by the React GlobalHeader island in `/react/main.js`)',
    '- `nav.bottom-nav#main-content` is mounted on every non-admin route',
    '  (also injected by `public/chrome.js`)',
    '',
    'Routes covered:',
    '',
    ...ROUTES.map(r => `- \`${r}\``),
    '',
    '## Relevant files',
    '',
    '- `public/chrome.js` — top-nav header, bottom-nav, `window.getShortcut`,',
    '  `window.handleAccessRequestSubmit`',
    '- `public/components.js` — defines `window.UI`',
    '- Each dashboard HTML page in `public/` includes both via explicit',
    '  `<script>` tags; this smoke catches a missing tag on any of them.',
  ];
  const outPath = path.join(dir, 'window-ui-smoke.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/window-ui-smoke.md`);
}

main();
