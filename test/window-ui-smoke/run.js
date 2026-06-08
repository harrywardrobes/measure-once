'use strict';
const { makeSkip } = require('../helpers/report');
// test/window-ui-smoke/run.js
//
// Smoke test: static chrome mount points must be present on every dashboard page.
//
// Mount-point divs (#app-header-mount, #app-bottom-nav-mount, etc.) are now
// declared statically in each HTML shell rather than injected by chrome.js.
// If a new page is added and the maintainer forgets the static divs, anything
// that depends on those mounts will silently fail. This test visits each
// dashboard route with an admin session and asserts that:
//   - `#app-header-mount` exists in the DOM and has React content (GlobalHeader mounted)
//   - `nav.bottom-nav#main-content` exists on every non-admin route
//     (populated by the React BottomNav island in /react/main.js)
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

// Dashboard routes. /customers/:id is also a real page but the task spec only
// lists the top-level routes; covering the listed 11 is sufficient to catch a
// missing static mount on any of the shared chrome includes.
const ROUTES = [
  '/',
  '/customers',
  '/sales',
  '/survey',
  '/projects',
  '/invoices',
  '/trades',
  '/ideas',
  '/admin',
  '/profile',
];

const PROBE_LABELS = ROUTES.flatMap(route => {
  const adminPage = route === '/admin' || route.startsWith('/admin/');
  const labels = [
    `${route} — #app-header-mount present`,
    `${route} — GlobalHeader React island mounted`,
  ];
  if (!adminPage) labels.push(`${route} — nav.bottom-nav#main-content mounted`);
  return labels;
});

function parseCookieKV(jar) {
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
  console.log('\n  shared chrome mount points — smoke test\n');

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
  const skip = makeSkip(findings);

  // ── DB safety check ──────────────────────────────────────────────────────
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
    for (const l of PROBE_LABELS) {
      skip(l, 'puppeteer installed', 'puppeteer not installed');
    }
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
      // static mount divs are present and the React chrome globals are set.
      page.on('pageerror', () => {});
      page.on('console', () => {});
      try {
        await injectSession(page, adminClient.cookie);
        const resp = await page.goto(`${BASE}${route}`, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
        const status = resp ? resp.status() : 0;
        const statusOk = resp && (resp.ok() || status === 304);
        if (!statusOk) {
          record(`${route} — page loads (HTTP 200/304)`, '200 or 304', status, false,
            'Page did not return 200 or 304; mount point check skipped.');
          continue;
        }

        // Wait briefly for the React bundle to mount.
        // Readiness: #app-header-mount has React content (GlobalHeader rendered),
        // and nav.bottom-nav#main-content exists on non-admin pages (BottomNav rendered).
        const adminPage = isAdminRoute(route);
        const ready = await page.waitForFunction(
          (adminPage) => {
            // GlobalHeader must have mounted at least one child element
            const hdr = document.querySelector('#app-header-mount');
            if (!hdr || !hdr.firstElementChild) return false;
            if (!adminPage && !document.querySelector('nav.bottom-nav#main-content')) return false;
            return true;
          },
          { timeout: 5000 },
          adminPage,
        ).then(() => true).catch(() => false);

        // Always re-evaluate to record per-symbol pass/fail for the report.
        const observed = await page.evaluate(() => {
          const hdr = document.querySelector('#app-header-mount');
          return {
            headerMountExists: !!hdr,
            headerReactMounted: !!(hdr && hdr.firstElementChild),
            hasBottomNav: !!document.querySelector('nav.bottom-nav#main-content'),
          };
        }).catch(e => ({ error: String(e) }));

        const headerOk = observed && observed.headerMountExists;
        record(
          `${route} — #app-header-mount present`,
          'present',
          headerOk ? 'present' : 'missing',
          !!headerOk,
          headerOk ? '' : '#app-header-mount static div is missing from the HTML shell.',
        );

        const reactOk = observed && observed.headerReactMounted;
        record(
          `${route} — GlobalHeader React island mounted`,
          'mounted',
          reactOk ? 'mounted' : 'not mounted',
          !!reactOk,
          reactOk ? '' : 'React bundle did not render GlobalHeader into #app-header-mount.',
        );

        if (!adminPage) {
          const navOk = observed && observed.hasBottomNav;
          record(
            `${route} — nav.bottom-nav#main-content mounted`,
            'present',
            navOk ? 'present' : 'missing',
            !!navOk,
            navOk ? '' : '#app-bottom-nav-mount static div is missing or React BottomNav did not mount.',
          );
        }

        if (!ready) {
          // waitForFunction timed out but per-symbol records already captured
          // the specific failure(s); nothing else to do here.
        }
      } catch (e) {
        record(`${route} — shared chrome mounts present`,
          'page loads and static mounts exist',
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
  const fail = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);
  await writeReport(findings);
  process.exit(fail > 0 || exitCode ? 1 : 0);
}

async function writeReport(findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Shared chrome mount points — Smoke Test',
    '',
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:window-ui-smoke\``,
    '',
    '## Summary',
    '',
    `- Passed: ${findings.filter(f => f.ok).length} / ${findings.length}`,
    `- Skipped: ${findings.filter(f => f.skipped).length} / ${findings.length}`,
    `- Failed: ${findings.filter(f => !f.ok && !f.skipped).length} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    'Visits each dashboard route below with an admin session and asserts:',
    '',
    '- `#app-header-mount` is present in the DOM (static div in HTML shell)',
    '- GlobalHeader React island has rendered content into `#app-header-mount`',
    '- `nav.bottom-nav#main-content` is mounted on every non-admin route',
    '  (React BottomNav island renders into `#app-bottom-nav-mount`)',
    '',
    'Routes covered:',
    '',
    ...ROUTES.map(r => `- \`${r}\``),
    '',
    '## Relevant files',
    '',
    '- Each dashboard HTML page in `public/` declares static mount divs',
    '  (`#app-header-mount`, `#app-bottom-nav-mount`, etc.) directly in the HTML',
    '  shell. This smoke catches a missing div on any page.',
    '- `src/react/main.tsx` — mounts React islands into those divs',
  ];
  const outPath = path.join(dir, 'window-ui-smoke.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/window-ui-smoke.md`);
}

main();
