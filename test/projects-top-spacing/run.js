'use strict';
const { makeSkip } = require('../helpers/report');

const PROBE_LABELS = [
  '[PTS-A] At least 16 px between bottom of #app-header-mount and top of first stage-filter tab',
  '[PTS-B] "Projects" h1 heading is visible above the stage-filter tabs',
];

// test/projects-top-spacing/run.js
//
// Regression test for the Projects page top-spacing fix.
//
// Covers:
//   [PTS-A] At least 16 px (pt: 2 equivalent) of vertical space exists between
//           the bottom of #app-header-mount and the top of the first MuiTab-root
//           inside the stage-filter bar.
//   [PTS-B] A heading element containing the text "Projects" is visible in the
//           viewport above the stage-filter tabs.
//
// Strategy: boots a disposable test server, logs in as admin, navigates to
// /projects, waits for the stage-filter tabs to render, then measures layout
// via getBoundingClientRect().
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:projects-top-spacing
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:projects-top-spacing

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
  __dirname, '..', '..', 'test-results', 'projects-top-spacing.md',
);

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
const skip = makeSkip(findings);

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

async function pollPage(page, fn, timeoutMs = 15000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs, []);
}

// ── report ─────────────────────────────────────────────────────────────────────

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  const lines = [
    '# Projects Top Spacing — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:projects-top-spacing\``,
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
    '- **[PTS-A] Top padding gap**: Navigates to `/projects` as admin, waits for',
    '  `.MuiTab-root` elements inside the stage-filter bar to render, then asserts',
    '  that the gap between the bottom of `#app-header-mount` and the top of the',
    '  first tab is at least 16 px (equivalent to MUI `pt: 2`).',
    '- **[PTS-B] Heading visible**: Asserts that an `h1` element with text',
    '  "Projects" is present in the DOM and its bounding rect top is above the',
    '  top of the first stage-filter tab.',
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
  console.log(`\n  projects-top-spacing  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);
  await cleanupTestData(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}  member=${users.member.email}`);

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

  // ── Login ───────────────────────────────────────────────────────────────────
  const adminClient = await login(users.admin.email, users.admin.password);

  if (!puppeteer) {
    for (const l of PROBE_LABELS) skip(l, 'puppeteer installed', 'puppeteer not installed');
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
    for (const l of PROBE_LABELS) skip(l, 'browser launched', `browser launch failed: ${msg}`);
    await cleanupAndExit(1);
    return;
  }

  try {
    const ctx = await (browser.createBrowserContext
      ? browser.createBrowserContext()
      : browser.createIncognitoBrowserContext());
    const page = await ctx.newPage();
    await page.setCacheEnabled(false);
    await page.setViewport({ width: 390, height: 844 });

    const pageLogs = [];
    page.on('console',   m => pageLogs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', e => pageLogs.push(`[pageerror] ${e.message}`));

    await injectSession(page, adminClient.cookie);
    await page.goto(`${BASE}/projects`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the React island to mount and stage-filter tabs to appear.
    const tabsReady = await pollPage(page, () => {
      const tabs = document.querySelectorAll('[data-testid^="stage-filter-tab-"]');
      return tabs.length > 0 ? 'ok' : null;
    }, 20000);

    if (!tabsReady) {
      console.error('Timed out waiting for .MuiTab-root to appear');
      console.error('Page logs:', pageLogs.slice(-10).join('\n'));
      for (const l of PROBE_LABELS) record(l, 'tabs rendered', 'timed out', false);      await ctx.close().catch(() => {});
      await cleanupAndExit(1);
      return;
    }

    // ── Measure layout ───────────────────────────────────────────────────────
    const layout = await page.evaluate(() => {
      const header = document.querySelector('#app-header-mount');
      const firstTab = document.querySelector('[data-testid^="stage-filter-tab-"]');
      const h1 = document.querySelector('h1');

      if (!header || !firstTab) return null;

      const headerRect  = header.getBoundingClientRect();
      const tabRect     = firstTab.getBoundingClientRect();
      const h1Rect      = h1 ? h1.getBoundingClientRect() : null;
      const h1Text      = h1 ? (h1.textContent || '').trim() : '';

      return {
        headerBottom: headerRect.bottom,
        tabTop:       tabRect.top,
        gap:          tabRect.top - headerRect.bottom,
        h1Top:        h1Rect ? h1Rect.top : null,
        h1Text,
        h1Visible:    h1Rect ? (
          h1Rect.bottom > 0 &&
          h1Rect.top < window.innerHeight &&
          h1Rect.width > 0
        ) : false,
      };
    });

    if (!layout) {
      for (const l of PROBE_LABELS) record(l, 'layout measured', '#app-header-mount or .MuiTab-root missing', false);      await ctx.close().catch(() => {});
      await cleanupAndExit(1);
      return;
    }

    console.log(`  gap=${layout.gap.toFixed(1)}px  headerBottom=${layout.headerBottom.toFixed(1)}  tabTop=${layout.tabTop.toFixed(1)}`);
    console.log(`  h1="${layout.h1Text}"  h1Top=${layout.h1Top !== null ? layout.h1Top.toFixed(1) : 'n/a'}  h1Visible=${layout.h1Visible}`);

    // [PTS-A] Gap check — at least 16 px (MUI pt:2)
    const MIN_GAP = 16;
    record(
      PROBE_LABELS[0],
      `gap >= ${MIN_GAP} px`,
      `gap = ${layout.gap.toFixed(1)} px`,
      layout.gap >= MIN_GAP,
    );

    // [PTS-B] Heading "Projects" visible above the first tab
    const headingOk =
      layout.h1Text === 'Projects' &&
      layout.h1Visible &&
      layout.h1Top !== null &&
      layout.h1Top < layout.tabTop;

    record(
      PROBE_LABELS[1],
      '"Projects" h1 visible and above first tab',
      layout.h1Text
        ? `h1="${layout.h1Text}" visible=${layout.h1Visible} h1Top=${layout.h1Top !== null ? layout.h1Top.toFixed(1) : 'n/a'} tabTop=${layout.tabTop.toFixed(1)}`
        : 'h1 not found',
      headingOk,
    );

    await ctx.close().catch(() => {});

  } catch (e) {
    console.error('Test error:', e);
    console.error('--- server log (last 2000 chars) ---');
    console.error(logBuf.join('').slice(-2000));
  } finally {
    try { await browser.close(); } catch {}
    const failed = findings.filter(f => !f.ok && !f.skipped).length;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);
    await cleanupAndExit(failed === 0 ? 0 : 1);
  }
}

main();
