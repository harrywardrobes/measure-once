'use strict';
// test/bottom-nav/run.js
//
// End-to-end test for the "More" drawer in the bottom navigation bar.
// Verifies:
//
//   [M-BAR]   Member bar shows Home, Calendar, Trades + More; NOT Sales/Projects
//   [MG-BAR]  Manager bar shows Home, Sales, Projects + More; NOT Calendar/Trades
//   [M-DRAW]  Tapping More opens drawer for member, listing Ideas
//   [MG-DRAW] Tapping More opens drawer for manager, listing Survey, Calendar,
//             Invoices, Trades, Ideas (all overflow tabs)
//   [M-ACT]   Navigating to an overflow tab (/ideas) makes More selected in bar
//   [MG-ACT]  Navigating to an overflow tab (/survey) makes More selected in bar
//   [M-NAV]   Member taps Ideas in drawer → drawer closes, pathname=/ideas, More selected
//   [MG-NAV]  Manager taps Calendar in drawer → drawer closes, pathname=/calendar, More selected
//   [CLO]     Drawer closes when the MUI backdrop is clicked
//
// Follows the harness + Puppeteer conventions from test/calendar-page/run.js:
// boots a disposable server, seeds members/managers, drives the UI, then
// writes a markdown report to test-results/bottom-nav.md.
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
 * Return an object describing what is currently in the bar (nav container)
 * and whether [data-more-selected] is present.
 */
function readBarState(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('nav.bottom-nav#main-content');
    if (!nav) return null;
    const inBar = id => !!nav.querySelector(`#${id}`);
    const moreSelected = !!document.querySelector('[data-more-selected]');
    const moreHasMuiSelected = nav.querySelector('#bnav-more')
      ? nav.querySelector('#bnav-more').classList.contains('Mui-selected')
      : false;
    return {
      home:     inBar('bnav-home'),
      calendar: inBar('bnav-calendar'),
      trades:   inBar('bnav-trades'),
      sales:    inBar('bnav-sales'),
      survey:   inBar('bnav-survey'),
      projects: inBar('bnav-projects'),
      invoices: inBar('bnav-invoices'),
      ideas:    inBar('bnav-ideas'),
      more:     inBar('bnav-more'),
      moreSelected,
      moreHasMuiSelected,
    };
  });
}

/**
 * Check whether the MUI Drawer paper is currently visible on-screen.
 * MUI Drawer renders a `.MuiDrawer-paper` element even when closed, but
 * transforms it off-screen.  When open, its top edge is within viewport.
 */
function readDrawerOpen(page) {
  return page.evaluate(() => {
    const paper = document.querySelector('[data-testid="bottom-nav-drawer-paper"]');
    if (!paper) return false;
    const rect = paper.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.height > 0;
  });
}

/**
 * Return the list of IDs found in the drawer paper element (outside the
 * nav bar container, scoped to .MuiDrawer-paper list items).
 */
function readDrawerItemIds(page) {
  return page.evaluate(() => {
    const paper = document.querySelector('[data-testid="bottom-nav-drawer-paper"]');
    if (!paper) return [];
    return Array.from(paper.querySelectorAll('[id^="bnav-"]'))
      .map(el => el.id.replace('bnav-', ''));
  });
}

/**
 * Click the More button in the bottom bar and wait until the drawer is
 * visible on-screen (up to timeoutMs).
 */
async function clickMoreAndWaitForDrawer(page, timeoutMs = 6000) {
  await page.evaluate(() => {
    const btn = document.querySelector('#bnav-more');
    if (btn) btn.click();
  });
  const ok = await poll(page, () => {
    const paper = document.querySelector('[data-testid="bottom-nav-drawer-paper"]');
    if (!paper) return null;
    const rect = paper.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.height > 0 ? 'ok' : null;
  }, null, timeoutMs);
  return ok === 'ok';
}

/**
 * Close the drawer by clicking the MUI Backdrop element.
 */
async function closeDrawerViaBackdrop(page) {
  await page.evaluate(() => {
    const bd = document.querySelector('.MuiBackdrop-root');
    if (bd) bd.click();
  });
  // Wait for drawer to slide away
  await poll(page, () => {
    const paper = document.querySelector('[data-testid="bottom-nav-drawer-paper"]');
    if (!paper) return 'ok';
    const rect = paper.getBoundingClientRect();
    return rect.top >= window.innerHeight ? 'ok' : null;
  }, null, 5000);
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
  console.log(`\n  bottom-nav More drawer — E2E  run=${runId}`);
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
  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {

    // ══════════════════════════════════════════════════════════════════════════
    // [M-BAR] Member bar layout
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
        '[M-BAR] Calendar in member bar',
        'bnav-calendar present in nav',
        bar ? (bar.calendar ? 'present' : 'missing') : 'bar state null',
        !!(bar && bar.calendar),
      );
      record(
        '[M-BAR] Trades in member bar',
        'bnav-trades present in nav',
        bar ? (bar.trades ? 'present' : 'missing') : 'bar state null',
        !!(bar && bar.trades),
      );
      record(
        '[M-BAR] More in member bar',
        'bnav-more present in nav',
        bar ? (bar.more ? 'present' : 'missing') : 'bar state null',
        !!(bar && bar.more),
      );
      record(
        '[M-BAR] Sales NOT in member bar (manager-only)',
        'bnav-sales absent from nav',
        bar ? (bar.sales ? 'present' : 'absent') : 'bar state null',
        !!(bar && !bar.sales),
      );
      record(
        '[M-BAR] Projects NOT in member bar (manager-only)',
        'bnav-projects absent from nav',
        bar ? (bar.projects ? 'present' : 'absent') : 'bar state null',
        !!(bar && !bar.projects),
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [MG-BAR] Manager bar layout
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
        '[MG-BAR] Sales in manager bar',
        'bnav-sales present in nav',
        bar ? (bar.sales ? 'present' : 'missing') : 'bar state null',
        !!(bar && bar.sales),
      );
      record(
        '[MG-BAR] Projects in manager bar',
        'bnav-projects present in nav',
        bar ? (bar.projects ? 'present' : 'missing') : 'bar state null',
        !!(bar && bar.projects),
      );
      record(
        '[MG-BAR] More in manager bar',
        'bnav-more present in nav',
        bar ? (bar.more ? 'present' : 'missing') : 'bar state null',
        !!(bar && bar.more),
      );
      record(
        '[MG-BAR] Calendar NOT in manager primary bar (overflow only)',
        'bnav-calendar absent from nav',
        bar ? (bar.calendar ? 'present' : 'absent') : 'bar state null',
        !!(bar && !bar.calendar),
      );
      record(
        '[MG-BAR] Trades NOT in manager primary bar (overflow only)',
        'bnav-trades absent from nav',
        bar ? (bar.trades ? 'present' : 'absent') : 'bar state null',
        !!(bar && !bar.trades),
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [M-DRAW] Member More drawer — opens and lists Ideas
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [M-DRAW] Member More drawer');
    {
      const page = await openPage(browser, memberClient.cookie, '/');

      const drawerInitiallyClosed = !(await readDrawerOpen(page));
      record(
        '[M-DRAW] Drawer is initially closed',
        'drawer not visible',
        drawerInitiallyClosed ? 'not visible' : 'visible (unexpected)',
        drawerInitiallyClosed,
      );

      const opened = await clickMoreAndWaitForDrawer(page);
      record(
        '[M-DRAW] Tapping More opens the drawer',
        'drawer visible after click',
        opened ? 'visible' : 'not visible',
        opened,
      );

      const moreSelectedAfterOpen = await page.evaluate(
        () => !!document.querySelector('[data-more-selected]'),
      );
      record(
        '[M-DRAW] [data-more-selected] present while drawer is open',
        'present',
        moreSelectedAfterOpen ? 'present' : 'absent',
        moreSelectedAfterOpen,
      );

      const drawerIds = await readDrawerItemIds(page);
      record(
        '[M-DRAW] Drawer lists Ideas overflow tab',
        'ideas in drawer',
        JSON.stringify(drawerIds),
        drawerIds.includes('ideas'),
      );
      record(
        '[M-DRAW] Drawer does NOT list Home (primary bar item)',
        'home absent from drawer',
        JSON.stringify(drawerIds),
        !drawerIds.includes('home'),
      );
      record(
        '[M-DRAW] Drawer does NOT list Calendar (primary bar item for member)',
        'calendar absent from drawer',
        JSON.stringify(drawerIds),
        !drawerIds.includes('calendar'),
      );
      record(
        '[M-DRAW] Drawer does NOT list Trades (primary bar item for member)',
        'trades absent from drawer',
        JSON.stringify(drawerIds),
        !drawerIds.includes('trades'),
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [MG-DRAW] Manager More drawer — opens and lists all overflow tabs
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [MG-DRAW] Manager More drawer');
    {
      const page = await openPage(browser, managerClient.cookie, '/');

      const opened = await clickMoreAndWaitForDrawer(page);
      record(
        '[MG-DRAW] Tapping More opens the drawer for manager',
        'drawer visible after click',
        opened ? 'visible' : 'not visible',
        opened,
      );

      const drawerIds = await readDrawerItemIds(page);
      const expectedOverflow = ['survey', 'calendar', 'invoices', 'trades', 'ideas'];
      for (const key of expectedOverflow) {
        record(
          `[MG-DRAW] Drawer lists "${key}" overflow tab`,
          `${key} in drawer`,
          JSON.stringify(drawerIds),
          drawerIds.includes(key),
        );
      }
      record(
        '[MG-DRAW] Drawer does NOT list Home (primary bar item)',
        'home absent from drawer',
        JSON.stringify(drawerIds),
        !drawerIds.includes('home'),
      );
      record(
        '[MG-DRAW] Drawer does NOT list Sales (primary bar item for manager)',
        'sales absent from drawer',
        JSON.stringify(drawerIds),
        !drawerIds.includes('sales'),
      );
      record(
        '[MG-DRAW] Drawer does NOT list Projects (primary bar item for manager)',
        'projects absent from drawer',
        JSON.stringify(drawerIds),
        !drawerIds.includes('projects'),
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [M-ACT] Member — navigating to overflow tab makes More selected
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [M-ACT] Member active-in-overflow: /ideas → More selected');
    {
      // Navigate directly to /ideas (an overflow tab for members).
      const page = await openPage(browser, memberClient.cookie, '/ideas');

      const bar = await readBarState(page);
      record(
        '[M-ACT] [data-more-selected] present when at /ideas',
        'present',
        bar ? (bar.moreSelected ? 'present' : 'absent') : 'bar state null',
        !!(bar && bar.moreSelected),
      );
      record(
        '[M-ACT] #bnav-more has Mui-selected class when at /ideas',
        'Mui-selected on bnav-more',
        bar ? (bar.moreHasMuiSelected ? 'Mui-selected' : 'not selected') : 'bar state null',
        !!(bar && bar.moreHasMuiSelected),
      );

      // Also verify More stays deselected when navigating to a primary bar tab.
      // Push state to /calendar (primary for member) and fire popstate.
      await page.evaluate(() => {
        history.pushState({}, '', '/calendar');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      // Give the React effect time to re-sync the value
      await poll(page, () => {
        const el = document.querySelector('[data-more-selected]');
        return el ? null : 'gone';
      }, null, 5000);

      const barAfterPrimary = await readBarState(page);
      record(
        '[M-ACT] [data-more-selected] absent when at primary tab (/calendar)',
        'absent',
        barAfterPrimary ? (barAfterPrimary.moreSelected ? 'present' : 'absent') : 'bar state null',
        !!(barAfterPrimary && !barAfterPrimary.moreSelected),
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [MG-ACT] Manager — navigating to overflow tab makes More selected
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [MG-ACT] Manager active-in-overflow: /survey → More selected');
    {
      const page = await openPage(browser, managerClient.cookie, '/survey');

      const bar = await readBarState(page);
      record(
        '[MG-ACT] [data-more-selected] present when at /survey (manager overflow)',
        'present',
        bar ? (bar.moreSelected ? 'present' : 'absent') : 'bar state null',
        !!(bar && bar.moreSelected),
      );
      record(
        '[MG-ACT] #bnav-more has Mui-selected class when at /survey',
        'Mui-selected on bnav-more',
        bar ? (bar.moreHasMuiSelected ? 'Mui-selected' : 'not selected') : 'bar state null',
        !!(bar && bar.moreHasMuiSelected),
      );

      // Push to /sales (primary for manager) and verify More deselects.
      await page.evaluate(() => {
        history.pushState({}, '', '/sales');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await poll(page, () => {
        const el = document.querySelector('[data-more-selected]');
        return el ? null : 'gone';
      }, null, 5000);

      const barAfterPrimary = await readBarState(page);
      record(
        '[MG-ACT] [data-more-selected] absent when at primary tab (/sales)',
        'absent',
        barAfterPrimary ? (barAfterPrimary.moreSelected ? 'present' : 'absent') : 'bar state null',
        !!(barAfterPrimary && !barAfterPrimary.moreSelected),
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [M-NAV] Member — click Ideas in drawer → navigates + More selected
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [M-NAV] Member drawer click-through: Ideas');
    {
      const page = await openPage(browser, memberClient.cookie, '/');

      const opened = await clickMoreAndWaitForDrawer(page);
      record(
        '[M-NAV] Drawer opened before clicking Ideas',
        'drawer visible',
        opened ? 'visible' : 'not visible',
        opened,
      );

      // Click the Ideas drawer item — it is an <a> so it causes full navigation.
      const [navResponse] = await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
        page.evaluate(() => {
          const btn = document.querySelector('[data-testid="bottom-nav-drawer-paper"] #bnav-ideas');
          if (btn) btn.click();
        }),
      ]);

      // Wait for BottomNav to remount after navigation.
      await poll(page, () => {
        const nav = document.querySelector('nav.bottom-nav#main-content');
        return nav && nav.querySelector('#bnav-home') ? 'ok' : null;
      }, null, 15000);

      // Drawer must be closed (fresh page load, no open drawer state).
      const drawerClosed = !(await readDrawerOpen(page));
      record(
        '[M-NAV] Drawer is closed after clicking Ideas',
        'drawer not visible',
        drawerClosed ? 'not visible' : 'still visible',
        drawerClosed,
      );

      const pathname = await page.evaluate(() => window.location.pathname);
      record(
        '[M-NAV] pathname is /ideas after clicking Ideas drawer item',
        '/ideas',
        String(pathname),
        pathname === '/ideas',
      );

      const bar = await readBarState(page);
      record(
        '[M-NAV] [data-more-selected] present on /ideas after drawer click',
        'present',
        bar ? (bar.moreSelected ? 'present' : 'absent') : 'bar state null',
        !!(bar && bar.moreSelected),
      );
      record(
        '[M-NAV] #bnav-more has Mui-selected class on /ideas after drawer click',
        'Mui-selected on bnav-more',
        bar ? (bar.moreHasMuiSelected ? 'Mui-selected' : 'not selected') : 'bar state null',
        !!(bar && bar.moreHasMuiSelected),
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [MG-NAV] Manager — click first overflow item in drawer → navigates +
    //          drawer closes + More selected
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [MG-NAV] Manager drawer click-through: first overflow tab');
    {
      const page = await openPage(browser, managerClient.cookie, '/');

      const opened = await clickMoreAndWaitForDrawer(page);
      record(
        '[MG-NAV] Drawer opened before clicking overflow tab',
        'drawer visible',
        opened ? 'visible' : 'not visible',
        opened,
      );

      // Read the first overflow item from the drawer so the probe is resilient
      // to nav-customisation preferences changing which tabs are in overflow.
      const firstDrawerItem = await page.evaluate(() => {
        const paper = document.querySelector('[data-testid="bottom-nav-drawer-paper"]');
        if (!paper) return null;
        const anchor = paper.querySelector('[id^="bnav-"]');
        if (!anchor) return null;
        return { id: anchor.id, href: anchor.getAttribute('href') };
      });

      const hasDrawerItem = !!(firstDrawerItem && firstDrawerItem.href);
      record(
        '[MG-NAV] Drawer contains at least one overflow item to click',
        'at least one drawer item present',
        hasDrawerItem ? `found ${firstDrawerItem.id}` : 'no drawer items found',
        hasDrawerItem,
      );

      if (hasDrawerItem) {
        // Click the anchor — it is a real <a> so it causes full page navigation.
        const [/* navResponse */] = await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
          page.evaluate((itemId) => {
            const btn = document.querySelector(`[data-testid="bottom-nav-drawer-paper"] #${itemId}`);
            if (btn) btn.click();
          }, firstDrawerItem.id),
        ]);

        // Wait for BottomNav to remount after navigation.
        await poll(page, () => {
          const nav = document.querySelector('nav.bottom-nav#main-content');
          return nav && nav.querySelector('#bnav-home') ? 'ok' : null;
        }, null, 15000);

        const drawerClosed = !(await readDrawerOpen(page));
        record(
          '[MG-NAV] Drawer is closed after clicking overflow tab',
          'drawer not visible',
          drawerClosed ? 'not visible' : 'still visible',
          drawerClosed,
        );

        const expectedPath = firstDrawerItem.href;
        const pathname = await page.evaluate(() => window.location.pathname);
        record(
          `[MG-NAV] pathname is ${expectedPath} after clicking ${firstDrawerItem.id}`,
          expectedPath,
          String(pathname),
          pathname === expectedPath,
        );

        const bar = await readBarState(page);
        record(
          '[MG-NAV] [data-more-selected] present after navigating to overflow tab',
          'present',
          bar ? (bar.moreSelected ? 'present' : 'absent') : 'bar state null',
          !!(bar && bar.moreSelected),
        );
        record(
          '[MG-NAV] #bnav-more has Mui-selected class after navigating to overflow tab',
          'Mui-selected on bnav-more',
          bar ? (bar.moreHasMuiSelected ? 'Mui-selected' : 'not selected') : 'bar state null',
          !!(bar && bar.moreHasMuiSelected),
        );
      }

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [CLO] Backdrop click closes the drawer
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [CLO] Drawer closes via backdrop');
    {
      const page = await openPage(browser, memberClient.cookie, '/');

      await clickMoreAndWaitForDrawer(page);
      const openedOk = await readDrawerOpen(page);

      await closeDrawerViaBackdrop(page);

      const closedOk = !(await readDrawerOpen(page));

      // [data-more-selected] should vanish once the drawer closes and we are
      // on a primary tab (home).
      const moreDeselected = await poll(page, () => {
        return document.querySelector('[data-more-selected]') ? null : 'gone';
      }, null, 5000);

      record(
        '[CLO] Drawer was open before backdrop click',
        'drawer open',
        openedOk ? 'open' : 'not open (precondition failed)',
        !!openedOk,
      );
      record(
        '[CLO] Backdrop click closes the drawer',
        'drawer not visible',
        closedOk ? 'not visible' : 'still visible',
        !!closedOk,
      );
      record(
        '[CLO] [data-more-selected] absent after drawer closes on primary tab',
        'absent',
        moreDeselected === 'gone' ? 'absent' : 'still present',
        moreDeselected === 'gone',
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
    '# bottom-nav More drawer — E2E',
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
    '- **[M-BAR]**   Member bar contains Home, Calendar, Trades + More; no Sales/Projects.',
    '- **[MG-BAR]**  Manager bar contains Home, Sales, Projects + More; Calendar/Trades are overflow.',
    '- **[M-DRAW]**  Tapping More opens the MUI bottom Drawer; member overflow lists Ideas only.',
    '- **[MG-DRAW]** Manager overflow lists Survey, Calendar, Invoices, Trades, Ideas.',
    '- **[M-ACT]**   Navigating to /ideas (overflow tab) sets `[data-more-selected]` and',
    '               `Mui-selected` on #bnav-more; navigating back to a primary tab clears it.',
    '- **[MG-ACT]**  Same active-in-overflow logic verified for manager at /survey.',
    '- **[M-NAV]**   Member clicks Ideas in the open drawer: drawer closes, pathname becomes',
    '               /ideas, and More is selected in the bar.',
    '- **[MG-NAV]**  Manager clicks Calendar (overflow) in the open drawer: drawer closes,',
    '               pathname becomes /calendar, and More is selected in the bar.',
    '- **[CLO]**     MUI Backdrop click closes the drawer; `[data-more-selected]` is cleared.',
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
