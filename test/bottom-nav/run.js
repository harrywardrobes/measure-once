'use strict';
// test/bottom-nav/run.js
//
// End-to-end test for the bottom navigation bar with the current four-tab nav.
// Verifies:
//
//   [M-BAR]  Member bar shows Home, Customers, Projects — all three visible tabs
//            render directly in the bar; NO "More" button present.
//   [MG-BAR] Manager bar shows Home, Customers, Projects, Invoices — all four
//            visible tabs render directly; NO "More" button present.
//   [M-ACT]  Member active-tab highlight: Home at /, Customers at /customers,
//            Projects at /projects.
//   [MG-ACT] Manager Invoices tab highlights directly in the bar when at
//            /invoices — no "More" overflow needed.
//
// With FIT_THRESHOLD = 4 and the current nav having at most 4 items, allFit is
// always true so the primary/overflow split and "More" button are never shown.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:bottom-nav
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:bottom-nav

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

// ── helpers ───────────────────────────────────────────────────────────────────

function findChromium() {
  const { findChromium: shared } = require('../shared/find-chromium');
  return shared() || undefined;
}

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

async function poll(page, fn, arg, timeoutMs = 8000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
}

/**
 * Open the given URL in a fresh incognito context, inject the session cookie,
 * and wait for the BottomNav React island to mount (#bnav-home visible in the
 * nav container).
 */
async function openPage(browser, jar, url) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

  const pageLogs = [];
  page.on('console',       m => pageLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror',     e => pageLogs.push(`[pageerror] ${e.message}`));

  await injectSession(page, jar);
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: 25000 });

  // Wait for BottomNav to mount — #bnav-home inside nav.bottom-nav#main-content
  await poll(page, () => {
    const nav = document.querySelector('nav.bottom-nav#main-content');
    return nav && nav.querySelector('#bnav-home') ? 'ok' : null;
  }, null, 15000);

  page.__logs = pageLogs;
  return page;
}

/**
 * Read which named tab ids are present in the primary bar and whether the
 * "More" button is present.
 */
function readBarState(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('nav.bottom-nav#main-content');
    if (!nav) return null;
    const inBar = id => !!nav.querySelector(`#${id}`);
    return {
      home:      inBar('bnav-home'),
      customers: inBar('bnav-customers'),
      projects:  inBar('bnav-projects'),
      invoices:  inBar('bnav-invoices'),
      more:      inBar('bnav-more'),
    };
  });
}

/**
 * Return the data-selected state of a given bar tab and whether More is active.
 */
function readBarTabState(page, key) {
  return page.evaluate((k) => {
    const nav   = document.querySelector('nav.bottom-nav#main-content');
    const el    = nav ? nav.querySelector(`#bnav-${k}`) : null;
    const moreEl = nav ? nav.querySelector('#bnav-more') : null;
    return {
      exists:   !!el,
      selected: el ? el.getAttribute('data-selected') === 'true' : false,
      morePresent: !!moreEl,
      moreSelected: !!document.querySelector('[data-more-selected]'),
    };
  }, key);
}

/**
 * Wait until #bnav-<key> gains or loses data-selected="true".
 */
async function waitForTabSelected(page, key, wantSelected, timeoutMs = 5000) {
  const result = await poll(page, (args) => {
    const nav = document.querySelector('nav.bottom-nav#main-content');
    const el  = nav ? nav.querySelector(`#bnav-${args.key}`) : null;
    if (!el) return null;
    const has = el.getAttribute('data-selected') === 'true';
    return has === args.want ? 'ok' : null;
  }, { key, want: wantSelected }, timeoutMs);
  return result === 'ok';
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
  console.log(`\n  bottom-nav flat-nav — E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  if (!puppeteer) {
    console.error('[bottom-nav] puppeteer is not installed — cannot run UI probes.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);
  console.log(`  Seeded  member=${users.member.email}  manager=${users.manager.email}`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

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
  process.on('uncaughtException',  (e) => { console.error('Uncaught:',  e); cleanupAndExit(2); });
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

  const memberClient  = await login(users.member.email,  users.member.password);
  const managerClient = await login(users.manager.email, users.manager.password);

  const executablePath = findChromium();
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (launchErr) {
    console.error(`  Could not launch browser: ${launchErr.message}`);
    await cleanupAndExit(1);
    return;
  }

  try {

    // ══════════════════════════════════════════════════════════════════════════
    // [M-BAR] Member bar layout: Home + Customers + Projects, no More
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [M-BAR] Member bottom bar');
    {
      const page = await openPage(browser, memberClient.cookie, '/');
      const bar = await readBarState(page);

      record(
        '[M-BAR] Home in member bar',
        'bnav-home present in nav',
        bar ? (bar.home ? 'present' : 'missing') : 'bar state null',
        !!(bar && bar.home),
      );
      record(
        '[M-BAR] Customers in member bar',
        'bnav-customers present in nav',
        bar ? (bar.customers ? 'present' : 'missing') : 'bar state null',
        !!(bar && bar.customers),
      );
      record(
        '[M-BAR] Projects in member bar',
        'bnav-projects present in nav',
        bar ? (bar.projects ? 'present' : 'missing') : 'bar state null',
        !!(bar && bar.projects),
      );
      record(
        '[M-BAR] Invoices NOT in member bar (manager-only)',
        'bnav-invoices absent from nav',
        bar ? (bar.invoices ? 'present' : 'absent') : 'bar state null',
        !!(bar && !bar.invoices),
      );
      record(
        '[M-BAR] More button NOT present for member (all tabs fit)',
        'bnav-more absent from nav',
        bar ? (bar.more ? 'present' : 'absent') : 'bar state null',
        !!(bar && !bar.more),
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [MG-BAR] Manager bar layout: Home + Customers + Projects + Invoices, no More
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [MG-BAR] Manager bottom bar');
    {
      const page = await openPage(browser, managerClient.cookie, '/');
      const bar = await readBarState(page);

      record(
        '[MG-BAR] Home in manager bar',
        'bnav-home present in nav',
        bar ? (bar.home ? 'present' : 'missing') : 'bar state null',
        !!(bar && bar.home),
      );
      record(
        '[MG-BAR] Customers in manager bar',
        'bnav-customers present in nav',
        bar ? (bar.customers ? 'present' : 'missing') : 'bar state null',
        !!(bar && bar.customers),
      );
      record(
        '[MG-BAR] Projects in manager bar',
        'bnav-projects present in nav',
        bar ? (bar.projects ? 'present' : 'missing') : 'bar state null',
        !!(bar && bar.projects),
      );
      record(
        '[MG-BAR] Invoices in manager bar (manager-only tab)',
        'bnav-invoices present in nav',
        bar ? (bar.invoices ? 'present' : 'missing') : 'bar state null',
        !!(bar && bar.invoices),
      );
      record(
        '[MG-BAR] More button NOT present for manager (all 4 tabs fit within threshold)',
        'bnav-more absent from nav',
        bar ? (bar.more ? 'present' : 'absent') : 'bar state null',
        !!(bar && !bar.more),
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [M-ACT] Member active-tab highlights: /, /customers, /projects
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [M-ACT] Member active-tab highlights');
    {
      // Home at /
      {
        const page = await openPage(browser, memberClient.cookie, '/');
        const state = await readBarTabState(page, 'home');
        record(
          '[M-ACT] #bnav-home has data-selected="true" at /',
          'selected',
          state ? (state.selected ? 'selected' : 'not selected') : 'state null',
          !!(state && state.selected),
        );
        record(
          '[M-ACT] [data-more-selected] absent at / (primary tab)',
          'absent',
          state ? (state.moreSelected ? 'present (unexpected)' : 'absent') : 'state null',
          !!(state && !state.moreSelected),
        );
        await page.close().catch(() => {});
        await page.__ctx.close().catch(() => {});
      }

      // Customers at /customers
      {
        const page = await openPage(browser, memberClient.cookie, '/customers');
        const state = await readBarTabState(page, 'customers');
        record(
          '[M-ACT] #bnav-customers has data-selected="true" at /customers',
          'selected',
          state ? (state.selected ? 'selected' : 'not selected') : 'state null',
          !!(state && state.selected),
        );
        record(
          '[M-ACT] [data-more-selected] absent at /customers (primary tab)',
          'absent',
          state ? (state.moreSelected ? 'present (unexpected)' : 'absent') : 'state null',
          !!(state && !state.moreSelected),
        );
        await page.close().catch(() => {});
        await page.__ctx.close().catch(() => {});
      }

      // Projects at /projects
      {
        const page = await openPage(browser, memberClient.cookie, '/projects');
        const state = await readBarTabState(page, 'projects');
        record(
          '[M-ACT] #bnav-projects has data-selected="true" at /projects',
          'selected',
          state ? (state.selected ? 'selected' : 'not selected') : 'state null',
          !!(state && state.selected),
        );
        record(
          '[M-ACT] [data-more-selected] absent at /projects (primary tab)',
          'absent',
          state ? (state.moreSelected ? 'present (unexpected)' : 'absent') : 'state null',
          !!(state && !state.moreSelected),
        );
        await page.close().catch(() => {});
        await page.__ctx.close().catch(() => {});
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [MG-ACT] Manager Invoices highlights directly in bar at /invoices;
    //          no "More" overflow needed. Navigating to a different primary tab
    //          deselects Invoices.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [MG-ACT] Manager active-tab: /invoices highlights Invoices directly');
    {
      const page = await openPage(browser, managerClient.cookie, '/invoices');

      const state = await readBarTabState(page, 'invoices');
      record(
        '[MG-ACT] #bnav-invoices has data-selected="true" at /invoices',
        'selected',
        state ? (state.selected ? 'selected' : 'not selected') : 'state null',
        !!(state && state.selected),
      );
      record(
        '[MG-ACT] [data-more-selected] absent at /invoices (primary tab, no overflow)',
        'absent',
        state ? (state.moreSelected ? 'present (unexpected)' : 'absent') : 'state null',
        !!(state && !state.moreSelected),
      );
      record(
        '[MG-ACT] More button absent at /invoices (allFit=true)',
        'bnav-more absent',
        state ? (state.morePresent ? 'present (unexpected)' : 'absent') : 'state null',
        !!(state && !state.morePresent),
      );

      // Push to / (home) and verify Invoices deselects
      await page.evaluate(() => {
        history.pushState({}, '', '/');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      const invoicesDeselected = await waitForTabSelected(page, 'invoices', false, 5000);
      record(
        '[MG-ACT] #bnav-invoices loses data-selected after pushState to /',
        'not selected',
        invoicesDeselected ? 'not selected' : 'still selected',
        invoicesDeselected,
      );

      const homeSelected = await waitForTabSelected(page, 'home', true, 5000);
      record(
        '[MG-ACT] #bnav-home becomes selected after pushState to /',
        'selected',
        homeSelected ? 'selected' : 'not selected',
        homeSelected,
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

  } catch (e) {
    record('test harness', 'no uncaught error', `error: ${e.message}`, false);
    console.error(e);
  } finally {
    await browser.close().catch(() => {});
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);

  await writeReport(findings, runId);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

async function writeReport(findings, runId) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  const lines = [
    '# bottom-nav flat-nav — E2E',
    '',
    `- Date    : ${new Date().toISOString()}`,
    `- Run ID  : ${runId}`,
    `- Command : \`npm run test:bottom-nav\``,
    '',
    '## Summary',
    '',
    `- Passed: ${pass} / ${findings.length}`,
    `- Failed: ${fail} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|--------|-------|----------|----------|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : '**FAIL**'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **[M-BAR]**  Member bar renders Home + Customers + Projects directly; no "More"',
    '              button. Invoices (manager-only) is absent.',
    '- **[MG-BAR]** Manager bar renders Home + Customers + Projects + Invoices directly;',
    '              no "More" button. FIT_THRESHOLD=4 means all 4 tabs fit.',
    '- **[M-ACT]**  Active-tab highlight works for each primary tab in the member bar:',
    '              Home at /, Customers at /customers, Projects at /projects.',
    '- **[MG-ACT]** Invoices highlights directly in the manager bar at /invoices;',
    '              [data-more-selected] is absent and #bnav-more is not in the DOM.',
    '              pushState to / deselects Invoices and selects Home.',
    '',
    '## Relevant files',
    '',
    '- `src/react/components/BottomNav.tsx`',
    '- `src/react/hooks/usePrivilege.ts`',
  ];
  const outPath = path.join(dir, 'bottom-nav.md');
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`  Report: test-results/bottom-nav.md`);
}

main();
