'use strict';
// test/nav-active-tab/run.js
//
// Regression guard for the matchPath prefix-route logic in BottomNav.tsx.
//
// Covers:
//   [CUST-LIST]     /customers (full page load) → More tab active; open drawer →
//                   #bnav-customers has Mui-selected.
//   [CUST-DETAIL]   /customers/:id (full page load) → same: More active, drawer item selected.
//   [CUST-PS]       history.pushState /customers → /customers/:id → More stays active;
//                   push to / → More deselects.
//   [TRADES-BAR]    /trades (full page load) → #bnav-trades (primary bar item) has Mui-selected,
//                   More is NOT active.
//   [TRADES-PS]     pushState /trades → /trades/:id → #bnav-trades stays selected in bar.
//
// Notes:
//   - MUI Drawer defaults to keepMounted={false}, so overflow items are only
//     in the DOM while the drawer is open. For customers (overflow tab) the
//     probe opens the drawer before inspecting #bnav-customers.
//   - There is no Express route for /trades/:id, so [TRADES] uses pushState
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let got = null;
    try { got = await page.evaluate(fn, arg); } catch {}
    if (got) return got;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
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
 * Return whether #bnav-<key> in the PRIMARY BAR has Mui-selected, plus the
 * More-active state (sentinel + bnav-more class). Bar items are always in
 * the DOM inside nav.bottom-nav#main-content.
 */
function readBarTabState(page, key) {
  return page.evaluate((k) => {
    const nav = document.querySelector('nav.bottom-nav#main-content');
    const el  = nav ? nav.querySelector(`#bnav-${k}`) : null;
    const moreEl = nav ? nav.querySelector('#bnav-more') : null;
    return {
      exists: !!el,
      selected: el ? el.classList.contains('Mui-selected') : false,
      moreSelected: !!document.querySelector('[data-more-selected]'),
      moreHasMuiSelected: moreEl ? moreEl.classList.contains('Mui-selected') : false,
    };
  }, key);
}

/**
 * Open the More drawer and wait until it is visible. Returns true on success.
 */
async function openDrawer(page, timeoutMs = 6000) {
  await page.evaluate(() => {
    const btn = document.querySelector('#bnav-more');
    if (btn) btn.click();
  });
  const ok = await poll(page, () => {
    const paper = document.querySelector('.MuiDrawer-paper');
    if (!paper) return null;
    const rect = paper.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.height > 0 ? 'ok' : null;
  }, null, timeoutMs);
  return ok === 'ok';
}

/**
 * While the More drawer is open, check whether #bnav-<key> is present
 * in the drawer's portal and has Mui-selected.
 * MUI Drawer renders items in a portal once opened (keepMounted defaults to
 * false, so items are only in the DOM while the drawer is visible).
 */
function readDrawerTabSelected(page, key) {
  return page.evaluate((k) => {
    const el = document.querySelector(`#bnav-${k}`);
    return {
      exists: !!el,
      selected: el ? el.classList.contains('Mui-selected') : false,
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
      moreSelected: !!document.querySelector('[data-more-selected]'),
      moreHasMuiSelected: moreEl ? moreEl.classList.contains('Mui-selected') : false,
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
 * Wait until the More sentinel [data-more-selected] is present or absent.
 */
async function waitForMoreActive(page, wantActive, timeoutMs = 5000) {
  const result = await poll(page, (want) => {
    const has = !!document.querySelector('[data-more-selected]');
    return has === want ? 'ok' : null;
  }, wantActive, timeoutMs);
  return result === 'ok';
}

/**
 * Wait until #bnav-<key> (in the bar) gains or loses Mui-selected.
 */
async function waitForBarTabSelected(page, key, wantSelected, timeoutMs = 5000) {
  const result = await poll(page, (args) => {
    const nav = document.querySelector('nav.bottom-nav#main-content');
    const el  = nav ? nav.querySelector(`#bnav-${args.key}`) : null;
    if (!el) return null;
    const has = el.classList.contains('Mui-selected');
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

  const memberClient = await login(users.member.email, users.member.password);

  const executablePath = findChromium();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {

    // ══════════════════════════════════════════════════════════════════════════
    // [CUST-LIST] Navigate to /customers → More tab active; open drawer →
    // #bnav-customers selected.
    //
    // For the default member bar (home, calendar, trades), Customers is an
    // overflow tab. The overflow indicator is the [data-more-selected]
    // sentinel and Mui-selected on #bnav-more.  #bnav-customers only exists
    // in the DOM while the More drawer is open (MUI Drawer keepMounted=false).
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [CUST-LIST] /customers → Customers tab highlighted');
    {
      const page = await openPage(browser, memberClient.cookie, '/customers');

      // Step 1: check More is active (overflow indicator)
      const moreState = await readMoreActiveState(page);
      record(
        '[CUST-LIST] [data-more-selected] present on /customers',
        '[data-more-selected] present',
        moreState ? (moreState.moreSelected ? 'present' : 'absent') : 'state null',
        !!(moreState && moreState.moreSelected),
      );
      record(
        '[CUST-LIST] #bnav-more has Mui-selected on /customers',
        'Mui-selected on bnav-more',
        moreState ? (moreState.moreHasMuiSelected ? 'Mui-selected' : 'not selected') : 'state null',
        !!(moreState && moreState.moreHasMuiSelected),
      );

      // Step 2: open the drawer so the portal renders, then inspect #bnav-customers
      const opened = await openDrawer(page);
      record(
        '[CUST-LIST] More drawer opens',
        'drawer visible',
        opened ? 'visible' : 'not visible',
        opened,
      );

      if (opened) {
        const drawerState = await readDrawerTabSelected(page, 'customers');
        record(
          '[CUST-LIST] #bnav-customers exists in open drawer',
          'exists',
          drawerState.exists ? 'exists' : 'missing',
          drawerState.exists,
        );
        record(
          '[CUST-LIST] #bnav-customers has Mui-selected in open drawer',
          'Mui-selected',
          drawerState.selected ? 'Mui-selected' : 'not selected',
          drawerState.selected,
        );
      } else {
        record('[CUST-LIST] #bnav-customers exists in open drawer',          'exists',       'skipped (drawer did not open)', false);
        record('[CUST-LIST] #bnav-customers has Mui-selected in open drawer','Mui-selected', 'skipped (drawer did not open)', false);
      }

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [CUST-DETAIL] Navigate to /customers/:id → same: More active,
    // #bnav-customers selected in the drawer.
    // The matchPath() prefix fix must match /customers/<id> to 'customers'.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [CUST-DETAIL] /customers/:id → Customers tab still highlighted');
    {
      // Navigate to the customer-detail page (Express serves customer-detail.html).
      // No real contact data is needed — only the pathname matters for BottomNav.
      const page = await openPage(browser, memberClient.cookie, '/customers/test-contact-id-123');

      const moreState = await readMoreActiveState(page);
      record(
        '[CUST-DETAIL] [data-more-selected] present on /customers/:id',
        '[data-more-selected] present',
        moreState ? (moreState.moreSelected ? 'present' : 'absent') : 'state null',
        !!(moreState && moreState.moreSelected),
      );
      record(
        '[CUST-DETAIL] #bnav-more has Mui-selected on /customers/:id',
        'Mui-selected on bnav-more',
        moreState ? (moreState.moreHasMuiSelected ? 'Mui-selected' : 'not selected') : 'state null',
        !!(moreState && moreState.moreHasMuiSelected),
      );

      const opened = await openDrawer(page);
      record(
        '[CUST-DETAIL] More drawer opens on /customers/:id',
        'drawer visible',
        opened ? 'visible' : 'not visible',
        opened,
      );

      if (opened) {
        const drawerState = await readDrawerTabSelected(page, 'customers');
        record(
          '[CUST-DETAIL] #bnav-customers exists in open drawer on /customers/:id',
          'exists',
          drawerState.exists ? 'exists' : 'missing',
          drawerState.exists,
        );
        record(
          '[CUST-DETAIL] #bnav-customers has Mui-selected in drawer on /customers/:id',
          'Mui-selected',
          drawerState.selected ? 'Mui-selected' : 'not selected',
          drawerState.selected,
        );
      } else {
        record('[CUST-DETAIL] #bnav-customers exists in open drawer on /customers/:id',         'exists',       'skipped (drawer did not open)', false);
        record('[CUST-DETAIL] #bnav-customers has Mui-selected in drawer on /customers/:id','Mui-selected', 'skipped (drawer did not open)', false);
      }

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [CUST-PS] pushState /customers → /customers/:id → More stays active.
    // Then push to / → More deselects. Exercises the popstate listener path.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [CUST-PS] pushState /customers → /customers/:id (popstate listener)');
    {
      const page = await openPage(browser, memberClient.cookie, '/customers');

      // Verify starting state: More is active on /customers
      const beforeMore = await readMoreActiveState(page);
      record(
        '[CUST-PS] More active at /customers (pre-pushState)',
        '[data-more-selected] present',
        beforeMore ? (beforeMore.moreSelected ? 'present' : 'absent') : 'state null',
        !!(beforeMore && beforeMore.moreSelected),
      );

      // Push to /customers/:id (prefix sub-route)
      await pushStatePath(page, '/customers/test-contact-id-456');
      const afterDetailMore = await waitForMoreActive(page, true, 5000);
      record(
        '[CUST-PS] More remains active after pushState to /customers/:id',
        '[data-more-selected] present',
        afterDetailMore ? 'present' : 'absent',
        afterDetailMore,
      );

      // Push back to / (primary tab Home) → More should deselect
      await pushStatePath(page, '/');
      const afterHomeMore = await waitForMoreActive(page, false, 5000);
      record(
        '[CUST-PS] More deselects after pushState to / (primary tab)',
        '[data-more-selected] absent',
        afterHomeMore ? 'absent' : 'still present',
        afterHomeMore,
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [TRADES-BAR] Navigate to /trades → #bnav-trades (primary bar item for
    // members) has Mui-selected; More is NOT active.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [TRADES-BAR] /trades → Trades tab highlighted in primary bar');
    {
      const page = await openPage(browser, memberClient.cookie, '/trades');

      const state = await readBarTabState(page, 'trades');
      record(
        '[TRADES-BAR] #bnav-trades exists in the bar on /trades',
        'exists',
        state ? (state.exists ? 'exists' : 'missing') : 'state null',
        !!(state && state.exists),
      );
      record(
        '[TRADES-BAR] #bnav-trades has Mui-selected on /trades',
        'Mui-selected',
        state ? (state.selected ? 'Mui-selected' : 'not selected') : 'state null',
        !!(state && state.selected),
      );
      record(
        '[TRADES-BAR] More tab is NOT active when Trades is a primary bar item',
        '[data-more-selected] absent',
        state ? (state.moreSelected ? 'present (unexpected)' : 'absent') : 'state null',
        !!(state && !state.moreSelected),
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [TRADES-PS] pushState /trades → /trades/:id → #bnav-trades stays
    // selected. Exercises the prefix-match fix for a bar-item tab.
    // Note: there is no Express route for /trades/:id, so we use pushState
    // (same page, no server round-trip) for the sub-route probe.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [TRADES-PS] pushState /trades → /trades/:id (popstate listener)');
    {
      const page = await openPage(browser, memberClient.cookie, '/trades');

      const beforeState = await readBarTabState(page, 'trades');
      record(
        '[TRADES-PS] #bnav-trades selected at /trades (pre-pushState)',
        'Mui-selected',
        beforeState ? (beforeState.selected ? 'Mui-selected' : 'not selected') : 'state null',
        !!(beforeState && beforeState.selected),
      );

      await pushStatePath(page, '/trades/some-trade-id');

      const afterSelected = await waitForBarTabSelected(page, 'trades', true, 5000);
      record(
        '[TRADES-PS] #bnav-trades remains Mui-selected after pushState to /trades/:id',
        'Mui-selected',
        afterSelected ? 'Mui-selected' : 'not selected',
        afterSelected,
      );

      // Push to an unrelated primary tab (home) — trades should deselect
      await pushStatePath(page, '/');
      const afterHome = await waitForBarTabSelected(page, 'trades', false, 5000);
      record(
        '[TRADES-PS] #bnav-trades loses Mui-selected after pushState to /',
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
    '# nav-active-tab — Customers / Trades sub-route highlight regression guard',
    '',
    `- Date    : ${new Date().toISOString()}`,
    `- Run ID  : ${runId}`,
    `- Command : \`npm run test:nav-active-tab\``,
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
    '- **[CUST-LIST]**   /customers full page load → More tab active (overflow indicator)',
    '                    + open drawer → #bnav-customers has Mui-selected.',
    '- **[CUST-DETAIL]** /customers/:id full page load → same active state.',
    '                    Guards the matchPath prefix-route fix in BottomNav.tsx.',
    '- **[CUST-PS]**     history.pushState /customers → /customers/:id → More stays',
    '                    active; push to / → More deselects.',
    '- **[TRADES-BAR]**  /trades full page load → #bnav-trades (primary bar item)',
    '                    has Mui-selected; More tab is NOT active.',
    '- **[TRADES-PS]**   pushState /trades → /trades/:id → #bnav-trades stays',
    '                    selected in bar; push to / → deselects.',
    '',
    '## Notes',
    '',
    '- MUI Drawer uses keepMounted=false by default, so #bnav-customers is only',
    '  in the DOM while the drawer is open. The CUST-* probes open the drawer',
    '  before inspecting the element.',
    '- There is no Express route for /trades/:id, so TRADES uses pushState',
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
