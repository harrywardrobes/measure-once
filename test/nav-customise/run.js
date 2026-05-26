'use strict';
// test/nav-customise/run.js
//
// End-to-end test for the nav tab customisation dialog.
//
// Covers:
//   [API]         GET/PATCH /api/users/me/prefs status codes + auth gating
//   [CUST-OPEN]   "Customise navigation" appears in More drawer for managers,
//                 absent for members
//   [CUST-SAVE]   Select 3 different tabs and save → bar updates immediately
//   [CUST-PERS]   Preference persists across a page reload
//   [CUST-FALL]   Fallback to role defaults when prefs has no nav_primary_keys
//   [CUST-CANCEL] Clicking Cancel discards unsaved changes
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:nav-customise
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:nav-customise

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
  makeClient,
  setPool,
  PASSWORD,
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
 * nav container). Also waits briefly for the async prefs fetch to settle.
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
  page.on('console', m => pageLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => pageLogs.push(`[pageerror] ${e.message}`));

  await injectSession(page, jar);
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: 25000 });

  // Wait for BottomNav to mount (nav element appears once React island loads)
  await poll(page, () => {
    const nav = document.querySelector('nav.bottom-nav#main-content');
    return nav && nav.querySelector('#bnav-home') ? 'ok' : null;
  }, null, 15000);

  // Wait for window.__moHeaderUser to be set by core.js bootstrap().
  // This is required so usePrivilege() in BottomNav reads the correct
  // privilege_level — if bootstrap hasn't finished yet, isManager stays
  // false and the "Customise navigation" button won't appear for managers.
  await poll(page, () => {
    return (window.__moHeaderUser && window.__moHeaderUser.privilege_level) ? 'ok' : null;
  }, null, 10000);

  // Wait for the BottomNav to re-render after the privilege level is known.
  // We poll for the presence of at least one manager-only OR member-only nav
  // element to confirm the component has flushed the privilege update:
  //   - #bnav-sales                    → manager bar rendered
  //   - #bnav-calendar                 → member bar rendered
  // This avoids a race where __moHeaderUser is set but React hasn't
  // batched + flushed the setPrivilegeLevel() state update yet.
  await poll(page, () => {
    const nav = document.querySelector('nav.bottom-nav#main-content');
    if (!nav) return null;
    const hasSales    = !!nav.querySelector('#bnav-sales');
    const hasCalendar = !!nav.querySelector('#bnav-calendar');
    // Either manager bar (sales) or member bar (calendar) must be present,
    // confirming role-specific rendering has completed.
    return (hasSales || hasCalendar) ? 'ok' : null;
  }, null, 8000);

  // Give loadNavPref() time to complete so bar reflects any persisted prefs.
  await new Promise(r => setTimeout(r, 600));

  page.__logs = pageLogs;
  return page;
}

/**
 * Return which nav keys are currently rendered inside the bar element
 * (not the drawer).
 */
function readBarKeys(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('nav.bottom-nav#main-content');
    if (!nav) return null;
    return ['home', 'customers', 'sales', 'survey', 'projects', 'calendar', 'invoices', 'trades', 'ideas']
      .filter(k => !!nav.querySelector(`#bnav-${k}`));
  });
}

/**
 * Click the More button in the bottom bar and wait until the MUI Drawer paper
 * slides into view.
 */
async function clickMoreAndWaitForDrawer(page, timeoutMs = 6000) {
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
 * Click the "Customise navigation" list item in the open drawer and wait for
 * the MUI Dialog to appear. Returns true if the dialog opened.
 */
async function clickCustomiseButton(page) {
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.MuiDrawer-paper .MuiListItemButton-root'));
    const btn = items.find(el => el.textContent.includes('Customise navigation'));
    if (btn) btn.click();
  });
  const ok = await poll(page, () => {
    const dialog = document.querySelector('.MuiDialog-paper');
    return dialog ? 'ok' : null;
  }, null, 5000);
  return ok === 'ok';
}

/**
 * Return the checkbox state from the open NavCustomiseDialog.
 * Each entry: { label, checked, disabled }.
 */
function getDialogCheckboxState(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('.MuiDialog-paper');
    if (!dialog) return null;
    return Array.from(dialog.querySelectorAll('.MuiFormControlLabel-root')).map(lbl => {
      const cb   = lbl.querySelector('input[type="checkbox"]');
      const text = lbl.querySelector('.MuiFormControlLabel-label');
      return {
        label:    text ? text.textContent.trim() : '',
        checked:  cb ? cb.checked  : false,
        disabled: cb ? cb.disabled : false,
      };
    });
  });
}

/**
 * Toggle checkboxes in the open dialog to end up with exactly `desiredLabels`
 * checked. Deselects extras first (to free up slots), then checks new ones.
 */
async function selectNavItems(page, desiredLabels) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const state = await getDialogCheckboxState(page);
    if (!state) break;
    const toUncheck = state.filter(s => s.checked  && !desiredLabels.includes(s.label));
    const toCheck   = state.filter(s => !s.checked &&  desiredLabels.includes(s.label));
    if (toUncheck.length === 0 && toCheck.length === 0) break;
    for (const item of toUncheck) {
      await page.evaluate((label) => {
        const dialog = document.querySelector('.MuiDialog-paper');
        const lblEl = Array.from(dialog.querySelectorAll('.MuiFormControlLabel-root'))
          .find(l => l.querySelector('.MuiFormControlLabel-label')?.textContent.trim() === label);
        if (lblEl) lblEl.querySelector('input[type="checkbox"]')?.click();
      }, item.label);
      await new Promise(r => setTimeout(r, 80));
    }
    for (const item of toCheck) {
      await page.evaluate((label) => {
        const dialog = document.querySelector('.MuiDialog-paper');
        const lblEl = Array.from(dialog.querySelectorAll('.MuiFormControlLabel-root'))
          .find(l => l.querySelector('.MuiFormControlLabel-label')?.textContent.trim() === label);
        const cb = lblEl?.querySelector('input[type="checkbox"]');
        if (cb && !cb.disabled) cb.click();
      }, item.label);
      await new Promise(r => setTimeout(r, 80));
    }
  }
}

/**
 * Click Save in the open dialog and wait for the dialog to close.
 */
async function clickSaveButton(page) {
  await page.evaluate(() => {
    const dialog = document.querySelector('.MuiDialog-paper');
    if (!dialog) return;
    const save = Array.from(dialog.querySelectorAll('.MuiDialogActions-root button'))
      .find(b => b.textContent.trim() === 'Save');
    if (save) save.click();
  });
  await poll(page, () => {
    return document.querySelector('.MuiDialog-paper') ? null : 'closed';
  }, null, 5000);
}

/**
 * Click Cancel in the open dialog and wait for it to close.
 */
async function clickCancelButton(page) {
  await page.evaluate(() => {
    const dialog = document.querySelector('.MuiDialog-paper');
    if (!dialog) return;
    const cancel = Array.from(dialog.querySelectorAll('.MuiDialogActions-root button'))
      .find(b => b.textContent.trim() === 'Cancel');
    if (cancel) cancel.click();
  });
  await poll(page, () => {
    return document.querySelector('.MuiDialog-paper') ? null : 'closed';
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
  console.log(`\n  nav-customise E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  if (!puppeteer) {
    console.error('[nav-customise] puppeteer is not installed — cannot run UI probes.');
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

  // ── [API] Prefs endpoint pre-checks ───────────────────────────────────────

  console.log('\n  [API] Prefs endpoint pre-checks');

  const managerClient = await login(users.manager.email, PASSWORD);
  const memberClient  = await login(users.member.email,  PASSWORD);

  // GET prefs returns 200 for authenticated manager
  {
    const r = await managerClient.get('/api/users/me/prefs');
    record(
      '[API] GET /api/users/me/prefs returns 200 for authenticated manager',
      'status=200',
      `status=${r.status}`,
      r.status === 200,
    );
  }

  // PATCH prefs saves nav_primary_keys and returns the merged prefs
  {
    const r = await managerClient.patch('/api/users/me/prefs', {
      nav_primary_keys: ['home', 'survey', 'calendar'],
    });
    const saved = JSON.stringify(r.json?.nav_primary_keys);
    record(
      '[API] PATCH /api/users/me/prefs persists nav_primary_keys',
      'status=200, nav_primary_keys=["home","survey","calendar"]',
      `status=${r.status} keys=${saved}`,
      r.status === 200 && saved === JSON.stringify(['home', 'survey', 'calendar']),
    );
    // Reset for subsequent browser probes
    await managerClient.patch('/api/users/me/prefs', { nav_primary_keys: null });
  }

  // PATCH with a non-object body is rejected
  {
    const r = await managerClient.patch('/api/users/me/prefs', [1, 2, 3]);
    record(
      '[API] PATCH /api/users/me/prefs with array body returns 400',
      'status=400',
      `status=${r.status}`,
      r.status === 400,
    );
  }

  // Unauthenticated GET is blocked
  {
    const anon = makeClient(null);
    const r = await anon.get('/api/users/me/prefs');
    record(
      '[API] GET /api/users/me/prefs unauthenticated returns 401 or 302',
      'status=401 or 302',
      `status=${r.status}`,
      r.status === 401 || r.status === 302,
    );
  }

  // ── Browser probes ────────────────────────────────────────────────────────

  const executablePath = findChromium();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {

    // ══════════════════════════════════════════════════════════════════════════
    // [CUST-OPEN] Customise navigation button visibility
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [CUST-OPEN] "Customise navigation" button visibility');

    // Managers see the button
    {
      const page = await openPage(browser, managerClient.cookie, '/');
      await clickMoreAndWaitForDrawer(page);

      const hasCustomise = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.MuiDrawer-paper .MuiListItemButton-root'));
        return items.some(el => el.textContent.includes('Customise navigation'));
      });
      record(
        '[CUST-OPEN] Manager sees "Customise navigation" in More drawer',
        '"Customise navigation" button present',
        hasCustomise ? 'present' : 'absent',
        hasCustomise,
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // Members do NOT see the button
    {
      const page = await openPage(browser, memberClient.cookie, '/');
      await clickMoreAndWaitForDrawer(page);

      const hasCustomise = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.MuiDrawer-paper .MuiListItemButton-root'));
        return items.some(el => el.textContent.includes('Customise navigation'));
      });
      record(
        '[CUST-OPEN] Member does NOT see "Customise navigation" in More drawer',
        '"Customise navigation" button absent',
        hasCustomise ? 'present' : 'absent',
        !hasCustomise,
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [CUST-SAVE] Select 3 different tabs and save → bar updates immediately
    // Manager defaults: home, customers, sales.
    // We select:        home, survey, calendar.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [CUST-SAVE] Select and save custom tabs');

    const customKeys   = ['home', 'survey', 'calendar'];
    const customLabels = ['Home', 'Survey', 'Calendar'];
    const removedKeys  = ['customers', 'sales'];

    {
      const page = await openPage(browser, managerClient.cookie, '/');

      // Confirm default bar before customising
      const defaultBar = await readBarKeys(page);
      record(
        '[CUST-SAVE] Default manager bar contains home, customers, sales',
        'home, customers, sales in bar',
        JSON.stringify(defaultBar),
        ['home', 'customers', 'sales'].every(k => defaultBar && defaultBar.includes(k)),
      );

      // Open More drawer → Customise navigation dialog
      await clickMoreAndWaitForDrawer(page);
      const dialogOpened = await clickCustomiseButton(page);
      record(
        '[CUST-SAVE] "Customise navigation" dialog opens',
        'MuiDialog-paper visible',
        dialogOpened ? 'visible' : 'not visible',
        dialogOpened,
      );

      if (dialogOpened) {
        // Dialog should pre-check the current 3 bar keys
        const initialState = await getDialogCheckboxState(page);
        const initialChecked = (initialState || []).filter(s => s.checked).map(s => s.label);
        record(
          '[CUST-SAVE] Dialog initially shows exactly 3 checkboxes checked',
          '3 checked',
          `${initialChecked.length} checked: ${JSON.stringify(initialChecked)}`,
          initialChecked.length === 3,
        );

        // Select our custom set
        await selectNavItems(page, customLabels);

        const afterSelect = await getDialogCheckboxState(page);
        const afterChecked = (afterSelect || []).filter(s => s.checked).map(s => s.label).sort();
        record(
          '[CUST-SAVE] After selection, Home + Survey + Calendar are the 3 checked items',
          'checked=[Calendar,Home,Survey]',
          JSON.stringify(afterChecked),
          JSON.stringify(afterChecked) === JSON.stringify(['Calendar', 'Home', 'Survey']),
        );

        // Save button should be enabled when exactly 3 are checked
        const saveEnabled = await page.evaluate(() => {
          const dialog = document.querySelector('.MuiDialog-paper');
          if (!dialog) return null;
          const save = Array.from(dialog.querySelectorAll('.MuiDialogActions-root button'))
            .find(b => b.textContent.trim() === 'Save');
          return save ? !save.disabled : null;
        });
        record(
          '[CUST-SAVE] Save button is enabled when exactly 3 tabs selected',
          'enabled',
          saveEnabled === true ? 'enabled' : saveEnabled === false ? 'disabled' : 'not found',
          saveEnabled === true,
        );

        // Save and wait for bar to update without a reload
        await clickSaveButton(page);

        const updatedBar = await poll(page, (keys) => {
          const nav = document.querySelector('nav.bottom-nav#main-content');
          if (!nav) return null;
          return keys.every(k => !!nav.querySelector(`#bnav-${k}`)) ? 'ok' : null;
        }, customKeys, 6000);
        record(
          '[CUST-SAVE] Bar immediately shows the selected tabs (home, survey, calendar)',
          'bnav-home, bnav-survey, bnav-calendar in nav bar',
          updatedBar === 'ok' ? 'all present' : 'some missing',
          updatedBar === 'ok',
        );

        // Previously-primary tabs must have left the bar
        const barAfterSave = await readBarKeys(page);
        for (const key of removedKeys) {
          record(
            `[CUST-SAVE] "${key}" no longer in bar after customisation`,
            `bnav-${key} absent from bar`,
            barAfterSave && barAfterSave.includes(key) ? 'present' : 'absent',
            !!(barAfterSave && !barAfterSave.includes(key)),
          );
        }
      } else {
        // Skip downstream checks so the report is still complete
        for (const skip of [
          '[CUST-SAVE] Dialog initially shows exactly 3 checkboxes checked',
          '[CUST-SAVE] After selection, Home + Survey + Calendar are the 3 checked items',
          '[CUST-SAVE] Save button is enabled when exactly 3 tabs selected',
          '[CUST-SAVE] Bar immediately shows the selected tabs (home, survey, calendar)',
          '[CUST-SAVE] "customers" no longer in bar after customisation',
          '[CUST-SAVE] "sales" no longer in bar after customisation',
        ]) {
          record(skip, 'dialog opened', 'dialog did not open (skipped)', false);
        }
      }

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [CUST-PERS] Preference persists across a page reload
    // The manager saved home/survey/calendar in [CUST-SAVE] above.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [CUST-PERS] Preference persisted on reload');

    {
      const page = await openPage(browser, managerClient.cookie, '/');

      const bar = await readBarKeys(page);
      record(
        '[CUST-PERS] Reloaded page: home, survey, calendar still in bar',
        'bnav-home, bnav-survey, bnav-calendar in bar',
        JSON.stringify(bar),
        customKeys.every(k => bar && bar.includes(k)),
      );
      record(
        '[CUST-PERS] Reloaded page: sales absent from bar (moved to overflow)',
        'bnav-sales absent',
        bar && bar.includes('sales') ? 'present' : 'absent',
        !!(bar && !bar.includes('sales')),
      );
      record(
        '[CUST-PERS] Reloaded page: customers absent from bar (moved to overflow)',
        'bnav-customers absent',
        bar && bar.includes('customers') ? 'present' : 'absent',
        !!(bar && !bar.includes('customers')),
      );

      // Previously-primary tabs should appear in the More drawer
      await clickMoreAndWaitForDrawer(page);
      const drawerIds = await page.evaluate(() => {
        const paper = document.querySelector('.MuiDrawer-paper');
        if (!paper) return [];
        return Array.from(paper.querySelectorAll('[id^="bnav-"]')).map(el => el.id.replace('bnav-', ''));
      });
      record(
        '[CUST-PERS] "sales" now appears in More drawer after customisation',
        'sales in drawer',
        JSON.stringify(drawerIds),
        drawerIds.includes('sales'),
      );
      record(
        '[CUST-PERS] "customers" now appears in More drawer after customisation',
        'customers in drawer',
        JSON.stringify(drawerIds),
        drawerIds.includes('customers'),
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [CUST-FALL] Fallback to role defaults when prefs has no nav_primary_keys
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [CUST-FALL] Fallback to manager role defaults');

    // Clear the stored preference via the REST API
    {
      const clearRes = await managerClient.patch('/api/users/me/prefs', { nav_primary_keys: null });
      record(
        '[CUST-FALL] Clearing nav_primary_keys via PATCH returns 200',
        'status=200',
        `status=${clearRes.status}`,
        clearRes.status === 200,
      );

      // Verify GET now returns null for nav_primary_keys
      const prefsAfter = await managerClient.get('/api/users/me/prefs');
      const keysAfter  = prefsAfter.json?.nav_primary_keys;
      record(
        '[CUST-FALL] GET /api/users/me/prefs returns nav_primary_keys null after clear',
        'nav_primary_keys is null or absent',
        JSON.stringify(keysAfter),
        keysAfter === null || keysAfter === undefined,
      );

      // Open a fresh page — should revert to manager defaults (home, customers, sales)
      const page = await openPage(browser, managerClient.cookie, '/');
      const bar  = await readBarKeys(page);

      record(
        '[CUST-FALL] Bar reverts to manager defaults (home, customers, sales)',
        'bnav-home, bnav-customers, bnav-sales in bar',
        JSON.stringify(bar),
        ['home', 'customers', 'sales'].every(k => bar && bar.includes(k)),
      );
      record(
        '[CUST-FALL] survey not in bar after default fallback',
        'bnav-survey absent',
        bar && bar.includes('survey') ? 'present' : 'absent',
        !!(bar && !bar.includes('survey')),
      );
      record(
        '[CUST-FALL] calendar not in bar after default fallback',
        'bnav-calendar absent',
        bar && bar.includes('calendar') ? 'present' : 'absent',
        !!(bar && !bar.includes('calendar')),
      );

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [CUST-CANCEL] Cancelling the dialog discards unsaved changes
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [CUST-CANCEL] Cancel discards unsaved changes');

    {
      // Prefs were cleared above so manager is on defaults (home, customers, sales)
      const page = await openPage(browser, managerClient.cookie, '/');

      // Open More drawer → dialog
      await clickMoreAndWaitForDrawer(page);
      const dialogOpened = await clickCustomiseButton(page);

      if (dialogOpened) {
        // Change the selection to something different without saving
        await selectNavItems(page, ['Home', 'Survey', 'Calendar']);

        const afterSelect = await getDialogCheckboxState(page);
        const selectedLabels = (afterSelect || []).filter(s => s.checked).map(s => s.label).sort();
        record(
          '[CUST-CANCEL] Dialog selection changed to Home, Survey, Calendar before cancel',
          'checked=[Calendar,Home,Survey]',
          JSON.stringify(selectedLabels),
          JSON.stringify(selectedLabels) === JSON.stringify(['Calendar', 'Home', 'Survey']),
        );

        // Click Cancel — do NOT save
        await clickCancelButton(page);

        // Bar should still reflect role defaults (home, customers, sales)
        const barAfterCancel = await readBarKeys(page);
        record(
          '[CUST-CANCEL] Bar unchanged after Cancel (still home, customers, sales)',
          'home, customers, sales in bar',
          JSON.stringify(barAfterCancel),
          ['home', 'customers', 'sales'].every(k => barAfterCancel && barAfterCancel.includes(k)),
        );
        record(
          '[CUST-CANCEL] survey absent from bar after Cancel',
          'bnav-survey absent',
          barAfterCancel && barAfterCancel.includes('survey') ? 'present' : 'absent',
          !!(barAfterCancel && !barAfterCancel.includes('survey')),
        );
      } else {
        for (const skip of [
          '[CUST-CANCEL] Dialog selection changed to Home, Survey, Calendar before cancel',
          '[CUST-CANCEL] Bar unchanged after Cancel (still home, customers, sales)',
          '[CUST-CANCEL] survey absent from bar after Cancel',
        ]) {
          record(skip, 'dialog opened', 'dialog did not open (skipped)', false);
        }
      }

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
  const esc  = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  const lines = [
    '# nav-customise — E2E',
    '',
    `- Date    : ${new Date().toISOString()}`,
    `- Run ID  : ${runId}`,
    `- Command : \`npm run test:nav-customise\``,
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
    '- **[API]** Pre-checks: `GET /api/users/me/prefs` returns 200 for authenticated',
    '  users; `PATCH` with a valid object persists the key and returns the merged',
    '  prefs; `PATCH` with an array body returns 400; unauthenticated `GET` returns',
    '  401 or 302.',
    '- **[CUST-OPEN]** The "Customise navigation" button appears in the More drawer',
    '  for managers (`isManager = true`) and is absent for members (role-gated via',
    '  `usePrivilege` in `BottomNav.tsx`).',
    '- **[CUST-SAVE]** Opening the customise dialog shows the current 3 selections',
    '  pre-checked; selecting Home + Survey + Calendar (replacing the default',
    '  Home + Customers + Sales) and clicking Save immediately updates the bar',
    '  without a page reload; previously-primary tabs move to the More drawer.',
    '- **[CUST-PERS]** A fresh page load after saving reads the persisted',
    '  `nav_primary_keys` preference via `GET /api/users/me/prefs` and renders the',
    '  correct bar; Customers and Sales appear in the More drawer.',
    '- **[CUST-FALL]** Setting `nav_primary_keys` to null via PATCH causes the bar',
    '  to fall back to the manager role defaults (Home, Customers, Sales) on the',
    '  next page load — covering the `loadNavPref()` returns-null branch.',
    '- **[CUST-CANCEL]** Clicking Cancel in the dialog closes it without calling',
    '  `onSave`; the bar remains on its current state.',
    '',
    '## Relevant files',
    '',
    '- `src/react/components/BottomNav.tsx`',
    '- `src/react/components/NavCustomiseDialog.tsx`',
  ];
  const outPath = path.join(dir, 'nav-customise.md');
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`  Report: test-results/nav-customise.md`);
}

main();
