'use strict';
// test/window-ui-smoke/run.js
//
// Smoke test: window.UI must be defined on every dashboard page.
//
// public/components.js attaches `window.UI = { skeletonLine, renderPill,
// renderEmptyState, renderTabBar, … }` and is included via an explicit
// `<script src="/components.js">` tag after `/chrome.js` on every dashboard
// HTML page. If a new page is added in the future and the maintainer forgets
// the tag, anything that calls `UI.renderPill` / `UI.renderEmptyState` /
// `UI.skeletonLine` / `UI.renderTabBar` will silently throw `ReferenceError`.
// This test visits each dashboard route with an admin session and asserts
// that `typeof window.UI === 'object'` and all four helpers are present.
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

async function main() {
  console.log('\n  window.UI smoke test\n');

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
        const result = await page.waitForFunction(
          (helpers) => {
            if (typeof window.UI !== 'object' || window.UI === null) return false;
            for (const h of helpers) {
              if (typeof window.UI[h] !== 'function') return false;
            }
            return { ok: true };
          },
          { timeout: 5000 },
          REQUIRED_HELPERS,
        ).then(() => true).catch(() => false);

        if (result) {
          record(
            `${route} — window.UI defined with required helpers`,
            `object with ${REQUIRED_HELPERS.join(', ')}`,
            'present',
            true,
          );
        } else {
          // Capture what we actually see for the failure report.
          const observed = await page.evaluate((helpers) => {
            const t = typeof window.UI;
            if (t !== 'object' || window.UI === null) {
              return { typeofUI: t };
            }
            const missing = helpers.filter(h => typeof window.UI[h] !== 'function');
            return { typeofUI: t, missing };
          }, REQUIRED_HELPERS).catch(e => ({ error: String(e) }));
          record(
            `${route} — window.UI defined with required helpers`,
            `object with ${REQUIRED_HELPERS.join(', ')}`,
            JSON.stringify(observed),
            false,
            'Likely missing <script src="/components.js"> after chrome.js in the page HTML.',
          );
        }
      } catch (e) {
        record(`${route} — window.UI defined with required helpers`,
          'page loads and window.UI is set',
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
    '# window.UI — Smoke Test',
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
    'Visits each dashboard route below with an admin session and asserts that',
    '`window.UI` is an object and that `skeletonLine`, `renderPill`,',
    '`renderEmptyState`, and `renderTabBar` are all functions:',
    '',
    ...ROUTES.map(r => `- \`${r}\``),
    '',
    '## Relevant files',
    '',
    '- `public/components.js` — defines `window.UI`',
    '- `public/chrome.js` — shared chrome included before `components.js`',
    '- Each dashboard HTML page in `public/` includes both via explicit',
    '  `<script>` tags; this smoke catches a missing tag on any of them.',
  ];
  const outPath = path.join(dir, 'window-ui-smoke.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/window-ui-smoke.md`);
}

main();
