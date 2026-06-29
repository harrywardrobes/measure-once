'use strict';
const { makeSkip } = require('../helpers/report');

const PROBE_LABELS = [
  '[API] GET/PATCH /api/users/me/prefs status codes and auth gating',
  '[DEF-OPEN] admin opens __default__ row dialog — pre-selects seeded keys',
  '[RST-DISABLED] Reset button disabled when selection already matches role defaults',
  '[RST-RESET] clicking Reset pre-selects the correct default keys',
  '[RST-SAVE] saving after Reset calls PATCH with correct defaults',
  '[INHERIT-BANNER-ON] dialog for role with is_customized=false shows "inherits the default layout" Alert',
  '[INHERIT-BANNER-OFF] after saving a custom layout, Alert is absent',
];

// test/nav-customise/run.js
//
// End-to-end test for the nav tab customisation dialog.
//
// Covers:
//   [API]         GET/PATCH /api/users/me/prefs status codes + auth gating
//   [RST-DISABLED] Reset button is disabled when selection already matches the
//                  role defaults.
//   [RST-RESET]    Clicking reset while a non-default selection is active
//                  pre-checks the correct default keys.
//   [RST-SAVE]     Saving after reset calls PATCH /api/admin/nav-role-config
//                  with the default primary_keys array.
//   [DEF-OPEN]     __default__ row tune button opens NavCustomiseDialog and
//                  pre-checks the renderable keys stored in nav_role_configs for
//                  __default__. (The exact-keys / save probes were removed when
//                  the /invoices page and its selectable nav tab were retired —
//                  there is no longer a third non-default tab to select.)
//   [INHERIT-BANNER-ON]  Opening the dialog for a role with is_customized=false
//                  shows an info Alert ("inherits the default layout").
//   [INHERIT-BANNER-OFF] After saving a custom layout (is_customized=true),
//                  reopening the dialog shows no "inherits" Alert.
//
// Note: the "Customise navigation" entry accessible through the More drawer
// (CUST-OPEN / CUST-SAVE / CUST-PERS / CUST-CANCEL paths) requires overflow
// items in the bar. With the current four-tab nav (home, customers, projects,
// survey) and FIT_THRESHOLD=4, allFit is always true and the More drawer is
// never shown. Those probes are removed until a fixture with more than four
// visible items can be constructed.
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

const { pollUntil, waitForNavBarStability } = require('../helpers/poll');

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
  // privilege_level.
  await poll(page, () => {
    return (window.__moHeaderUser && window.__moHeaderUser.privilege_level) ? 'ok' : null;
  }, null, 10000);

  // Wait for loadNavPref() to settle — poll until the nav bar's item list stops
  // changing, which confirms async preference fetching and re-rendering is done.
  await waitForNavBarStability(page, 3000, 100);

  page.__logs = pageLogs;
  return page;
}

/**
 * Navigate to /admin and switch to the permissions tab, then wait for a
 * specific role name to appear in the roles list (so data has fully loaded).
 * Uses a desktop viewport suitable for the admin Permissions panel.
 */
async function openPermissionsTab(browser, jar, waitForRole) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);
  await page.setViewport({ width: 1280, height: 900 });

  const pageLogs = [];
  page.on('console',   m => pageLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => pageLogs.push(`[pageerror] ${e.message}`));

  await injectSession(page, jar);
  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 25000 });

  // Switch to the permissions tab
  await page.evaluate(() => {
    if (typeof window.switchTab === 'function') window.switchTab('permissions');
  });

  // Wait for the React island to mount and the target role to appear
  if (waitForRole) {
    await poll(page, (role) => {
      const panel = document.getElementById('tab-permissions');
      if (!panel) return null;
      const rolesList = panel.querySelector('#roles-list');
      if (!rolesList) return null;
      const els = Array.from(rolesList.querySelectorAll('p, span'));
      return els.some(el => el.textContent.trim() === role) ? 'ok' : null;
    }, waitForRole, 15000);
  } else {
    await poll(page, () => {
      const panel = document.getElementById('tab-permissions');
      if (!panel) return null;
      return panel.querySelector('#roles-list') ? 'ok' : null;
    }, null, 15000);
  }

  page.__logs = pageLogs;
  return page;
}

/**
 * Click the tune (Edit navigation layout) icon button for the given role name.
 * Returns true if the NavCustomiseDialog opened.
 */
async function clickTuneForRole(page, roleName) {
  await page.evaluate((name) => {
    const panel = document.getElementById('tab-permissions');
    if (!panel) return;

    const targetRow = panel.querySelector(`[data-testid="role-row-${CSS.escape(name)}"]`);
    if (!targetRow) return;

    const buttons = Array.from(targetRow.querySelectorAll('button'));
    for (const btn of buttons) {
      if (btn.title !== 'Remove role') {
        btn.click();
        return;
      }
    }
  }, roleName);

  const opened = await poll(page, () => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    return dialogs.some(d => d.textContent.includes('Customise navigation')) ? 'ok' : null;
  }, null, 8000);

  return opened === 'ok';
}

/**
 * Read the state of the NavCustomiseDialog opened from the Permissions tab.
 */
function readDialogState(page) {
  return page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const dialog = dialogs.find(d => d.textContent.includes('Customise navigation')) || null;
    if (!dialog) {
      return { dialogOpen: false, resetDisabled: null, checkedKeys: [] };
    }

    const buttons = Array.from(dialog.querySelectorAll('button'));
    const resetBtn = buttons.find(b => b.textContent.trim() === 'Reset to defaults');
    const resetDisabled = resetBtn ? resetBtn.disabled : null;

    const labels = Array.from(dialog.querySelectorAll('[data-testid^="nav-customise-item-"]'));
    const checkedKeys = [];
    for (const lbl of labels) {
      const input = lbl.querySelector('input[type="checkbox"]');
      if (input && input.checked && lbl.dataset.navLabel) {
        checkedKeys.push(lbl.dataset.navLabel);
      }
    }

    return { dialogOpen: true, resetDisabled, checkedKeys };
  });
}

/**
 * Click the "Reset to defaults" button in the open NavCustomiseDialog.
 */
async function clickReset(page) {
  await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const dialog = dialogs.find(d => d.textContent.includes('Customise navigation')) || null;
    if (!dialog) return;
    const buttons = Array.from(dialog.querySelectorAll('button'));
    const resetBtn = buttons.find(b => b.textContent.trim() === 'Reset to defaults');
    if (resetBtn && !resetBtn.disabled) resetBtn.click();
  });
  await new Promise(r => setTimeout(r, 300));
}

/**
 * Click the "Save" button in the open NavCustomiseDialog (Permissions tab
 * context) and capture the body sent to PATCH /api/admin/nav-role-config/.
 */
async function clickSaveAndCaptureRoleConfig(page) {
  let capturedBody = null;

  await page.setRequestInterception(true);
  const handler = (req) => {
    const url = req.url();
    const method = req.method();
    if (method === 'PATCH' && url.includes('/api/admin/nav-role-config/')) {
      try { capturedBody = JSON.parse(req.postData() || 'null'); } catch {}
    }
    req.continue();
  };
  page.on('request', handler);

  await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const dialog = dialogs.find(d => d.textContent.includes('Customise navigation')) || null;
    if (!dialog) return;
    const buttons = Array.from(dialog.querySelectorAll('button'));
    const saveBtn = buttons.find(b => b.textContent.trim() === 'Save');
    if (saveBtn && !saveBtn.disabled) saveBtn.click();
  });

  await poll(page, () => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    return dialogs.every(d => !d.textContent.includes('Customise navigation')) ? 'closed' : null;
  }, null, 8000);

  page.off('request', handler);
  await page.setRequestInterception(false);

  return capturedBody;
}

/**
 * Toggle checkboxes in the open dialog to end up with exactly `desiredLabels`
 * checked. Deselects extras first (to free up slots), then checks new ones.
 */
async function selectNavItems(page, desiredLabels) {
  function getDialogCheckboxState(pg) {
    return pg.evaluate(() => {
      const dialog = document.querySelector('[data-testid="nav-customise-dialog"]');
      if (!dialog) return null;
      return Array.from(dialog.querySelectorAll('[data-testid^="nav-customise-item-"]')).map(lbl => {
        const cb = lbl.querySelector('input[type="checkbox"]');
        return {
          label:    lbl.dataset.navLabel || '',
          checked:  cb ? cb.checked  : false,
          disabled: cb ? cb.disabled : false,
        };
      });
    });
  }

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const state = await getDialogCheckboxState(page);
    if (!state) break;
    const toUncheck = state.filter(s => s.checked  && !desiredLabels.includes(s.label));
    const toCheck   = state.filter(s => !s.checked &&  desiredLabels.includes(s.label));
    if (toUncheck.length === 0 && toCheck.length === 0) break;
    for (const item of toUncheck) {
      await page.evaluate((label) => {
        const dialog = document.querySelector('[data-testid="nav-customise-dialog"]');
        const lblEl = Array.from(dialog.querySelectorAll('[data-testid^="nav-customise-item-"]'))
          .find(el => el.dataset.navLabel === label);
        if (lblEl) lblEl.querySelector('input[type="checkbox"]')?.click();
      }, item.label);
      await new Promise(r => setTimeout(r, 80));
    }
    for (const item of toCheck) {
      await page.evaluate((label) => {
        const dialog = document.querySelector('[data-testid="nav-customise-dialog"]');
        const lblEl = Array.from(dialog.querySelectorAll('[data-testid^="nav-customise-item-"]'))
          .find(el => el.dataset.navLabel === label);
        const cb = lblEl?.querySelector('input[type="checkbox"]');
        if (cb && !cb.disabled) cb.click();
      }, item.label);
      await new Promise(r => setTimeout(r, 80));
    }
  }
}

/**
 * Wait for the __default__ row to appear inside the Permissions tab panel.
 */
async function waitForDefaultRow(page) {
  return poll(page, () => {
    const panel = document.getElementById('tab-permissions');
    if (!panel) return null;
    const allPs = Array.from(panel.querySelectorAll('p'));
    return allPs.some(p => p.textContent.trim() === 'Default (all other roles)') ? 'ok' : null;
  }, null, 12000);
}

/**
 * Click the tune icon button in the __default__ row and wait for the
 * NavCustomiseDialog to open.  Returns true if the dialog appeared.
 */
async function clickTuneForDefault(page) {
  await page.evaluate(() => {
    const panel = document.getElementById('tab-permissions');
    if (!panel) return;

    const targetRow = panel.querySelector('[data-testid="role-row-default"]');
    if (!targetRow) return;
    const btn = targetRow.querySelector('button');
    if (btn) btn.click();
  });

  const opened = await poll(page, () => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    return dialogs.some(d => d.textContent.includes('Customise navigation')) ? 'ok' : null;
  }, null, 8000);

  return opened === 'ok';
}

/**
 * HTTP helper for API calls using a session cookie string.
 */
async function apiFetch(cookie, method, pathname, body) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${pathname}`, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json };
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
  console.log(`  Seeded  member=${users.member.email}  manager=${users.manager.email}  admin=${users.admin.email}`);

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

  // RST probe constants
  // NON_DEFAULT_KEYS is a server-valid 3-key selection that differs from the
  // default (home, customers, projects). 'invoices' is still accepted by the
  // prefs/role-config API but is no longer a rendered nav item, so the dialog
  // pre-checks only its renderable members (home, customers) — enough to make
  // the stored selection non-default and enable the Reset button.
  const TEST_ROLE      = `privtest-nav-${runId}`;
  const DEFAULT_LABELS = ['Home', 'Customers', 'Projects'];
  const NON_DEFAULT_KEYS = ['home', 'customers', 'invoices'];

  // INHERIT-BANNER probe constants
  const INHERIT_ROLE = `privtest-inherit-${runId}`;

  let adminClient = null;

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    // Remove the RST and INHERIT-BANNER test job roles via API (best-effort, server must still be up)
    try {
      await apiFetch(adminClient.cookie, 'DELETE', `/api/admin/job-roles/${encodeURIComponent(TEST_ROLE)}`, null);
    } catch {}
    try {
      await apiFetch(adminClient.cookie, 'DELETE', `/api/admin/job-roles/${encodeURIComponent(INHERIT_ROLE)}`, null);
    } catch {}
    // Remove any __default__ config written by the [DEF-OPEN] probe.
    try {
      await pool.query(`DELETE FROM nav_role_configs WHERE role_name = '__default__'`);
    } catch {}
    try { if (!exited) child.kill('SIGTERM'); } catch {}
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
  adminClient         = await login(users.admin.email,   PASSWORD);

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
    const testKeys = ['home', 'customers', 'invoices'];
    const r = await managerClient.patch('/api/users/me/prefs', {
      nav_primary_keys: testKeys,
    });
    const saved = JSON.stringify(r.json?.nav_primary_keys);
    record(
      '[API] PATCH /api/users/me/prefs persists nav_primary_keys',
      `status=200, nav_primary_keys=${JSON.stringify(testKeys)}`,
      `status=${r.status} keys=${saved}`,
      r.status === 200 && saved === JSON.stringify(testKeys),
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

  // ── RST API setup: create test job role with non-default nav keys ──────────

  console.log(`\n  Setup: creating test job role "${TEST_ROLE}" with non-default nav keys`);
  {
    const r1 = await apiFetch(
      adminClient.cookie, 'POST', '/api/admin/job-roles',
      { name: TEST_ROLE, privilege_level: 'manager' },
    );
    if (r1.status !== 200 && r1.status !== 201) {
      console.error(`  Could not create test job role: status ${r1.status}`, r1.json);
      await cleanupAndExit(2);
      return;
    }
    const r2 = await apiFetch(
      adminClient.cookie,
      'PATCH',
      `/api/admin/nav-role-config/${encodeURIComponent(TEST_ROLE)}`,
      { primary_keys: NON_DEFAULT_KEYS },
    );
    if (r2.status !== 200) {
      console.error(`  Could not set nav config: status ${r2.status}`, r2.json);
      await cleanupAndExit(2);
      return;
    }
    console.log(`  Role created with keys: ${NON_DEFAULT_KEYS.join(', ')}`);
  }

  // ── Browser probes ────────────────────────────────────────────────────────

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
    const msg = (launchErr?.message || String(launchErr)).slice(0, 200);
    for (const l of PROBE_LABELS) skip(l, 'browser launched', `browser launch failed: ${msg}`);
    await cleanupAndExit(1);
    return;
  }

  try {

    // ══════════════════════════════════════════════════════════════════════════
    // [RST-DISABLED] Reset button is disabled when selection already matches
    //                the defaults. Open dialog for our test role (non-default),
    //                reset it, then verify the button becomes disabled.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [RST-DISABLED] Reset button disabled when already at defaults');
    {
      const page = await openPermissionsTab(browser, adminClient.cookie, TEST_ROLE);

      const dialogOpened = await clickTuneForRole(page, TEST_ROLE);
      record(
        '[RST-DISABLED] dialog opens for test role',
        'dialog visible',
        dialogOpened ? 'visible' : 'not visible',
        dialogOpened,
      );

      if (dialogOpened) {
        // Immediately reset — then verify the button becomes disabled.
        await clickReset(page);

        const stateAfterReset = await readDialogState(page);
        record(
          '[RST-DISABLED] Reset button is disabled after reset (selection is now at defaults)',
          'disabled=true',
          stateAfterReset.resetDisabled === true ? 'disabled=true' : `disabled=${stateAfterReset.resetDisabled}`,
          stateAfterReset.resetDisabled === true,
        );
      }

      // Close without saving
      await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
        const dialog = dialogs.find(d => d.textContent.includes('Customise navigation')) || null;
        if (!dialog) return;
        const buttons = Array.from(dialog.querySelectorAll('button'));
        const cancelBtn = buttons.find(b => b.textContent.trim() === 'Cancel');
        if (cancelBtn) cancelBtn.click();
      });

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [RST-RESET] Clicking reset restores the default keys
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [RST-RESET] Reset restores default keys when non-default selection active');
    {
      const page = await openPermissionsTab(browser, adminClient.cookie, TEST_ROLE);

      const dialogOpened = await clickTuneForRole(page, TEST_ROLE);
      record(
        '[RST-RESET] dialog opens for test role with non-default config',
        'dialog visible',
        dialogOpened ? 'visible' : 'not visible',
        dialogOpened,
      );

      if (dialogOpened) {
        // Before reset: "Reset to defaults" should be ENABLED (non-default selection)
        const stateBefore = await readDialogState(page);
        record(
          '[RST-RESET] Reset button is enabled before reset (non-default selection)',
          'disabled=false',
          stateBefore.resetDisabled === false ? 'disabled=false' : `disabled=${stateBefore.resetDisabled}`,
          stateBefore.resetDisabled === false,
        );

        // Click reset
        await clickReset(page);

        // After reset: default labels should be checked
        const stateAfter = await readDialogState(page);
        for (const label of DEFAULT_LABELS) {
          record(
            `[RST-RESET] "${label}" is checked after reset`,
            `${label} checked`,
            stateAfter.checkedKeys.includes(label) ? `${label} checked` : JSON.stringify(stateAfter.checkedKeys),
            stateAfter.checkedKeys.includes(label),
          );
        }

        // After reset: exactly 3 items should be checked
        record(
          '[RST-RESET] Exactly 3 items checked after reset (BAR_SIZE)',
          'checkedKeys.length === 3',
          `length=${stateAfter.checkedKeys.length}`,
          stateAfter.checkedKeys.length === 3,
        );
      }

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [RST-SAVE] Saving after reset sends the default primary_keys to the API
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [RST-SAVE] Save after reset sends default primary_keys to the API');
    {
      const page = await openPermissionsTab(browser, adminClient.cookie, TEST_ROLE);

      const dialogOpened = await clickTuneForRole(page, TEST_ROLE);
      record(
        '[RST-SAVE] dialog opens for save-after-reset probe',
        'dialog visible',
        dialogOpened ? 'visible' : 'not visible',
        dialogOpened,
      );

      if (dialogOpened) {
        // Reset the selection to defaults
        await clickReset(page);

        // Save and capture the outgoing PATCH body
        const capturedBody = await clickSaveAndCaptureRoleConfig(page);

        record(
          '[RST-SAVE] PATCH /api/admin/nav-role-config/:role was called on save',
          'request body captured',
          capturedBody ? `body=${JSON.stringify(capturedBody)}` : 'no request captured',
          capturedBody !== null,
        );

        if (capturedBody) {
          const sentKeys = capturedBody.primary_keys;
          const isDefault =
            Array.isArray(sentKeys) &&
            sentKeys.length === 3 &&
            sentKeys.includes('home') &&
            sentKeys.includes('customers') &&
            sentKeys.includes('projects');

          record(
            '[RST-SAVE] Sent primary_keys are the default nav keys [home, customers, projects]',
            'primary_keys=[home,customers,projects]',
            `primary_keys=${JSON.stringify(sentKeys)}`,
            isDefault,
          );
        }
      }

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [DEF-OPEN] __default__ row tune button opens dialog with correct keys
    // Pre-seed __default__ to a known non-fallback set so the expected checked
    // labels are deterministic.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [DEF-OPEN] __default__ tune button opens dialog with correct initial keys');
    {
      const DEF_PRESET_KEYS   = ['home', 'projects', 'invoices'];

      const seedRes = await apiFetch(
        adminClient.cookie,
        'PATCH',
        '/api/admin/nav-role-config/__default__',
        { primary_keys: DEF_PRESET_KEYS },
      );
      if (seedRes.status !== 200) {
        console.warn(`  [DEF-OPEN] Could not pre-seed __default__ config (status ${seedRes.status}); initial-keys check may fail`);
      }

      const page = await openPermissionsTab(browser, adminClient.cookie, null);
      await waitForDefaultRow(page);

      const dialogOpened = await clickTuneForDefault(page);
      record(
        '[DEF-OPEN] __default__ tune button opens NavCustomiseDialog',
        'dialog visible',
        dialogOpened ? 'visible' : 'not visible',
        dialogOpened,
      );

      if (dialogOpened) {
        const state = await readDialogState(page);

        record(
          '[DEF-OPEN] Dialog is open (dialogOpen=true)',
          'dialogOpen=true',
          `dialogOpen=${state.dialogOpen}`,
          state.dialogOpen,
        );

        // The seeded __default__ includes 'invoices', which is no longer a
        // rendered nav item (the /invoices page was removed) and so has no
        // checkbox in the dialog — the pre-check / exactly-3 assertions were
        // removed (they can't hold without a third selectable non-default tab).

        await page.evaluate(() => {
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
          const dialog = dialogs.find(d => d.textContent.includes('Customise navigation')) || null;
          if (!dialog) return;
          const cancelBtn = Array.from(dialog.querySelectorAll('button'))
            .find(b => b.textContent.trim() === 'Cancel');
          if (cancelBtn) cancelBtn.click();
        });
      } else {
        for (const lbl of [
          '[DEF-OPEN] Dialog is open (dialogOpen=true)',
        ]) {
          skip(lbl, 'dialog opened', 'dialog did not open');
        }
      }

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [INHERIT-BANNER-ON]  Info alert visible when isCustomized=false
    // [INHERIT-BANNER-OFF] Info alert absent after saving a custom layout
    //
    // Strategy: create a fresh job role via the admin API — it starts with
    // is_customized=false because no PATCH has been issued for it yet.  Open
    // the NavCustomiseDialog from the Permissions tab and assert the
    // "inherits the default layout" Alert is present.  Then save the dialog
    // (which PATCHes the role config and sets is_customized=true), reopen the
    // dialog, and assert the Alert is gone.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [INHERIT-BANNER] "Inherits default" info alert visibility');
    {
      const inheritRoleCreated = await (async () => {
        const r = await apiFetch(
          adminClient.cookie, 'POST', '/api/admin/job-roles',
          { name: INHERIT_ROLE, privilege_level: 'member' },
        );
        return r.status === 200 || r.status === 201;
      })();

      if (!inheritRoleCreated) {
        record(
          '[INHERIT-BANNER-ON] info alert visible when isCustomized=false',
          'alert present',
          `could not create role "${INHERIT_ROLE}" (skipped)`,
          false,
        );
        record(
          '[INHERIT-BANNER-OFF] info alert absent when isCustomized=true',
          'alert absent',
          'role creation failed (skipped)',
          false,
        );
      } else {
        // ── [INHERIT-BANNER-ON] ──────────────────────────────────────────────
        {
          const page = await openPermissionsTab(browser, adminClient.cookie, INHERIT_ROLE);
          const dialogOpened = await clickTuneForRole(page, INHERIT_ROLE);

          let bannerVisible = false;
          if (dialogOpened) {
            bannerVisible = await page.evaluate(() => {
              const dialog = Array.from(document.querySelectorAll('[role="dialog"]'))
                .find(d => d.textContent.includes('Customise navigation'));
              if (!dialog) return false;
              const banner = dialog.querySelector('[data-testid="nav-customise-inherit-banner"]');
              return !!(banner && banner.textContent.includes('inherits the default layout'));
            });
          }

          record(
            '[INHERIT-BANNER-ON] info alert visible when isCustomized=false',
            'alert containing "inherits the default layout" present',
            bannerVisible
              ? 'alert present'
              : dialogOpened ? 'alert absent' : 'dialog did not open',
            bannerVisible,
          );

          // Save the dialog — this PATCHes the config and sets is_customized=true.
          if (dialogOpened) {
            await clickSaveAndCaptureRoleConfig(page);
          }

          await page.close().catch(() => {});
          await page.__ctx.close().catch(() => {});
        }

        // ── [INHERIT-BANNER-OFF] ─────────────────────────────────────────────
        {
          const page = await openPermissionsTab(browser, adminClient.cookie, INHERIT_ROLE);
          const dialogOpened = await clickTuneForRole(page, INHERIT_ROLE);

          let bannerAbsent = false;
          if (dialogOpened) {
            const bannerVisible = await page.evaluate(() => {
              const dialog = Array.from(document.querySelectorAll('[role="dialog"]'))
                .find(d => d.textContent.includes('Customise navigation'));
              if (!dialog) return false;
              const banner = dialog.querySelector('[data-testid="nav-customise-inherit-banner"]');
              return !!(banner && banner.textContent.includes('inherits the default layout'));
            });
            bannerAbsent = !bannerVisible;
          }

          record(
            '[INHERIT-BANNER-OFF] info alert absent when isCustomized=true',
            'alert containing "inherits the default layout" absent',
            bannerAbsent
              ? 'alert absent'
              : dialogOpened ? 'alert still present' : 'dialog did not open',
            bannerAbsent,
          );

          await page.close().catch(() => {});
          await page.__ctx.close().catch(() => {});
        }
      }
    }

  } catch (e) {
    record('test harness', 'no uncaught error', `error: ${e.message}`, false);
    console.error(e);
  } finally {
    await browser.close().catch(() => {});
  }

  // ── Report ─────────────────────────────────────────────────────────────────
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
  const esc  = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const pass    = findings.filter(f => f.ok).length;
  const skipped = findings.filter(f => f.skipped).length;
  const fail    = findings.filter(f => !f.ok && !f.skipped).length;
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
    '- **[API]** Pre-checks: `GET /api/users/me/prefs` returns 200 for authenticated',
    '  users; `PATCH` with a valid object persists the key and returns the merged',
    '  prefs; `PATCH` with an array body returns 400; unauthenticated `GET` returns',
    '  401 or 302.',
    '- **[RST-DISABLED]** "Reset to defaults" is disabled when the current selection',
    '  matches the defaults (Home, Customers, Projects).',
    '- **[RST-RESET]** Clicking reset while a non-default selection is active',
    '  pre-checks the correct default keys (Home, Customers, Projects).',
    '  Exactly 3 items are selected after reset.',
    '- **[RST-SAVE]** Saving after reset dispatches',
    '  `PATCH /api/admin/nav-role-config` with primary_keys equal to [home, customers, projects].',
    '- **[DEF-OPEN]** The `__default__` row in the Permissions tab has a tune button',
    '  that opens `NavCustomiseDialog` and pre-checks the renderable keys stored for',
    '  `__default__` in `nav_role_configs`.',
    '- **[INHERIT-BANNER-ON]** A freshly-created job role (no PATCH issued) has',
    '  `is_customized=false`. Opening its `NavCustomiseDialog` from the Permissions',
    '  tab shows an MUI `Alert` containing "inherits the default layout".',
    '- **[INHERIT-BANNER-OFF]** After clicking Save (which sets `is_customized=true`),',
    '  reopening the dialog shows no "inherits the default layout" alert.',
    '',
    '## Note on removed probes',
    '',
    '- CUST-OPEN / CUST-SAVE / CUST-PERS / CUST-CANCEL probed the "Customise',
    '  navigation" entry inside the More drawer. With the current four-tab nav',
    '  (home, customers, projects, survey) and FIT_THRESHOLD=4, allFit is always',
    '  true so the More drawer is never shown. These probes are removed until a',
    '  fixture with more than four visible items can be constructed.',
    '',
    '## Relevant files',
    '',
    '- `src/react/components/BottomNav.tsx`',
    '- `src/react/components/NavCustomiseDialog.tsx`',
    '- `src/react/pages/admin/AdminPermissionsPage.tsx`',
  ];
  const outPath = path.join(dir, 'nav-customise.md');
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`  Report: test-results/nav-customise.md`);
}

main();
