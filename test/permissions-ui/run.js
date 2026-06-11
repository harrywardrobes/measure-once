'use strict';
const { makeSkip } = require('../helpers/report');

const PROBE_LABELS = [
  '[ICON-DELETE] "Remove role" button renders MUI Delete (trash-can) icon SVG',
  '[ICON-NOT-CLOSE] no Close icon in "Remove role" buttons',
  '[ICON-TUNE] Tune icon is distinct from both Delete and Close',
  '[PERMISSIONS-TAB] Permissions tab activates and job roles list renders',
  '[RUNTIME] no JS errors during Permissions tab load',
];

// test/permissions-ui/run.js
//
// End-to-end test for the Permissions page (Admin > Permissions tab).
//
// Covers:
//   [ICON-DELETE]  The "Remove role" icon button inside the Job Roles card
//                  renders the MUI Delete icon (trash-can) SVG path, not the
//                  MUI Close icon (✕) path.  Regression guard
//                  where a copy-paste error caused CloseIcon to be rendered.
//   [ICON-NOT-CLOSE]  Negative assertion: none of the "Remove role" buttons
//                     contain the Close icon path.
//   [ICON-TUNE]    The "Edit navigation layout" tune icon button in the
//                  same row contains a different SVG path from both Delete
//                  and Close, confirming it is not accidentally mis-typed.
//
// Strategy:
//   1. Seed an admin user and a test job role via the API.
//   2. Open /admin in Puppeteer as that admin.
//   3. Activate the Permissions tab via window.switchTab('permissions').
//   4. Wait for the role list to render (polls for the "Remove role" button).
//   5. Read the SVG <path d="…"> from the icon buttons and compare to the
//      known MUI SVG path constants.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:permissions-ui
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:permissions-ui

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
  PASSWORD,
  BASE,
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil, waitForSwitchTab } = require('../helpers/poll');

// ── SVG path constants (MUI v5) ───────────────────────────────────────────────
//
// These are the literal `d` attribute values extracted from the MUI icon
// package source.  If MUI ever changes them, the test will catch the drift.
//
// @mui/icons-material/Delete:
const MUI_DELETE_PATH =
  'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z';
// @mui/icons-material/Close:
const MUI_CLOSE_PATH =
  'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

async function pollPage(page, fn, arg, timeoutMs = 8000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
}

function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'permissions-ui.md');
  const passed  = findings.filter(f => f.ok).length;
  const failed  = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const lines = [
    `# permissions-ui  run=${runId}`,
    '',
    `**${passed} passed, ${failed} failed**`,
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **(ICON-DELETE)** Activates the Permissions admin tab, waits for the',
    '  Job Roles list to render at least one role row, then reads the SVG',
    '  `<path d="…">` from every `[title="Remove role"]` icon button.',
    '  Asserts every path matches the MUI Delete icon (trash-can) path,',
    '  not the MUI Close icon (✕) path.  Regression guard for accidental icon mismatch.',
    '- **(ICON-NOT-CLOSE)** Negative check: none of the Delete-button paths',
    '  equal the MUI Close icon path.',
    '- **(ICON-TUNE)** Reads the SVG path from every `[title="Edit navigation',
    '  layout"] (Tune) button and confirms it is neither the Delete nor the',
    '  Close path, guarding against mis-typed icon imports in the row.',
    '',
  ];
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`\n  Report written → ${outPath}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

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
  console.log(`\n  permissions-ui E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

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
  const skip = makeSkip(findings);

  // Track the seeded test role name so we can clean it up.
  const TEST_ROLE_NAME = `privtest-perm-role-${runId}`;

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    // Remove the test job role if it exists (best effort)
    try {
      await pool.query(`DELETE FROM job_roles WHERE name = $1`, [TEST_ROLE_NAME]);
    } catch {}
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

  // ── Seed a test job role via API ──────────────────────────────────────────
  const adminClient = await login(users.admin.email, PASSWORD);

  {
    const r = await adminClient.post('/api/admin/job-roles', {
      name: TEST_ROLE_NAME,
      privilege_level: 'member',
    });
    if (r.status !== 200) {
      console.error(`  ✗ Failed to seed test job role: status=${r.status} body=${r.text}`);
      writeReport(runId, findings);
      await cleanupAndExit(2);
      return;
    }
    console.log(`  Seeded test job role: "${TEST_ROLE_NAME}"`);
  }

  // ── Puppeteer not installed guard ─────────────────────────────────────────
  if (!puppeteer) {
    for (const l of PROBE_LABELS) {
      skip(l, 'puppeteer installed', 'puppeteer not installed');
    }
    writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

  const { findChromium } = require('../shared/find-chromium');
  const executablePath = findChromium() || undefined;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    for (const l of PROBE_LABELS) {
      skip(l, 'browser launched', `browser launch failed: ${e.message}`);
    }
    writeReport(runId, findings);
    await cleanupAndExit(1);
    return;
  }

  try {
    const page = await browser.newPage();
    await page.setCacheEnabled(false);

    const pageErrors = [];
    const IGNORE_RE = /(favicon\.ico|\/storybook\/|\.map\b|Failed to load resource)/;
    page.on('pageerror', (err) => { pageErrors.push(String(err)); });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (IGNORE_RE.test(text)) return;
      pageErrors.push(`console.error: ${text}`);
    });

    await injectSession(page, adminClient.cookie);

    // Navigate to admin page
    await page.goto(`${BASE}/admin`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });

    // Wait for window.switchTab to be defined — the React bundle must have
    // evaluated before we can activate the Permissions tab.
    await waitForSwitchTab(page, 10000);

    // ── Activate the Permissions tab ──────────────────────────────────────
    console.log('\n  [PERMISSIONS-TAB] Activating tab-permissions');

    await page.evaluate(() => {
      if (typeof window.switchTab === 'function') window.switchTab('permissions');
    });

    // Wait for the Permissions panel to have at least one role row rendered.
    // Each role row contains a [title="Remove role"] button.
    const removeRoleFound = await pollPage(page, () => {
      const panel = document.getElementById('tab-permissions');
      if (!panel) return null;
      return panel.querySelector('[title="Remove role"]') ? 'ok' : null;
    }, null, 15000);

    record(
      '[PERMISSIONS-TAB] Permissions tab activates and job roles list renders',
      '[title="Remove role"] button visible in #tab-permissions',
      removeRoleFound === 'ok' ? 'button found' : 'button not found (timeout)',
      removeRoleFound === 'ok',
    );

    if (removeRoleFound !== 'ok') {
      // Cannot run icon checks without role rows — report and bail
      for (const skip of ['[ICON-DELETE]', '[ICON-NOT-CLOSE]', '[ICON-TUNE]']) {
        record(
          skip,
          'role row rendered',
          'role row not found (permissions tab did not load — skipped)',
          false,
        );
      }
    } else {
      // ── [ICON-DELETE] Delete icon path check ──────────────────────────────
      console.log('\n  [ICON-DELETE] Checking "Remove role" button icon SVG paths');

      const deleteButtonPaths = await page.evaluate(() => {
        const panel = document.getElementById('tab-permissions');
        if (!panel) return [];
        const buttons = Array.from(panel.querySelectorAll('[title="Remove role"]'));
        return buttons.map(btn => {
          const pathEl = btn.querySelector('svg path');
          return pathEl ? pathEl.getAttribute('d') : null;
        });
      });

      const allAreDeleteIcon = deleteButtonPaths.length > 0 &&
        deleteButtonPaths.every(d => d === MUI_DELETE_PATH);

      record(
        '[ICON-DELETE] Every "Remove role" button contains the MUI Delete icon SVG path',
        `d="${MUI_DELETE_PATH}"`,
        deleteButtonPaths.length === 0
          ? 'no buttons found'
          : deleteButtonPaths.map(d => `d="${d}"`).join('; '),
        allAreDeleteIcon,
      );

      // ── [ICON-NOT-CLOSE] Negative check ───────────────────────────────────
      const noneAreCloseIcon = deleteButtonPaths.length > 0 &&
        deleteButtonPaths.every(d => d !== MUI_CLOSE_PATH);

      record(
        '[ICON-NOT-CLOSE] No "Remove role" button contains the MUI Close icon SVG path',
        `d ≠ "${MUI_CLOSE_PATH}"`,
        deleteButtonPaths.some(d => d === MUI_CLOSE_PATH)
          ? `Close icon found in ${deleteButtonPaths.filter(d => d === MUI_CLOSE_PATH).length} button(s)`
          : 'no Close icon found (correct)',
        noneAreCloseIcon,
      );

      // ── [ICON-TUNE] Tune icon path check ──────────────────────────────────
      // The Tune button is wrapped in a MUI <Tooltip> with no HTML title=""
      // attribute on the <IconButton> itself.  Find it by selecting all
      // .MuiIconButton-root inside #roles-list that are NOT the "Remove role"
      // button (which does carry title="Remove role").
      console.log('\n  [ICON-TUNE] Checking Tune icon SVG paths in role rows');

      const tuneButtonPaths = await page.evaluate(() => {
        const rolesBox = document.getElementById('roles-list');
        if (!rolesBox) return [];
        const allIconBtns = Array.from(rolesBox.querySelectorAll('[data-testid="role-tune-btn"]'));
        const tuneBtns = allIconBtns.filter(btn => btn.getAttribute('title') !== 'Remove role');
        return tuneBtns.map(btn => {
          const pathEl = btn.querySelector('svg path');
          return pathEl ? pathEl.getAttribute('d') : null;
        });
      });

      const tuneIsNeitherDeleteNorClose = tuneButtonPaths.length > 0 &&
        tuneButtonPaths.every(d => d !== null && d !== MUI_DELETE_PATH && d !== MUI_CLOSE_PATH);

      record(
        '[ICON-TUNE] Every "Edit navigation layout" button contains neither Delete nor Close icon path',
        'path ≠ Delete and path ≠ Close',
        tuneButtonPaths.length === 0
          ? 'no Tune buttons found'
          : tuneButtonPaths.map(d => `d="${d}"`).join('; '),
        tuneIsNeitherDeleteNorClose,
      );
    }

    // ── Runtime error check ───────────────────────────────────────────────
    record(
      '[RUNTIME] No JS errors during Permissions tab load',
      'no pageerror or console.error events',
      pageErrors.length === 0 ? 'no errors' : pageErrors.slice(0, 3).join(' | '),
      pageErrors.length === 0,
    );

    await page.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  writeReport(runId, findings);

  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  console.log(`\n  ${findings.filter(f => f.ok).length} passed, ${failed} failed`);
  await cleanupAndExit(failed > 0 ? 1 : 0);
}

main();
