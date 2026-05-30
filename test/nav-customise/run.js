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
//   [RST-DISABLED] Reset button is disabled when selection already matches the
//                  role defaults.
//   [RST-RESET]    Clicking reset pre-selects the correct default keys when
//                  the dialog is opened with a non-default selection active.
//   [RST-SAVE]     Saving after reset calls PATCH /api/admin/nav-role-config
//                  with the default primary_keys array.
//   [DEF-OPEN]     __default__ row tune button opens NavCustomiseDialog and
//                  pre-checks exactly the keys stored in nav_role_configs for
//                  __default__.
//   [DEF-SAVE]     Saving from the __default__ row dispatches
//                  PATCH /api/admin/nav-role-config/__default__ with the
//                  correct primary_keys body.
//   [INHERIT-BANNER-ON]  Opening the dialog for a role with is_customized=false
//                  shows an info Alert ("inherits the default layout").
//   [INHERIT-BANNER-OFF] After saving a custom layout (is_customized=true),
//                  reopening the dialog shows no "inherits" Alert.
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

    const labels = Array.from(dialog.querySelectorAll('.MuiFormControlLabel-root'));
    const checkedKeys = [];
    for (const lbl of labels) {
      const input = lbl.querySelector('input[type="checkbox"]');
      const span  = lbl.querySelector('.MuiFormControlLabel-label');
      if (input && input.checked && span) {
        checkedKeys.push(span.textContent.trim());
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
 *
 * Intentionally uses an inline interaction loop rather than pollFn/pollUntil:
 * each iteration reads current checkbox state, performs clicks as side effects,
 * then re-evaluates.  The loop body is not a pure condition — it drives UI
 * state changes — so the polling helpers are not appropriate here.
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

/**
 * Wait for the __default__ row to appear inside the Permissions tab panel.
 * The row is identified by a <p> element with exact text
 * "Default (all other roles)" — it lives outside #roles-list, after the
 * Divider that separates named roles from the fallback row.
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
 *
 * Strategy: find the <p> whose text is "Default (all other roles)", walk up
 * the DOM to the nearest ancestor that contains at least one <button>, then
 * click the first button in that row (the tune button — the __default__ row
 * has no "Remove role" button, so there is exactly one).
 *
 * Note: MUI <Tooltip title="…"> does NOT propagate the title attribute to
 * the rendered <button>, so we cannot use button[title="…"] selectors.
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
    findings.push({ name, expected, observed, ok });
    const mark = ok ? '  ✓' : '  ✗';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
    }
  }

  // RST probe constants
  const TEST_ROLE      = `privtest-nav-${runId}`;
  const DEFAULT_LABELS = ['Home', 'Calendar', 'Trades'];
  const NON_DEFAULT_KEYS = ['home', 'sales', 'calendar'];

  // INHERIT-BANNER probe constants
  const INHERIT_ROLE = `privtest-inherit-${runId}`;

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    // Remove the RST and INHERIT-BANNER test job roles via API (best-effort, server must still be up)
    try {
      const adminCookie = (await login(users.admin.email, PASSWORD)).cookie;
      await apiFetch(adminCookie, 'DELETE', `/api/admin/job-roles/${encodeURIComponent(TEST_ROLE)}`);
      await apiFetch(adminCookie, 'DELETE', `/api/admin/job-roles/${encodeURIComponent(INHERIT_ROLE)}`);
    } catch {}
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    // nav_role_configs has no FK cascade from job_roles; clean up directly.
    try {
      await pool.query(`DELETE FROM nav_role_configs WHERE role_name LIKE 'privtest-%'`);
    } catch {}
    // Remove any __default__ config written by [DEF-OPEN] / [DEF-SAVE] probes.
    try {
      await pool.query(`DELETE FROM nav_role_configs WHERE role_name = '__default__'`);
    } catch {}
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
  const adminClient   = await login(users.admin.email,   PASSWORD);

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

  // ── RST API setup: create test job role with non-default nav keys ──────────

  console.log(`\n  Setup: creating test job role "${TEST_ROLE}" with non-default nav keys`);
  {
    const r1 = await apiFetch(
      adminClient.cookie, 'POST', '/api/admin/job-roles',
      { name: TEST_ROLE, privilege_level: 'member' },
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

        // Before reset: verify a non-default key is checked (e.g. Sales)
        record(
          '[RST-RESET] "Sales" checkbox is checked before reset (part of non-default)',
          'Sales checked',
          stateBefore.checkedKeys.includes('Sales') ? 'Sales checked' : JSON.stringify(stateBefore.checkedKeys),
          stateBefore.checkedKeys.includes('Sales'),
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

        // After reset: "Sales" should no longer be checked (not a default)
        record(
          '[RST-RESET] "Sales" is unchecked after reset (not in defaults)',
          'Sales unchecked',
          !stateAfter.checkedKeys.includes('Sales') ? 'Sales unchecked' : JSON.stringify(stateAfter.checkedKeys),
          !stateAfter.checkedKeys.includes('Sales'),
        );

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
            sentKeys.includes('calendar') &&
            sentKeys.includes('trades');

          record(
            '[RST-SAVE] Sent primary_keys are the default nav keys [home, calendar, trades]',
            'primary_keys=[home,calendar,trades]',
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
      const DEF_PRESET_KEYS   = ['home', 'survey', 'calendar'];
      const DEF_PRESET_LABELS = ['Home', 'Survey', 'Calendar'];

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

        const checkedSorted  = [...state.checkedKeys].sort();
        const expectedSorted = [...DEF_PRESET_LABELS].sort();
        record(
          '[DEF-OPEN] Dialog pre-checks exactly the seeded __default__ keys (Home, Survey, Calendar)',
          `checkedKeys=${JSON.stringify(expectedSorted)}`,
          `checkedKeys=${JSON.stringify(checkedSorted)}`,
          JSON.stringify(checkedSorted) === JSON.stringify(expectedSorted),
        );

        record(
          '[DEF-OPEN] Exactly 3 keys are pre-checked',
          'length=3',
          `length=${state.checkedKeys.length}`,
          state.checkedKeys.length === 3,
        );

        await page.evaluate(() => {
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
          const dialog = dialogs.find(d => d.textContent.includes('Customise navigation')) || null;
          if (!dialog) return;
          const cancelBtn = Array.from(dialog.querySelectorAll('button'))
            .find(b => b.textContent.trim() === 'Cancel');
          if (cancelBtn) cancelBtn.click();
        });
      } else {
        for (const skip of [
          '[DEF-OPEN] Dialog is open (dialogOpen=true)',
          '[DEF-OPEN] Dialog pre-checks exactly the seeded __default__ keys (Home, Survey, Calendar)',
          '[DEF-OPEN] Exactly 3 keys are pre-checked',
        ]) {
          record(skip, 'dialog opened', 'dialog did not open (skipped)', false);
        }
      }

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [DEF-SAVE] Saving from the __default__ row dispatches
    //            PATCH /api/admin/nav-role-config/__default__
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [DEF-SAVE] Saving from __default__ row dispatches PATCH /__default__');
    {
      const DEF_NEW_KEYS   = ['home', 'sales', 'calendar'];
      const DEF_NEW_LABELS = ['Home', 'Sales', 'Calendar'];

      const page = await openPermissionsTab(browser, adminClient.cookie, null);
      await waitForDefaultRow(page);

      const dialogOpened = await clickTuneForDefault(page);
      record(
        '[DEF-SAVE] __default__ dialog opens for save probe',
        'dialog visible',
        dialogOpened ? 'visible' : 'not visible',
        dialogOpened,
      );

      if (dialogOpened) {
        await selectNavItems(page, DEF_NEW_LABELS);

        let capturedBody = null;
        let capturedUrl  = null;

        await page.setRequestInterception(true);
        const handler = (req) => {
          const url    = req.url();
          const method = req.method();
          if (method === 'PATCH' && url.includes('/api/admin/nav-role-config/')) {
            capturedUrl = url;
            try { capturedBody = JSON.parse(req.postData() || 'null'); } catch {}
          }
          req.continue();
        };
        page.on('request', handler);

        await page.evaluate(() => {
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
          const dialog = dialogs.find(d => d.textContent.includes('Customise navigation')) || null;
          if (!dialog) return;
          const saveBtn = Array.from(dialog.querySelectorAll('button'))
            .find(b => b.textContent.trim() === 'Save');
          if (saveBtn && !saveBtn.disabled) saveBtn.click();
        });

        await poll(page, () => {
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
          return dialogs.every(d => !d.textContent.includes('Customise navigation')) ? 'closed' : null;
        }, null, 8000);

        page.off('request', handler);
        await page.setRequestInterception(false);

        record(
          '[DEF-SAVE] PATCH /api/admin/nav-role-config/__default__ was called on save',
          'request captured with URL containing __default__',
          capturedUrl ? `url=${capturedUrl}` : 'no request captured',
          capturedUrl !== null && capturedUrl.includes('__default__'),
        );

        if (capturedBody) {
          const sentKeys = capturedBody.primary_keys;
          const keysMatch =
            Array.isArray(sentKeys) &&
            sentKeys.length === DEF_NEW_KEYS.length &&
            DEF_NEW_KEYS.every(k => sentKeys.includes(k));
          record(
            '[DEF-SAVE] PATCH body primary_keys matches new selection (home, sales, calendar)',
            `primary_keys contains [${DEF_NEW_KEYS.join(',')}]`,
            `primary_keys=${JSON.stringify(sentKeys)}`,
            keysMatch,
          );
        } else {
          record(
            '[DEF-SAVE] PATCH body primary_keys matches new selection (home, sales, calendar)',
            `primary_keys contains [${DEF_NEW_KEYS.join(',')}]`,
            'no request body captured',
            false,
          );
        }
      } else {
        for (const skip of [
          '[DEF-SAVE] PATCH /api/admin/nav-role-config/__default__ was called on save',
          '[DEF-SAVE] PATCH body primary_keys matches new selection (home, sales, calendar)',
        ]) {
          record(skip, 'dialog opened', 'dialog did not open (skipped)', false);
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
              const alerts = Array.from(dialog.querySelectorAll('.MuiAlert-root'));
              return alerts.some(a => a.textContent.includes('inherits the default layout'));
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
              const alerts = Array.from(dialog.querySelectorAll('.MuiAlert-root'));
              return alerts.some(a => a.textContent.includes('inherits the default layout'));
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
    '- **[RST-DISABLED]** "Reset to defaults" is disabled when the current selection',
    '  matches the defaults (isAtDefaults=true).',
    '- **[RST-RESET]** Clicking reset while a non-default selection is active',
    '  pre-checks the correct default keys (Home, Calendar, Trades) and unchecks',
    '  non-default ones (e.g. Sales). Exactly 3 items are selected.',
    '- **[RST-SAVE]** Saving after reset dispatches',
    '  `PATCH /api/admin/nav-role-config` with primary_keys equal to the default array.',
    '- **[DEF-OPEN]** The `__default__` row in the Permissions tab has a tune button',
    '  (title="Edit default navigation layout") that opens `NavCustomiseDialog` and',
    '  pre-checks exactly the keys stored for `__default__` in `nav_role_configs`.',
    '- **[DEF-SAVE]** Saving from the `__default__` dialog dispatches',
    '  `PATCH /api/admin/nav-role-config/__default__` with the selected `primary_keys`.',
    '- **[INHERIT-BANNER-ON]** A freshly-created job role (no PATCH issued) has',
    '  `is_customized=false`. Opening its `NavCustomiseDialog` from the Permissions',
    '  tab shows an MUI `Alert` containing "inherits the default layout". Guards the',
    '  `{isCustomized === false && <Alert>…</Alert>}` branch in `NavCustomiseDialog`.',
    '- **[INHERIT-BANNER-OFF]** After clicking Save (which PATCHes the nav config and',
    '  sets `is_customized=true`), reopening the dialog for the same role shows no',
    '  "inherits the default layout" alert — confirming the banner disappears once',
    '  the role has its own custom layout.',
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
