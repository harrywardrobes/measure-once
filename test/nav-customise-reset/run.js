'use strict';
// test/nav-customise-reset/run.js
//
// End-to-end tests for the "Reset to defaults" button in NavCustomiseDialog.
// Verifies:
//
//   [RST-DISABLED] Reset button is disabled when selection already matches the
//                  role defaults.
//   [RST-RESET]    Clicking reset pre-selects the correct default keys when
//                  the dialog is opened with a non-default selection active.
//   [RST-SAVE]     Saving after reset calls PATCH /api/admin/nav-role-config
//                  with the default primary_keys array.
//
// The test seeds a temporary job role with non-default nav keys via the API,
// exercises the dialog through the admin Permissions tab, then cleans up.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:nav-customise-reset
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:nav-customise-reset

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
 * Navigate to /admin and switch to the permissions tab, then wait for a
 * specific role name to appear in the roles list (so data has fully loaded).
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
      // Look for a <p> or <span> containing exactly the role name
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
 *
 * Strategy: find the row that contains a <p> with the exact role name text,
 * then click the button in that row that does NOT have title="Remove role"
 * (which is the delete button). The tune button is the only other <button>
 * in the row.
 *
 * Returns true if the dialog opened.
 */
async function clickTuneForRole(page, roleName) {
  await page.evaluate((name) => {
    const panel = document.getElementById('tab-permissions');
    if (!panel) return;
    const rolesList = panel.querySelector('#roles-list');
    if (!rolesList) return;

    // Find the innermost element whose text exactly matches the role name
    const allPs = Array.from(rolesList.querySelectorAll('p'));
    let targetRow = null;
    for (const p of allPs) {
      if (p.textContent.trim() === name) {
        // Walk up to find the direct row container (the Stack with direction=row)
        let node = p.parentElement;
        for (let i = 0; i < 6; i++) {
          if (!node) break;
          // The role row has multiple buttons; stop when we find one
          const btns = node.querySelectorAll('button');
          if (btns.length >= 2) { targetRow = node; break; }
          node = node.parentElement;
        }
        if (targetRow) break;
      }
    }

    if (!targetRow) return;

    // Click the tune button: the button whose title is NOT "Remove role"
    const buttons = Array.from(targetRow.querySelectorAll('button'));
    for (const btn of buttons) {
      if (btn.title !== 'Remove role') {
        btn.click();
        return;
      }
    }
  }, roleName);

  // Wait for the NavCustomiseDialog to open (MUI renders multiple [role=dialog]
  // elements — check ALL of them for the expected title text).
  const opened = await poll(page, () => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    return dialogs.some(d => d.textContent.includes('Customise navigation')) ? 'ok' : null;
  }, null, 8000);

  return opened === 'ok';
}

/**
 * Return the NavCustomiseDialog element (the [role="dialog"] that contains
 * "Customise navigation" text), or null if not found.
 * MUI renders multiple [role="dialog"] elements; we need the correct one.
 */
function findCustomiseDialog() {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
  return dialogs.find(d => d.textContent.includes('Customise navigation')) || null;
}

/**
 * Read the state of the NavCustomiseDialog:
 * - resetDisabled: whether the "Reset to defaults" button is disabled
 * - checkedKeys: which nav keys currently have their checkbox checked (by label text)
 * - dialogOpen: whether the dialog is visible
 */
function readDialogState(page) {
  return page.evaluate(() => {
    function findCustomiseDialog() {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      return dialogs.find(d => d.textContent.includes('Customise navigation')) || null;
    }
    const dialog = findCustomiseDialog();
    if (!dialog) {
      return { dialogOpen: false, resetDisabled: null, checkedKeys: [] };
    }

    // Find "Reset to defaults" button
    const buttons = Array.from(dialog.querySelectorAll('button'));
    const resetBtn = buttons.find(b => b.textContent.trim() === 'Reset to defaults');
    const resetDisabled = resetBtn ? resetBtn.disabled : null;

    // Find checked nav items by looking at checkboxes and their sibling labels
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
 * Click the "Reset to defaults" button in the open dialog.
 */
async function clickReset(page) {
  await page.evaluate(() => {
    function findCustomiseDialog() {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      return dialogs.find(d => d.textContent.includes('Customise navigation')) || null;
    }
    const dialog = findCustomiseDialog();
    if (!dialog) return;
    const buttons = Array.from(dialog.querySelectorAll('button'));
    const resetBtn = buttons.find(b => b.textContent.trim() === 'Reset to defaults');
    if (resetBtn && !resetBtn.disabled) resetBtn.click();
  });
  // Give React a tick to update state
  await new Promise(r => setTimeout(r, 300));
}

/**
 * Click the "Save" button in the open dialog and return the body that was
 * sent to the matching PATCH endpoint (captured via request interception).
 */
async function clickSaveAndCapture(page, roleNameFragment) {
  let capturedBody = null;

  await page.setRequestInterception(true);
  const handler = (req) => {
    const url = req.url();
    const method = req.method();
    if (method === 'PATCH' && url.includes('/api/admin/nav-role-config/')) {
      try {
        capturedBody = JSON.parse(req.postData() || 'null');
      } catch {}
    }
    req.continue();
  };
  page.on('request', handler);

  await page.evaluate(() => {
    function findCustomiseDialog() {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      return dialogs.find(d => d.textContent.includes('Customise navigation')) || null;
    }
    const dialog = findCustomiseDialog();
    if (!dialog) return;
    const buttons = Array.from(dialog.querySelectorAll('button'));
    const saveBtn = buttons.find(b => b.textContent.trim() === 'Save');
    if (saveBtn && !saveBtn.disabled) saveBtn.click();
  });

  // Wait for the dialog to close (save succeeded) or for the request to fire
  await poll(page, () => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    return dialogs.every(d => !d.textContent.includes('Customise navigation')) ? 'closed' : null;
  }, null, 8000);

  page.off('request', handler);
  await page.setRequestInterception(false);

  return capturedBody;
}

// ── HTTP helpers (for API setup/teardown without browser) ─────────────────────

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

  const bundlePath = path.resolve(__dirname, '..', '..', 'public', 'react', 'main.js');
  if (!fs.existsSync(bundlePath)) {
    console.error(
      '\n  ✘ public/react/main.js is missing.\n'
      + '    Run `npm run build:react` before this test.\n',
    );
    process.exit(2);
  }

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  nav-customise-reset — E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  if (!puppeteer) {
    console.error('[nav-customise-reset] puppeteer is not installed — cannot run UI probes.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);
  console.log(`  Seeded  admin=${users.admin.email}`);

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

  // Test role name — uses privtest- prefix so cleanupTestData doesn't remove
  // it (nav_role_configs are cleaned up explicitly below).
  const TEST_ROLE = `privtest-nav-${runId}`;
  const DEFAULT_LABELS = ['Home', 'Calendar', 'Trades'];
  const NON_DEFAULT_KEYS = ['home', 'sales', 'calendar'];

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    // Remove the test job role via API (best-effort, server must still be up)
    try {
      const adminCookie = (await login(users.admin.email, users.admin.password)).cookie;
      await apiFetch(adminCookie, 'DELETE', `/api/admin/job-roles/${encodeURIComponent(TEST_ROLE)}`);
    } catch {}
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    // nav_role_configs has no FK cascade from job_roles; clean up directly.
    try {
      await pool.query(`DELETE FROM nav_role_configs WHERE role_name LIKE 'privtest-%'`);
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

  const adminClient = await login(users.admin.email, users.admin.password);

  // ── API setup: create test job role with non-default nav keys ───────────────
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
    // Set nav config to non-default keys (home, sales, calendar)
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

  const executablePath = findChromium();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    defaultViewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {

    // ══════════════════════════════════════════════════════════════════════════
    // [RST-DISABLED] Reset button is disabled when selection already matches
    //                the defaults — use __default__ role (always home/calendar/
    //                trades) if it appears in the job-roles list, otherwise use
    //                the first role whose nav config equals the defaults.
    //
    //                Alternatively, open dialog for our test role, reset it, and
    //                verify the button is disabled before clicking Save.
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n  [RST-DISABLED] Reset button disabled when already at defaults');
    {
      const page = await openPermissionsTab(browser, adminClient.cookie, TEST_ROLE);

      // Open the dialog for our test role (currently non-default).
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

      // Close without saving (use Cancel button)
      await page.evaluate(() => {
        function findCustomiseDialog() {
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
          return dialogs.find(d => d.textContent.includes('Customise navigation')) || null;
        }
        const dialog = findCustomiseDialog();
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
        const capturedBody = await clickSaveAndCapture(page, TEST_ROLE);

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
    '# nav-customise-reset — E2E',
    '',
    `- Date    : ${new Date().toISOString()}`,
    `- Run ID  : ${runId}`,
    `- Command : \`npm run test:nav-customise-reset\``,
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
    '- **[RST-DISABLED]** "Reset to defaults" is disabled when the current selection matches',
    '                     the defaults (isAtDefaults=true).',
    '- **[RST-RESET]**    Clicking reset while a non-default selection is active pre-checks',
    '                     the correct default keys (Home, Calendar, Trades) and unchecks',
    '                     non-default ones (e.g. Sales). Exactly 3 items are selected.',
    '- **[RST-SAVE]**     Saving after reset dispatches PATCH /api/admin/nav-role-config',
    '                     with primary_keys equal to the default array.',
    '',
    '## Relevant files',
    '',
    '- `src/react/components/NavCustomiseDialog.tsx`',
    '- `src/react/pages/admin/AdminPermissionsPage.tsx`',
  ];
  const outPath = path.join(dir, 'nav-customise-reset.md');
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`  Report: test-results/nav-customise-reset.md`);
}

main();
