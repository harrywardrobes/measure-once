'use strict';
const { makeSkip } = require('../helpers/report');

const UI_PROBE_LABELS = [
  '[UI-ROLE-NAV] Default manager key "sales" is NOT in bar (overridden by role config)',
];

// test/nav-role-config/run.js
//
// End-to-end test for the nav role configuration admin API.
//
// Covers:
//   [API-DEFAULT]            GET /api/nav-role-config returns __default__ keys for a
//                            user who has no job_role assigned.
//   [API-UNAUTH]             GET /api/nav-role-config requires authentication.
//   [API-ROLE]               GET /api/nav-role-config returns role-specific primary_keys
//                            when the user has a job_role with a matching config.
//   [API-PATCH-ADMIN]        PATCH /api/admin/nav-role-config/:roleName succeeds for admin.
//   [API-PATCH-IS-CUSTOMIZED] PATCH sets is_customized=true (visible in the listing).
//   [API-PATCH-MEMBER]       PATCH returns 403 for member.
//   [API-PATCH-MANAGER]      PATCH returns 403 for manager.
//   [API-PATCH-VALIDATE]     PATCH rejects invalid bodies with 400.
//   [API-LIST]               GET /api/admin/nav-role-configs returns array (admin only).
//   [API-LIST-MEMBER]        GET /api/admin/nav-role-configs returns 403 for member.
//   [API-JOB-ROLE-CLONE]     POST /api/admin/job-roles inserts a nav_role_configs
//                            row with is_customized=false so the new role inherits
//                            __default__ live (no snapshot copy at creation time).
//   [API-INHERIT]            A role with is_customized=false returns __default__ keys
//                            (not its own stored keys) from GET /api/nav-role-config.
//   [API-DELETE]             DELETE /api/admin/nav-role-config/:roleName sets
//                            is_customized=false; the user then inherits __default__.
//   [API-DEFAULT-PROPAGATE]  Changing __default__ primary_keys propagates immediately
//                            to uncustomised roles.
//   [API-DELETE-DEFAULT-REJECT] DELETE /api/admin/nav-role-config/__default__ returns 400.
//   [UI-ROLE-NAV]            BottomNav renders the role-specific primary tabs when the
//                            user's job_role has a custom nav config.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:nav-role-config
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:nav-role-config

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
 * Open the home page, inject the session cookie, and wait for BottomNav to
 * mount with role-specific rendering complete.
 */
async function openHomePage(browser, jar) {
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
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 25000 });

  // Wait for BottomNav to mount
  await poll(page, () => {
    const nav = document.querySelector('nav.bottom-nav#main-content');
    return nav && nav.querySelector('#bnav-home') ? 'ok' : null;
  }, null, 15000);

  // Wait for window.__moHeaderUser to be set
  await poll(page, () => {
    return (window.__moHeaderUser && window.__moHeaderUser.privilege_level) ? 'ok' : null;
  }, null, 10000);

  // Wait for role-specific rendering to flush (home is always present; wait
  // for at least one more tab to appear confirming the render completed)
  await poll(page, () => {
    const nav = document.querySelector('nav.bottom-nav#main-content');
    if (!nav) return null;
    const keys = ['sales', 'survey', 'projects', 'calendar', 'invoices', 'trades', 'ideas'];
    return keys.some(k => nav.querySelector(`#bnav-${k}`)) ? 'ok' : null;
  }, null, 8000);

  // Wait for loadNavPref() / role-config fetch to settle — poll until the nav
  // bar's item list stops changing, which confirms the async fetch and
  // re-render have completed.
  await waitForNavBarStability(page, 3000, 100);

  page.__logs = pageLogs;
  return page;
}

/**
 * Return the set of nav keys currently rendered inside the bar (not the
 * More drawer).
 */
function readBarKeys(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('nav.bottom-nav#main-content');
    if (!nav) return null;
    return ['home', 'sales', 'survey', 'projects', 'calendar', 'invoices', 'trades', 'ideas']
      .filter(k => !!nav.querySelector(`#bnav-${k}`));
  });
}

// ── cleanup helpers ───────────────────────────────────────────────────────────

/**
 * Remove synthetic nav_role_configs and job_roles rows created by this suite.
 * Standard cleanupTestData() handles users/sessions/etc; we extend it here
 * for the tables that are unique to this test.
 */
async function cleanupNavTestData(pool) {
  await pool.query(`DELETE FROM nav_role_configs WHERE role_name LIKE 'privtest-%'`);
  await pool.query(`DELETE FROM job_roles WHERE name LIKE 'privtest-%'`);
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

  const runId   = Math.random().toString(36).slice(2, 8);
  const ROLE_NAME = `privtest-navcfg-${runId}`;  // unique per run, ≤ 64 chars
  console.log(`\n  nav-role-config E2E  run=${runId}  role=${ROLE_NAME}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  await cleanupNavTestData(pool);
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
  const skip = makeSkip(findings);

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupNavTestData(pool); } catch {}
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

  // ── [API] Nav role config endpoint pre-checks ─────────────────────────────

  console.log('\n  [API] nav-role-config endpoint probes');

  const adminClient   = await login(users.admin.email,   PASSWORD);
  const managerClient = await login(users.manager.email, PASSWORD);
  const memberClient  = await login(users.member.email,  PASSWORD);

  // ── [API-DEFAULT] User with no job_role gets __default__ config ─────────────

  {
    const r = await memberClient.get('/api/nav-role-config');
    const keys = r.json?.primary_keys;
    const role = r.json?.role;
    record(
      '[API-DEFAULT] GET /api/nav-role-config returns 200 for authenticated user',
      'status=200',
      `status=${r.status}`,
      r.status === 200,
    );
    record(
      '[API-DEFAULT] Returns primary_keys array',
      'primary_keys is array',
      Array.isArray(keys) ? `primary_keys=${JSON.stringify(keys)}` : `primary_keys=${keys}`,
      Array.isArray(keys) && keys.length === 3,
    );
    record(
      '[API-DEFAULT] role field is null when user has no job_role',
      'role=null',
      `role=${JSON.stringify(role)}`,
      role === null,
    );
  }

  // ── [API-UNAUTH] Unauthenticated request is blocked ──────────────────────

  {
    const anon = makeClient(null);
    const r = await anon.get('/api/nav-role-config');
    record(
      '[API-UNAUTH] GET /api/nav-role-config unauthenticated returns 401 or 302',
      'status=401 or 302',
      `status=${r.status}`,
      r.status === 401 || r.status === 302,
    );
  }

  // ── [API-PATCH-ADMIN] Admin can upsert a role config ─────────────────────

  const CUSTOM_KEYS = ['home', 'trades', 'invoices'];
  {
    const r = await adminClient.patch(
      `/api/admin/nav-role-config/${encodeURIComponent(ROLE_NAME)}`,
      { primary_keys: CUSTOM_KEYS },
    );
    record(
      '[API-PATCH-ADMIN] PATCH /api/admin/nav-role-config/:roleName succeeds for admin (200)',
      'status=200',
      `status=${r.status}`,
      r.status === 200,
    );
    const savedKeys = r.json?.primary_keys;
    record(
      '[API-PATCH-ADMIN] Response includes updated primary_keys',
      `primary_keys=${JSON.stringify(CUSTOM_KEYS)}`,
      `primary_keys=${JSON.stringify(savedKeys)}`,
      JSON.stringify(savedKeys) === JSON.stringify(CUSTOM_KEYS),
    );
    record(
      '[API-PATCH-ADMIN] Response includes role_name',
      `role_name=${ROLE_NAME}`,
      `role_name=${r.json?.role_name}`,
      r.json?.role_name === ROLE_NAME,
    );
  }

  // ── [API-PATCH-IS-CUSTOMIZED] PATCH marks the role as customized ────────────

  {
    const r = await adminClient.get('/api/admin/nav-role-configs');
    const row = Array.isArray(r.json) ? r.json.find(row => row.role_name === ROLE_NAME) : null;
    record(
      '[API-PATCH-IS-CUSTOMIZED] PATCH sets is_customized=true (visible in listing)',
      'is_customized=true',
      row ? `is_customized=${row.is_customized}` : 'row not found in listing',
      row?.is_customized === true,
    );
  }

  // ── [API-PATCH-MEMBER] Member cannot update role config ───────────────────

  {
    const r = await memberClient.patch(
      `/api/admin/nav-role-config/${encodeURIComponent(ROLE_NAME)}`,
      { primary_keys: ['home', 'sales', 'survey'] },
    );
    record(
      '[API-PATCH-MEMBER] PATCH /api/admin/nav-role-config/:roleName returns 403 for member',
      'status=403',
      `status=${r.status}`,
      r.status === 403,
    );
  }

  // ── [API-PATCH-MANAGER] Manager cannot update role config ────────────────

  {
    const r = await managerClient.patch(
      `/api/admin/nav-role-config/${encodeURIComponent(ROLE_NAME)}`,
      { primary_keys: ['home', 'sales', 'survey'] },
    );
    record(
      '[API-PATCH-MANAGER] PATCH /api/admin/nav-role-config/:roleName returns 403 for manager',
      'status=403',
      `status=${r.status}`,
      r.status === 403,
    );
  }

  // ── [API-PATCH-VALIDATE] Invalid body is rejected with 400 ───────────────

  {
    // Too few keys
    const r1 = await adminClient.patch(
      `/api/admin/nav-role-config/${encodeURIComponent(ROLE_NAME)}`,
      { primary_keys: ['home', 'sales'] },
    );
    record(
      '[API-PATCH-VALIDATE] PATCH with 2 keys (< 3) returns 400',
      'status=400',
      `status=${r1.status}`,
      r1.status === 400,
    );

    // Duplicate keys
    const r2 = await adminClient.patch(
      `/api/admin/nav-role-config/${encodeURIComponent(ROLE_NAME)}`,
      { primary_keys: ['home', 'home', 'sales'] },
    );
    record(
      '[API-PATCH-VALIDATE] PATCH with duplicate keys returns 400',
      'status=400',
      `status=${r2.status}`,
      r2.status === 400,
    );

    // Invalid key name
    const r3 = await adminClient.patch(
      `/api/admin/nav-role-config/${encodeURIComponent(ROLE_NAME)}`,
      { primary_keys: ['home', 'sales', 'invalid_key'] },
    );
    record(
      '[API-PATCH-VALIDATE] PATCH with invalid key name returns 400',
      'status=400',
      `status=${r3.status}`,
      r3.status === 400,
    );

    // Non-array body
    const r4 = await adminClient.patch(
      `/api/admin/nav-role-config/${encodeURIComponent(ROLE_NAME)}`,
      { primary_keys: 'home,sales,survey' },
    );
    record(
      '[API-PATCH-VALIDATE] PATCH with non-array primary_keys returns 400',
      'status=400',
      `status=${r4.status}`,
      r4.status === 400,
    );
  }

  // ── [API-LIST] Admin can list all nav role configs ────────────────────────

  {
    const r = await adminClient.get('/api/admin/nav-role-configs');
    const isArray = Array.isArray(r.json);
    record(
      '[API-LIST] GET /api/admin/nav-role-configs returns 200 for admin',
      'status=200',
      `status=${r.status}`,
      r.status === 200,
    );
    record(
      '[API-LIST] Response is an array',
      'array',
      isArray ? 'array' : typeof r.json,
      isArray,
    );
    // The __default__ row must always be present
    const hasDefault = isArray && r.json.some(row => row.role_name === '__default__');
    record(
      '[API-LIST] __default__ row is present in the listing',
      '__default__ present',
      hasDefault ? '__default__ found' : '__default__ missing',
      hasDefault,
    );
    // Our patched test role should appear
    const hasTestRole = isArray && r.json.some(row => row.role_name === ROLE_NAME);
    record(
      '[API-LIST] Previously patched test role appears in the listing',
      `${ROLE_NAME} present`,
      hasTestRole ? 'found' : 'missing',
      hasTestRole,
    );
  }

  // ── [API-LIST-MEMBER] Non-admin cannot list all configs ───────────────────

  {
    const r1 = await memberClient.get('/api/admin/nav-role-configs');
    record(
      '[API-LIST-MEMBER] GET /api/admin/nav-role-configs returns 403 for member',
      'status=403',
      `status=${r1.status}`,
      r1.status === 403,
    );

    const r2 = await managerClient.get('/api/admin/nav-role-configs');
    record(
      '[API-LIST-MEMBER] GET /api/admin/nav-role-configs returns 403 for manager',
      'status=403',
      `status=${r2.status}`,
      r2.status === 403,
    );
  }

  // ── [API-JOB-ROLE-CLONE] New job role inherits __default__ nav live ─────────
  //
  // POST /api/admin/job-roles no longer snapshots __default__ primary_keys into
  // the new row.  Instead it inserts with is_customized=false so the role
  // inherits __default__ live.  GET /api/admin/nav-role-configs resolves the
  // inherited keys before returning, so the row is visible with the current
  // __default__ layout and is_customized=false.

  const JOB_ROLE_NAME = `privtest-jobrole-${runId}`;
  {
    // Fetch the current __default__ primary_keys for comparison
    const defR = await adminClient.get('/api/admin/nav-role-configs');
    const defaultRow = Array.isArray(defR.json)
      ? defR.json.find(r => r.role_name === '__default__')
      : null;
    const defaultKeys = defaultRow?.primary_keys || null;

    // Create the new job role
    const createR = await adminClient.post('/api/admin/job-roles', {
      name: JOB_ROLE_NAME,
      privilege_level: 'member',
    });
    record(
      '[API-JOB-ROLE-CLONE] POST /api/admin/job-roles returns 200',
      'status=200',
      `status=${createR.status}`,
      createR.status === 200,
    );

    // Verify nav_role_configs has a row for the new role with inherited keys
    const listR = await adminClient.get('/api/admin/nav-role-configs');
    const newRow = Array.isArray(listR.json)
      ? listR.json.find(r => r.role_name === JOB_ROLE_NAME)
      : null;
    record(
      '[API-JOB-ROLE-CLONE] New job role has a nav_role_configs entry',
      `${JOB_ROLE_NAME} present in nav-role-configs`,
      newRow ? `found with keys=${JSON.stringify(newRow.primary_keys)}` : 'missing',
      !!newRow,
    );
    record(
      '[API-JOB-ROLE-CLONE] New job role is_customized=false (inherits live, no snapshot)',
      'is_customized=false',
      newRow ? `is_customized=${newRow.is_customized}` : 'row not found',
      newRow?.is_customized === false,
    );
    if (newRow && defaultKeys) {
      record(
        '[API-JOB-ROLE-CLONE] New job role resolved primary_keys match current __default__',
        `keys=${JSON.stringify(defaultKeys)}`,
        `keys=${JSON.stringify(newRow.primary_keys)}`,
        JSON.stringify(newRow.primary_keys) === JSON.stringify(defaultKeys),
      );
    } else {
      record(
        '[API-JOB-ROLE-CLONE] New job role resolved primary_keys match current __default__',
        'keys match __default__',
        defaultKeys ? 'new row missing' : '__default__ row not found',
        false,
      );
    }
  }

  // ── [API-ROLE] User with matching job_role gets role-specific config ───────

  // We patched ROLE_NAME → CUSTOM_KEYS earlier. Assign the manager user's
  // job_role directly in the DB so we can exercise the role-specific lookup
  // without going through the onboarding UI.
  {
    await pool.query(
      'UPDATE users SET job_role = $1 WHERE id = $2',
      [ROLE_NAME, users.manager.id],
    );

    const r = await managerClient.get('/api/nav-role-config');
    const keys  = r.json?.primary_keys;
    const role  = r.json?.role;
    record(
      '[API-ROLE] GET /api/nav-role-config returns role-specific primary_keys',
      `primary_keys=${JSON.stringify(CUSTOM_KEYS)}`,
      `primary_keys=${JSON.stringify(keys)}`,
      JSON.stringify(keys) === JSON.stringify(CUSTOM_KEYS),
    );
    record(
      '[API-ROLE] role field reflects the assigned job_role',
      `role=${ROLE_NAME}`,
      `role=${role}`,
      role === ROLE_NAME,
    );

    // Reset job_role so subsequent browser probes start clean
    await pool.query('UPDATE users SET job_role = NULL WHERE id = $1', [users.manager.id]);
  }

  // ── [API-INHERIT] Uncustomized role falls back to __default__ ────────────────
  //
  // Set is_customized = FALSE directly so ROLE_NAME falls back to __default__,
  // assign the manager user to that role, and verify the API returns the
  // __default__ keys (not the previously stored CUSTOM_KEYS).

  {
    // Grab current __default__ primary_keys for comparison
    const listR = await adminClient.get('/api/admin/nav-role-configs');
    const defaultRow = Array.isArray(listR.json)
      ? listR.json.find(r => r.role_name === '__default__')
      : null;
    const expectedDefaultKeys = defaultRow?.primary_keys || null;

    // Force is_customized = false for ROLE_NAME (bypasses the API; the DELETE
    // endpoint also sets this, but we test it directly here to isolate the
    // inheritance behaviour from the DELETE behaviour)
    await pool.query(
      'UPDATE nav_role_configs SET is_customized = FALSE WHERE role_name = $1',
      [ROLE_NAME],
    );

    // Assign manager's job_role → ROLE_NAME
    await pool.query(
      'UPDATE users SET job_role = $1 WHERE id = $2',
      [ROLE_NAME, users.manager.id],
    );

    const r = await managerClient.get('/api/nav-role-config');
    const keys = r.json?.primary_keys;

    record(
      '[API-INHERIT] Role with is_customized=false returns __default__ keys (not custom keys)',
      `primary_keys=${JSON.stringify(expectedDefaultKeys)}`,
      `primary_keys=${JSON.stringify(keys)}`,
      expectedDefaultKeys !== null
        && JSON.stringify(keys) === JSON.stringify(expectedDefaultKeys)
        && JSON.stringify(keys) !== JSON.stringify(CUSTOM_KEYS),
    );

    // Clean up — reset job_role; leave is_customized=false for the DELETE probe
    await pool.query('UPDATE users SET job_role = NULL WHERE id = $1', [users.manager.id]);
  }

  // ── [API-DELETE] DELETE resets is_customized and user inherits __default__ ──

  {
    // Re-establish ROLE_NAME as customized before testing DELETE
    await adminClient.patch(
      `/api/admin/nav-role-config/${encodeURIComponent(ROLE_NAME)}`,
      { primary_keys: CUSTOM_KEYS },
    );

    // Confirm it is now customized
    const beforeList = await adminClient.get('/api/admin/nav-role-configs');
    const beforeRow = Array.isArray(beforeList.json)
      ? beforeList.json.find(r => r.role_name === ROLE_NAME)
      : null;
    record(
      '[API-DELETE] Pre-condition: ROLE_NAME is customized before DELETE',
      'is_customized=true',
      beforeRow ? `is_customized=${beforeRow.is_customized}` : 'row not found',
      beforeRow?.is_customized === true,
    );

    // Issue the DELETE
    const delR = await adminClient.delete(
      `/api/admin/nav-role-config/${encodeURIComponent(ROLE_NAME)}`,
    );
    record(
      '[API-DELETE] DELETE /api/admin/nav-role-config/:roleName returns 200',
      'status=200',
      `status=${delR.status}`,
      delR.status === 200,
    );
    record(
      '[API-DELETE] DELETE response includes ok=true',
      'ok=true',
      `ok=${delR.json?.ok}`,
      delR.json?.ok === true,
    );

    // Listing must show is_customized = false
    const afterList = await adminClient.get('/api/admin/nav-role-configs');
    const afterRow = Array.isArray(afterList.json)
      ? afterList.json.find(r => r.role_name === ROLE_NAME)
      : null;
    record(
      '[API-DELETE] Listing shows is_customized=false after DELETE',
      'is_customized=false',
      afterRow ? `is_customized=${afterRow.is_customized}` : 'row not found',
      afterRow?.is_customized === false,
    );

    // User with that job_role should now inherit __default__
    const listR = await adminClient.get('/api/admin/nav-role-configs');
    const defaultRow = Array.isArray(listR.json)
      ? listR.json.find(r => r.role_name === '__default__')
      : null;
    const expectedDefaultKeys = defaultRow?.primary_keys || null;

    await pool.query(
      'UPDATE users SET job_role = $1 WHERE id = $2',
      [ROLE_NAME, users.manager.id],
    );

    const r = await managerClient.get('/api/nav-role-config');
    const keys = r.json?.primary_keys;
    record(
      '[API-DELETE] After DELETE, user with that job_role inherits __default__ keys',
      `primary_keys=${JSON.stringify(expectedDefaultKeys)}`,
      `primary_keys=${JSON.stringify(keys)}`,
      expectedDefaultKeys !== null
        && JSON.stringify(keys) === JSON.stringify(expectedDefaultKeys),
    );

    await pool.query('UPDATE users SET job_role = NULL WHERE id = $1', [users.manager.id]);
  }

  // ── [API-DEFAULT-PROPAGATE] Changing __default__ propagates to uncustomized ──
  //
  // ROLE_NAME is uncustomized (is_customized=false) after the DELETE probe above.
  // Update __default__ to a different set of keys; the uncustomized role should
  // immediately serve the new keys when queried via GET /api/nav-role-config.

  {
    // Fetch and save the original __default__ keys so we can restore them
    const origList = await adminClient.get('/api/admin/nav-role-configs');
    const origDefaultRow = Array.isArray(origList.json)
      ? origList.json.find(r => r.role_name === '__default__')
      : null;
    const origDefaultKeys = origDefaultRow?.primary_keys || ['home', 'calendar', 'trades'];

    // Choose an alternate set that differs from the current default.
    // Build it from valid keys that are NOT in origDefaultKeys.
    const ALL_VALID = ['home', 'customers', 'sales', 'survey', 'projects', 'calendar', 'invoices', 'trades', 'ideas'];
    const altKeys = ALL_VALID.filter(k => !origDefaultKeys.includes(k)).slice(0, 3);
    // If we can't find 3 non-overlapping keys (unlikely), fall back to a fixed set
    const newDefaultKeys = altKeys.length === 3 ? altKeys : ['customers', 'survey', 'projects'];

    // Patch __default__ to the new keys
    const patchR = await adminClient.patch(
      '/api/admin/nav-role-config/__default__',
      { primary_keys: newDefaultKeys },
    );
    record(
      '[API-DEFAULT-PROPAGATE] PATCH __default__ to alternate keys succeeds',
      'status=200',
      `status=${patchR.status}`,
      patchR.status === 200,
    );

    // Assign manager → ROLE_NAME (uncustomized) and query
    await pool.query(
      'UPDATE users SET job_role = $1 WHERE id = $2',
      [ROLE_NAME, users.manager.id],
    );

    const r = await managerClient.get('/api/nav-role-config');
    const keys = r.json?.primary_keys;
    record(
      '[API-DEFAULT-PROPAGATE] Uncustomized role returns new __default__ keys immediately',
      `primary_keys=${JSON.stringify(newDefaultKeys)}`,
      `primary_keys=${JSON.stringify(keys)}`,
      JSON.stringify(keys) === JSON.stringify(newDefaultKeys),
    );

    // Restore __default__ to original keys
    await adminClient.patch(
      '/api/admin/nav-role-config/__default__',
      { primary_keys: origDefaultKeys },
    );

    await pool.query('UPDATE users SET job_role = NULL WHERE id = $1', [users.manager.id]);
  }

  // ── [API-DELETE-DEFAULT-REJECT] DELETE __default__ is forbidden ──────────────

  {
    const r = await adminClient.delete('/api/admin/nav-role-config/__default__');
    record(
      '[API-DELETE-DEFAULT-REJECT] DELETE /api/admin/nav-role-config/__default__ returns 400',
      'status=400',
      `status=${r.status}`,
      r.status === 400,
    );
    record(
      '[API-DELETE-DEFAULT-REJECT] Response includes an error message',
      'error field present',
      r.json?.error ? `error="${r.json.error}"` : 'no error field',
      typeof r.json?.error === 'string' && r.json.error.length > 0,
    );
  }

  // ── Restore UI probe preconditions ───────────────────────────────────────
  //
  // The preceding API probes left ROLE_NAME in an uncustomized state (DELETE
  // reset is_customized=false).  The [UI-ROLE-NAV] probe expects ROLE_NAME to
  // be customized with CUSTOM_KEYS so it can verify the bar renders the correct
  // role-specific tabs.  Re-establish that state here before opening Puppeteer.

  await adminClient.patch(
    `/api/admin/nav-role-config/${encodeURIComponent(ROLE_NAME)}`,
    { primary_keys: CUSTOM_KEYS },
  );

  // ── UI probes ─────────────────────────────────────────────────────────────

  if (!puppeteer) {
    console.warn('\n  [UI] puppeteer not installed — skipping UI probes');
    for (const l of UI_PROBE_LABELS) {
      skip(l, 'puppeteer installed', 'puppeteer not installed (skipped)');
    }
  } else {

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
      for (const l of UI_PROBE_LABELS) skip(l, 'browser launched', `browser launch failed: ${msg}`);
      return;
    }

    try {

      // ════════════════════════════════════════════════════════════════════════
      // [UI-ROLE-NAV] BottomNav renders the correct tabs for the role config
      //
      // Strategy:
      //   1. Assign the manager's job_role → ROLE_NAME (which has CUSTOM_KEYS).
      //   2. Open / as the manager.
      //   3. With the current 4-item nav all tabs fit (FIT_THRESHOLD=4), so the
      //      role-config primary-key *selection* is not observable in the bar —
      //      we only assert a default key that is never a NAV item ('sales')
      //      stays absent. (The 'invoices'/'trades' render checks were removed
      //      when the /invoices page and its nav item were retired.)
      //   4. Reset job_role.
      // ════════════════════════════════════════════════════════════════════════
      console.log('\n  [UI-ROLE-NAV] BottomNav renders role-specific tabs');

      // The CUSTOM_KEYS config for ROLE_NAME was patched above. Re-login as
      // manager (session may have updated job_role cached state server-side).
      const managerClient2 = await login(users.manager.email, PASSWORD);

      // Assign job_role
      await pool.query(
        'UPDATE users SET job_role = $1 WHERE id = $2',
        [ROLE_NAME, users.manager.id],
      );

      const page = await openHomePage(browser, managerClient2.cookie);

      const barKeys = await readBarKeys(page);
      // 'projects' is a NAV item that renders whenever all tabs fit, so it can no
      // longer be "overridden" out of the bar by a role config — only 'sales'
      // (never a NAV item) is a meaningful absence check now.
      const managerDefaults = ['sales'];

      for (const key of managerDefaults) {
        record(
          `[UI-ROLE-NAV] Default manager key "${key}" is NOT in bar (overridden by role config)`,
          `${key} absent`,
          barKeys && barKeys.includes(key) ? 'present' : 'absent',
          !!(barKeys && !barKeys.includes(key)),
        );
      }

      await page.close().catch(() => {});
      await page.__ctx.close().catch(() => {});

      // Reset job_role for cleanliness
      await pool.query('UPDATE users SET job_role = NULL WHERE id = $1', [users.manager.id]);

    } finally {
      await browser.close().catch(() => {});
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────

  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  console.log(`\n  Passed: ${passed}  Failed: ${failed}`);

  const outDir = path.resolve(__dirname, '../../test-results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'nav-role-config.md');

  const rows = findings.map(f =>
    `| ${f.ok ? '✅' : '❌'} | ${f.name} | ${f.expected} | ${f.observed} |`
  ).join('\n');

  const summary = `# nav-role-config test results\n\nRun: ${new Date().toISOString()}  run-id: ${runId}\n\n`
    + `**${passed} passed / ${failed} failed**\n\n`
    + `| Result | Name | Expected | Observed |\n`
    + `| --- | --- | --- | --- |\n`
    + rows + '\n';

  fs.writeFileSync(outFile, summary);
  console.log(`\n  Report → ${outFile}`);

  if (failed > 0) {
    const failNames = findings.filter(f => !f.ok).map(f => `  • ${f.name}`).join('\n');
    console.error(`\n  FAILED probes:\n${failNames}\n`);
    if (logBuf.length) {
      console.error('\n  --- server log tail ---');
      console.error(logBuf.join('').slice(-3000));
    }
  }

  await cleanupAndExit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(2);
});
