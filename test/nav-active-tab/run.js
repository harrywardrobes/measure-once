'use strict';
const { makeSkip } = require('../helpers/report');
// test/nav-active-tab/run.js
//
// Regression guard for the matchPath prefix-route logic in BottomNav.tsx.
//
// Covers:
//   [CUST-LIST]     /customers (full page load) → #bnav-customers in primary bar
//                   has Mui-selected. More is NOT active (customers is primary).
//   [CUST-DETAIL]   /customers/:id (full page load) → same: bnav-customers selected
//                   in bar directly. Guards the matchPath prefix-route fix.
//   [CUST-PS]       history.pushState /customers → /customers/:id → bnav-customers
//                   stays selected; push to / → deselects.
//   [PROJ-BAR]      /projects (full page load) → #bnav-projects (primary bar item)
//                   has Mui-selected; More is NOT active.
//   [PROJ-PS]       pushState /projects → /projects/:id → #bnav-projects stays
//                   selected in bar.
//
// Notes:
//   - Customers is a primary bar item for all users. There is no overflow/More
//     path; #bnav-customers is always visible directly in the bar.
//   - There is no Express route for /projects/:id, so [PROJ] uses pushState
//     (same page, no server round-trip) for the sub-route probe.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:nav-active-tab
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:nav-active-tab

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
  page.on('console',   m => pageLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => pageLogs.push(`[pageerror] ${e.message}`));

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
 * Return whether #bnav-<key> in the PRIMARY BAR has data-selected="true", plus
 * the More-active sentinel state. Bar items are always in the DOM inside
 * nav.bottom-nav#main-content.
 */
function readBarTabState(page, key) {
  return page.evaluate((k) => {
    const nav = document.querySelector('nav.bottom-nav#main-content');
    const el  = nav ? nav.querySelector(`#bnav-${k}`) : null;
    const moreEl = nav ? nav.querySelector('#bnav-more') : null;
    return {
      exists: !!el,
      selected: el ? el.getAttribute('data-selected') === 'true' : false,
      morePresent: !!moreEl,
      moreSelected: !!document.querySelector('[data-more-selected]'),
      moreHasMuiSelected: moreEl ? moreEl.getAttribute('data-selected') === 'true' : false,
    };
  }, key);
}

/**
 * Return the active-overflow indicators (More selected sentinel + class).
 * Does not require the drawer to be open.
 */
function readMoreActiveState(page) {
  return page.evaluate(() => {
    const nav    = document.querySelector('nav.bottom-nav#main-content');
    const moreEl = nav ? nav.querySelector('#bnav-more') : null;
    return {
      morePresent: !!moreEl,
      moreSelected: !!document.querySelector('[data-more-selected]'),
      moreHasMuiSelected: moreEl ? moreEl.getAttribute('data-selected') === 'true' : false,
    };
  });
}

/**
 * Push a new pathname without a full page reload and fire a popstate event so
 * the BottomNav popstate listener updates `value`.
 */
async function pushStatePath(page, newPath) {
  await page.evaluate((p) => {
    history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, newPath);
}

/**
 * Wait until #bnav-<key> (in the bar) gains or loses data-selected="true".
 */
async function waitForBarTabSelected(page, key, wantSelected, timeoutMs = 5000) {
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
  console.log(`\n  nav-active-tab — E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  if (!puppeteer) {
    console.error('[nav-active-tab] puppeteer is not installed — cannot run UI probes.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);
  console.log(`  Seeded  member=${users.member.email}`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  const findings = [];
  function record(name, expected, observed, ok) {
    findings.push({ name, expected, observed, ok, skipped: false });
    const mark = ok ? '  ✓' : '  ✗';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
    }
  }
  const skip = makeSkip(findings);

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

  const memberClient = await login(users.member.email, users.member.password);

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
    // [CUST-LIST] Navigate to /customers → Customers tab highlighted in primary bar.
    //
    // Customers is a primary bar item for all users (home, customers, projects
    // all fit within FIT_THRESHOLD = 4). #bnav-customers is always in the DOM
    // and should have data-selected="true" at /customers. More must NOT be active.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [CUST-LIST] /customers → Customers tab highlighted in primary bar');
    {
      const page = await openPage(browser, memberClient.cookie, '/customers');

      const state = await readBarTabState(page, 'customers');
      record(
        '[CUST-LIST] #bnav-customers exists in the primary bar on /customers',
        'exists',
        state ? (state.exists ? 'exists' : 'missing') : 'state null',
        !!(state && state.exists),
      );
      record(
        '[CUST-LIST] #bnav-customers has data-selected="true" on /customers',
        'selected',
        state ? (state.selected ? 'selected' : 'not selected') : 'state null',
        !!(state && state.selected),
      );
      record(
        '[CUST-LIST] [data-more-selected] absent on /customers (primary tab, no overflow)',
        '[data-more-selected] absent',
        state ? (state.moreSelected ? 'present (unexpected)' : 'absent') : 'state null',
        !!(state && !state.moreSelected),
      );
      record(
        '[CUST-LIST] #bnav-more absent from DOM on /customers (allFit=true)',
        '#bnav-more absent',
        state ? (state.morePresent ? 'present (unexpected)' : 'absent') : 'state null',
        !!(state && !state.morePresent),
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [CUST-DETAIL] Navigate to /customers/:id → Customers tab still highlighted.
    // The matchPath() prefix fix must match /customers/<id> to 'customers'.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [CUST-DETAIL] /customers/:id → Customers tab still highlighted in bar');
    {
      // Navigate to the customer-detail page (Express serves customer-detail.html).
      // No real contact data is needed — only the pathname matters for BottomNav.
      const page = await openPage(browser, memberClient.cookie, '/customers/test-contact-id-123');

      const state = await readBarTabState(page, 'customers');
      record(
        '[CUST-DETAIL] #bnav-customers exists in bar on /customers/:id',
        'exists',
        state ? (state.exists ? 'exists' : 'missing') : 'state null',
        !!(state && state.exists),
      );
      record(
        '[CUST-DETAIL] #bnav-customers has data-selected="true" on /customers/:id',
        'selected',
        state ? (state.selected ? 'selected' : 'not selected') : 'state null',
        !!(state && state.selected),
      );
      record(
        '[CUST-DETAIL] [data-more-selected] absent on /customers/:id',
        '[data-more-selected] absent',
        state ? (state.moreSelected ? 'present (unexpected)' : 'absent') : 'state null',
        !!(state && !state.moreSelected),
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [CUST-PS] pushState /customers → /customers/:id → bnav-customers stays
    //           selected. Then push to / → deselects. Exercises the popstate
    //           listener path.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [CUST-PS] pushState /customers → /customers/:id (popstate listener)');
    {
      const page = await openPage(browser, memberClient.cookie, '/customers');

      // Verify starting state: Customers is selected on /customers
      const beforeState = await readBarTabState(page, 'customers');
      record(
        '[CUST-PS] #bnav-customers selected at /customers (pre-pushState)',
        'selected',
        beforeState ? (beforeState.selected ? 'selected' : 'not selected') : 'state null',
        !!(beforeState && beforeState.selected),
      );

      // Push to /customers/:id (prefix sub-route)
      await pushStatePath(page, '/customers/test-contact-id-456');
      const afterDetailSelected = await waitForBarTabSelected(page, 'customers', true, 5000);
      record(
        '[CUST-PS] #bnav-customers remains selected after pushState to /customers/:id',
        'selected',
        afterDetailSelected ? 'selected' : 'not selected',
        afterDetailSelected,
      );

      // Push back to / (primary tab Home) → customers should deselect
      await pushStatePath(page, '/');
      const afterHomeDeselected = await waitForBarTabSelected(page, 'customers', false, 5000);
      record(
        '[CUST-PS] #bnav-customers deselects after pushState to / (home)',
        'not selected',
        afterHomeDeselected ? 'not selected' : 'still selected',
        afterHomeDeselected,
      );

      const homeSelected = await waitForBarTabSelected(page, 'home', true, 5000);
      record(
        '[CUST-PS] #bnav-home gains selected after pushState to /',
        'selected',
        homeSelected ? 'selected' : 'not selected',
        homeSelected,
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [PROJ-BAR] Navigate to /projects → #bnav-projects (primary bar item)
    //            has data-selected="true"; More is NOT active.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [PROJ-BAR] /projects → Projects tab highlighted in primary bar');
    {
      const page = await openPage(browser, memberClient.cookie, '/projects');

      const state = await readBarTabState(page, 'projects');
      record(
        '[PROJ-BAR] #bnav-projects exists in the bar on /projects',
        'exists',
        state ? (state.exists ? 'exists' : 'missing') : 'state null',
        !!(state && state.exists),
      );
      record(
        '[PROJ-BAR] #bnav-projects has data-selected="true" on /projects',
        'selected',
        state ? (state.selected ? 'selected' : 'not selected') : 'state null',
        !!(state && state.selected),
      );
      record(
        '[PROJ-BAR] More tab is NOT active when Projects is a primary bar item',
        '[data-more-selected] absent',
        state ? (state.moreSelected ? 'present (unexpected)' : 'absent') : 'state null',
        !!(state && !state.moreSelected),
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [PROJ-PS] pushState /projects → /projects/:id → #bnav-projects stays
    //           selected. Exercises the prefix-match fix for a bar-item tab.
    // Note: there is no Express route for /projects/:id, so we use pushState
    // (same page, no server round-trip) for the sub-route probe.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [PROJ-PS] pushState /projects → /projects/:id (popstate listener)');
    {
      const page = await openPage(browser, memberClient.cookie, '/projects');

      const beforeState = await readBarTabState(page, 'projects');
      record(
        '[PROJ-PS] #bnav-projects selected at /projects (pre-pushState)',
        'selected',
        beforeState ? (beforeState.selected ? 'selected' : 'not selected') : 'state null',
        !!(beforeState && beforeState.selected),
      );

      await pushStatePath(page, '/projects/some-project-id');

      const afterSelected = await waitForBarTabSelected(page, 'projects', true, 5000);
      record(
        '[PROJ-PS] #bnav-projects remains selected after pushState to /projects/:id',
        'selected',
        afterSelected ? 'selected' : 'not selected',
        afterSelected,
      );

      // Push to an unrelated primary tab (home) — projects should deselect
      await pushStatePath(page, '/');
      const afterHome = await waitForBarTabSelected(page, 'projects', false, 5000);
      record(
        '[PROJ-PS] #bnav-projects loses selected after pushState to /',
        'not selected',
        afterHome ? 'not selected' : 'still selected',
        afterHome,
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

  // ── Report ──────────────────────────────────────────────────────────────────
  const pass    = findings.filter(f => f.ok).length;
  const skipped = findings.filter(f => f.skipped).length;
  const fail    = findings.filter(f => !f.ok && !f.skipped).length;
  console.log(`\n  Results: ${pass} passed, ${skipped} skipped, ${fail} failed`);

  await writeReport(findings, runId);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

async function writeReport(findings, runId) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const pass    = findings.filter(f => f.ok).length;
  const skipped = findings.filter(f => f.skipped).length;
  const fail    = findings.filter(f => !f.ok && !f.skipped).length;
  const lines = [
    '# nav-active-tab — Customers / Projects sub-route highlight regression guard',
    '',
    `- Date    : ${new Date().toISOString()}`,
    `- Run ID  : ${runId}`,
    `- Command : \`npm run test:nav-active-tab\``,
    '',
    '## Summary',
    '',
    `- Passed: ${pass} / ${findings.length}`,
    `- Skipped: ${skipped} / ${findings.length}`,
    `- Failed: ${fail} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|--------|-------|----------|----------|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : '**FAIL**'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **[CUST-LIST]**   /customers full page load → #bnav-customers in primary bar',
    '                    has data-selected="true". More is absent (customers is primary).',
    '- **[CUST-DETAIL]** /customers/:id full page load → same active state in bar.',
    '                    Guards the matchPath prefix-route fix in BottomNav.tsx.',
    '- **[CUST-PS]**     history.pushState /customers → /customers/:id → bnav-customers',
    '                    stays selected; push to / → deselects, home selects.',
    '- **[PROJ-BAR]**    /projects full page load → #bnav-projects (primary bar item)',
    '                    has data-selected="true"; More tab is NOT active.',
    '- **[PROJ-PS]**     pushState /projects → /projects/:id → #bnav-projects stays',
    '                    selected in bar; push to / → deselects.',
    '',
    '## Notes',
    '',
    '- Customers is a primary bar item (allFit=true with FIT_THRESHOLD=4 and the',
    '  current 3–4 tab nav). #bnav-customers is always in the DOM and never requires',
    '  the More drawer to inspect.',
    '- There is no Express route for /projects/:id, so PROJ uses pushState',
    '  (same page, no server round-trip) for the sub-route probe.',
    '',
    '## Relevant files',
    '',
    '- `src/react/components/BottomNav.tsx` (matchPath, NAV array)',
  ];
  const outPath = path.join(dir, 'nav-active-tab.md');
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`  Report: test-results/nav-active-tab.md`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(2);
});
