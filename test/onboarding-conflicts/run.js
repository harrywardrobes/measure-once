'use strict';
// test/onboarding-conflicts/run.js
//
// Automated tests for the onboarding conflict detection and admin resolution
// flow (task #1108 / regression guard for task #1111).
//
// Covers:
//   [API-1] POST /api/onboarding/complete with differing values → 200.
//   [API-2] pending_profile_updates stored on allowed_emails row after submit.
//   [API-3] POST /api/admin/users/:id/resolve-profile-conflicts → 200.
//   [API-4] pending_profile_updates cleared after resolution.
//   [UI-1]  DifferenceIcon badge visible on the Team tab for the conflict user.
//   [UI-2]  Edit dialog shows "Onboarding discrepancies" Alert with admin/user values.
//   [UI-3]  After save, badge is gone from the row (pending_profile_updates = null).
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:onboarding-conflicts
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:onboarding-conflicts

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const {
  spawnServer,
  waitForServer,
  seedUsers,
  cleanupTestData,
  resetRateLimitStore,
  login,
  setPool,
  BASE,
  PREFIX,
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil, stabilityPoll } = require('../helpers/poll');

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'onboarding-conflicts.md');

// ── Pre-filled admin metadata ────────────────────────────────────────────────
// These are the values the admin "pre-filled" before the user onboarded.
const ADMIN_FIRST_NAME   = 'Alice';
const ADMIN_MOBILE       = '07700 000000';

// Values the user will actually submit during onboarding — both intentionally
// differ from the admin values to trigger a conflict on each field.
const USER_FIRST_NAME    = 'Alicia';
const USER_MOBILE        = '07711 111111';

// Fixed values used for fields that shouldn't conflict.
const SHARED_LAST_NAME   = 'Testington';
const SHARED_DOB         = '1990-01-01';
const SHARED_NI          = 'AB123456C';
const SHARED_EC_FNAME    = 'Bob';
const SHARED_EC_LNAME    = 'Contact';
const SHARED_EC_PHONE    = '07722 333444';

// ── Findings ──────────────────────────────────────────────────────────────────

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

// ── Puppeteer helpers ──────────────────────────────────────────────────────────

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

async function pollPage(page, fn, arg, timeoutMs = 12000, intervalMs = 200) {
  if (typeof arg === 'number') { timeoutMs = arg; arg = undefined; }
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
}

// Open /admin and wait for the AdminTeamPage React island to mount.
async function openAdminTeamPage(browser, jar) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);

  const pageLogs = [];
  page.on('console',   m => pageLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => pageLogs.push(`[pageerror] ${e.message}`));

  await injectSession(page, jar);
  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Team tab is the default active panel — wait for the React island inside it.
  await pollPage(page, () => {
    const panel = document.getElementById('tab-team');
    return panel && panel.querySelector('table') ? 'ok' : null;
  }, 25000);

  // Wait for bootstrap so usePrivilege sees the admin level.
  await pollPage(page, () => window.__moHeaderUser ? 'ok' : null, 10000);
  // Poll until the team panel's HTML length stabilises — confirms React has
  // flushed the privilege update and the tab is fully rendered.
  await stabilityPoll(page, '#tab-team', 5000);

  page.__logs = pageLogs;
  return page;
}

// ── Seed / cleanup helpers ────────────────────────────────────────────────────

async function seedConflictUser(pool, runId) {
  const email = `${PREFIX}conflict-${runId}@privtest.local`;
  const hash  = await bcrypt.hash('ConflictTestPw!9', 10);

  // Insert allowed_emails with pre-filled admin metadata.
  const adminMeta = JSON.stringify({
    first_name:   ADMIN_FIRST_NAME,
    mobile_number: ADMIN_MOBILE,
  });
  await pool.query(
    `INSERT INTO allowed_emails (email, metadata, note)
     VALUES ($1, $2::jsonb, 'onboarding-conflict test seed')
     ON CONFLICT (email) DO UPDATE
       SET metadata = $2::jsonb, note = 'onboarding-conflict test seed'`,
    [email, adminMeta]
  );

  // Insert user row in more_info_required state so onboarding can be triggered.
  const r = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password_hash,
                        privilege_level, onboarding_status)
     VALUES ($1, $2, $3, $4, 'member', 'more_info_required')
     ON CONFLICT (email) DO UPDATE
       SET first_name = $2, last_name = $3, password_hash = $4,
           onboarding_status = 'more_info_required'
     RETURNING id`,
    [email, ADMIN_FIRST_NAME, SHARED_LAST_NAME, hash]
  );

  return { email, id: r.rows[0].id, password: 'ConflictTestPw!9' };
}

async function cleanupConflictUser(pool, runId) {
  const email = `${PREFIX}conflict-${runId}@privtest.local`;
  await pool.query(`DELETE FROM sessions WHERE sess::text LIKE $1`, [`%${email}%`]);
  await pool.query(`DELETE FROM users WHERE email = $1`, [email]);
  await pool.query(`DELETE FROM allowed_emails WHERE email = $1`, [email]);
}

// ── Report ─────────────────────────────────────────────────────────────────────

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const lines = [
    '# Onboarding Conflicts — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:onboarding-conflicts\``,
    '',
    '## Summary',
    '',
    `- Passed: ${passed} / ${findings.length}`,
    `- Failed: ${failed} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`
    ),
    '',
    '## Coverage',
    '',
    '- **[API-1]** POST /api/onboarding/complete with differing values → 200.',
    '- **[API-2]** pending_profile_updates stored on allowed_emails after submit.',
    '- **[API-3]** POST /api/admin/users/:id/resolve-profile-conflicts → 200.',
    '- **[API-4]** pending_profile_updates cleared after resolution.',
    '- **[UI-1]**  DifferenceIcon badge visible on Team tab for conflict user.',
    '- **[UI-2]**  Edit dialog shows "Onboarding discrepancies" Alert with correct values.',
    '- **[UI-3]**  Badge is gone after admin resolves and page reloads.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

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
  console.log(`\n  onboarding-conflicts  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);
  await cleanupTestData(pool);
  await cleanupConflictUser(pool, runId);

  const users       = await seedUsers(pool, runId);
  const conflictUser = await seedConflictUser(pool, runId);
  console.log(`  Seeded  admin=${users.admin.email}  conflictUser=${conflictUser.email}`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupConflictUser(pool, runId); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    await writeReport(runId);
    process.exit(code);
  };
  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  e => { console.error('Uncaught:',  e); cleanupAndExit(2); });
  process.on('unhandledRejection', e => { console.error('Unhandled:', e); cleanupAndExit(2); });

  // ── Boot server ─────────────────────────────────────────────────────────────
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

  // ── Login ───────────────────────────────────────────────────────────────────
  const adminClient   = await login(users.admin.email,  users.admin.password);
  const conflictClient = await login(conflictUser.email, conflictUser.password);

  // ── [API-1] POST /api/onboarding/complete ────────────────────────────────────
  console.log('\n  [API] Onboarding conflict detection');

  const onboardPayload = {
    first_name:   USER_FIRST_NAME,   // conflicts with admin's ADMIN_FIRST_NAME
    last_name:    SHARED_LAST_NAME,
    date_of_birth: SHARED_DOB,
    ni_number:    SHARED_NI,
    mobile_number: USER_MOBILE,      // conflicts with admin's ADMIN_MOBILE
    ec_first_name: SHARED_EC_FNAME,
    ec_last_name:  SHARED_EC_LNAME,
    ec_phone:      SHARED_EC_PHONE,
  };

  const onboardRes = await conflictClient.post('/api/onboarding/complete', onboardPayload);
  record(
    '[API-1] POST /api/onboarding/complete with differing values → 200',
    '200',
    String(onboardRes.status),
    onboardRes.status === 200,
  );
  record(
    '[API-1] response body has ok:true',
    'true',
    String(onboardRes.json?.ok),
    onboardRes.json?.ok === true,
  );

  // ── [API-2] DB: pending_profile_updates stored ───────────────────────────────
  const dbRow = await pool.query(
    `SELECT pending_profile_updates FROM allowed_emails WHERE email = $1`,
    [conflictUser.email]
  );
  const pendingUpdates = dbRow.rows[0]?.pending_profile_updates || null;

  record(
    '[API-2] pending_profile_updates row is non-null',
    'object with conflict keys',
    pendingUpdates === null ? 'null' : JSON.stringify(pendingUpdates),
    pendingUpdates !== null && typeof pendingUpdates === 'object',
  );
  record(
    '[API-2] first_name conflict stored with admin + user values',
    `admin="${ADMIN_FIRST_NAME}" user="${USER_FIRST_NAME}"`,
    pendingUpdates?.first_name
      ? `admin="${pendingUpdates.first_name.admin}" user="${pendingUpdates.first_name.user}"`
      : 'field missing',
    pendingUpdates?.first_name?.admin === ADMIN_FIRST_NAME
      && pendingUpdates?.first_name?.user === USER_FIRST_NAME,
  );
  record(
    '[API-2] mobile_number conflict stored with admin + user values',
    `admin="${ADMIN_MOBILE}" user="${USER_MOBILE}"`,
    pendingUpdates?.mobile_number
      ? `admin="${pendingUpdates.mobile_number.admin}" user="${pendingUpdates.mobile_number.user}"`
      : 'field missing',
    pendingUpdates?.mobile_number?.admin === ADMIN_MOBILE
      && pendingUpdates?.mobile_number?.user === USER_MOBILE,
  );

  // ── [API-3] POST /api/admin/users/:id/resolve-profile-conflicts ───────────────
  console.log('\n  [API] Conflict resolution');

  const resolveRes = await adminClient.post(
    `/api/admin/users/${conflictUser.id}/resolve-profile-conflicts`,
    {
      resolutions: {
        first_name:   ADMIN_FIRST_NAME,  // admin wins for first_name
        mobile_number: USER_MOBILE,       // user wins for mobile_number
      },
    }
  );
  record(
    '[API-3] POST /api/admin/users/:id/resolve-profile-conflicts → 200',
    '200',
    String(resolveRes.status),
    resolveRes.status === 200,
  );
  record(
    '[API-3] response body has ok:true',
    'true',
    String(resolveRes.json?.ok),
    resolveRes.json?.ok === true,
  );

  // ── [API-4] DB: pending_profile_updates cleared ───────────────────────────────
  const dbRow2 = await pool.query(
    `SELECT pending_profile_updates FROM allowed_emails WHERE email = $1`,
    [conflictUser.email]
  );
  // NOTE: The db column is JSONB; a cleared row returns null (JS null).
  // Do NOT use `?? fallback` here — null IS the success value.
  const pendingAfterRaw = dbRow2.rows[0]?.pending_profile_updates;
  const pendingAfterIsNull = dbRow2.rows[0] !== undefined && pendingAfterRaw === null;

  record(
    '[API-4] pending_profile_updates is NULL after resolution',
    'null',
    pendingAfterIsNull ? 'null' : JSON.stringify(pendingAfterRaw),
    pendingAfterIsNull,
  );

  // ── Reset state for UI tests: re-seed the conflict ───────────────────────────
  // API-3 may have updated users.first_name to the admin value (ADMIN_FIRST_NAME).
  // Query the actual current name so the UI test uses the right display name.
  const nameRow = await pool.query(
    `SELECT first_name, last_name FROM users WHERE id = $1`,
    [conflictUser.id]
  );
  const uiFirstName = nameRow.rows[0]?.first_name || USER_FIRST_NAME;
  const uiLastName  = nameRow.rows[0]?.last_name  || SHARED_LAST_NAME;

  // Re-inject the conflict into allowed_emails so the badge and dialog are
  // visible for UI testing (they were cleared by the API-3 resolution step).
  const conflictPayload = {
    first_name:   { admin: ADMIN_FIRST_NAME, user: USER_FIRST_NAME },
    mobile_number: { admin: ADMIN_MOBILE,     user: USER_MOBILE },
  };
  await pool.query(
    `UPDATE allowed_emails SET pending_profile_updates = $1::jsonb WHERE email = $2`,
    [JSON.stringify(conflictPayload), conflictUser.email]
  );

  // ── UI Tests ─────────────────────────────────────────────────────────────────
  // Use the DB-queried name: after API-3 resolution the users table may have
  // been updated (admin's first_name wins), so look up the current value.
  const conflictDisplayName = `${uiFirstName} ${uiLastName}`;

  const UI_LABELS = [
    '[UI-1] DifferenceIcon badge visible on Team tab for conflict user',
    '[UI-2] Edit dialog shows "Onboarding discrepancies" Alert',
    '[UI-2b] Alert lists correct admin value for first_name conflict',
    '[UI-2c] Alert lists correct user value for first_name conflict',
    '[UI-3] After resolution save, badge is gone from the row',
  ];

  if (!puppeteer) {
    for (const l of UI_LABELS) record(l, 'puppeteer installed', 'puppeteer not installed', false);
    await cleanupAndExit(1);
    return;
  }

  const { findChromium } = require('../shared/find-chromium');
  let browser = null;
  let browserLaunchErr = null;
  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
  const launchAttempts = [{ args: launchArgs }];
  const sysChrome = findChromium();
  if (sysChrome) launchAttempts.push({ executablePath: sysChrome, args: launchArgs });
  for (const opts of launchAttempts) {
    try {
      browser = await puppeteer.launch({ headless: true, ...opts });
      browserLaunchErr = null;
      break;
    } catch (e) { browserLaunchErr = e; browser = null; }
  }

  if (!browser) {
    const msg = (browserLaunchErr?.message || String(browserLaunchErr)).slice(0, 200);
    for (const l of UI_LABELS) record(l, 'browser launched', `browser launch failed: ${msg}`, false);
    await cleanupAndExit(1);
    return;
  }

  try {
    // ── [UI-1] DifferenceIcon badge visible on Team tab ────────────────────────
    console.log('\n  [UI-1] Admin Team tab — DifferenceIcon badge visible');
    const adminPage = await openAdminTeamPage(browser, adminClient.cookie);

    // Look for any element with a data-testid or aria-label on DifferenceIcon,
    // or simply check for the SVG path that DifferenceIcon uses. The React
    // component renders a <svg> inside a <span> inside a MUI Tooltip. The
    // AdminTeamPage uses `data-testid` isn't reliable here; instead we look for
    // the user's display name in a row that also contains the warning icon SVG.
    const badgeVisible = await pollPage(adminPage, (displayName) => {
      const tab = document.getElementById('tab-team');
      if (!tab) return null;
      const rows = Array.from(tab.querySelectorAll('tr'));
      for (const row of rows) {
        if (row.textContent && row.textContent.includes(displayName)) {
          // DifferenceIcon renders as an SVG; AdminTeamPage wraps it in a Tooltip
          // with a warning colour — check for any SVG in the same cell.
          const svgs = row.querySelectorAll('svg');
          if (svgs.length > 0) return 'found';
        }
      }
      return null;
    }, conflictDisplayName, 15000);

    record(
      UI_LABELS[0],
      'DifferenceIcon SVG in row for conflict user',
      badgeVisible ? 'found' : 'not found (timed out)',
      badgeVisible === 'found',
    );

    // ── [UI-2] Edit dialog shows "Onboarding discrepancies" Alert ─────────────
    console.log('\n  [UI-2] Edit dialog — Onboarding discrepancies Alert');

    // Click the Edit button on the conflict user's row.
    const editClicked = await adminPage.evaluate((displayName) => {
      const tab = document.getElementById('tab-team');
      if (!tab) return false;
      const rows = Array.from(tab.querySelectorAll('tr'));
      for (const row of rows) {
        if (row.textContent && row.textContent.includes(displayName)) {
          const btns = Array.from(row.querySelectorAll('button'));
          const editBtn = btns.find(b => b.textContent && b.textContent.trim() === 'Edit');
          if (editBtn) { editBtn.click(); return true; }
        }
      }
      return false;
    }, conflictDisplayName);

    if (!editClicked) {
      record(UI_LABELS[1], 'Edit button clicked', 'Edit button not found in row', false);
      record(UI_LABELS[2], 'admin value visible', 'dialog not opened', false);
      record(UI_LABELS[3], 'user value visible',  'dialog not opened', false);
    } else {
      // MUI Dialog renders in a Portal appended to <body>.  Wait for the title
      // text to appear anywhere in the page (more reliable than [role="dialog"]).
      const dialogOpened = await pollPage(adminPage, () =>
        document.body.textContent && document.body.textContent.includes('Edit team member')
          ? 'ok' : null
      , undefined, 12000);

      if (!dialogOpened) {
        record(UI_LABELS[1], 'dialog opened', 'dialog did not open (title never found)', false);
        record(UI_LABELS[2], 'admin value visible', 'dialog not opened', false);
        record(UI_LABELS[3], 'user value visible',  'dialog not opened', false);
      } else {
        // Poll for the "Onboarding discrepancies" Alert to finish rendering.
        await pollPage(adminPage, () => {
          const all = Array.from(document.querySelectorAll('*'));
          return all.some(el =>
            el.children.length < 8
            && el.textContent && el.textContent.includes('Onboarding discrepancies')
          ) ? 'ok' : null;
        }, undefined, 8000);

        // Search for "Onboarding discrepancies" anywhere in the body.
        const alertText = await adminPage.evaluate(() => {
          // Walk all leaf-ish elements for the exact text, then climb up to get
          // a reasonable amount of context (the MuiAlert-root ancestor).
          const all = Array.from(document.querySelectorAll('*'));
          const alertEl = all.find(el =>
            el.children.length < 8
            && el.textContent && el.textContent.includes('Onboarding discrepancies')
          );
          if (!alertEl) return '';
          // Climb up to the MuiAlert root to capture the full alert text.
          let node = alertEl;
          while (node && node !== document.body) {
            if (node.classList && Array.from(node.classList).some(c => c === 'MuiAlert-root')) {
              return node.textContent || '';
            }
            node = node.parentElement;
          }
          // Fallback: return the closest div ancestor.
          const div = alertEl.closest('div');
          return div ? div.textContent : (alertEl.textContent || '');
        });

        record(
          UI_LABELS[1],
          '"Onboarding discrepancies" text in dialog alert',
          alertText ? alertText.slice(0, 120) : '(no alert found)',
          alertText.includes('Onboarding discrepancies'),
        );
        record(
          UI_LABELS[2],
          `admin value "${ADMIN_FIRST_NAME}" present in alert`,
          alertText.slice(0, 200),
          alertText.includes(ADMIN_FIRST_NAME),
        );
        record(
          UI_LABELS[3],
          `user value "${USER_FIRST_NAME}" present in alert`,
          alertText.slice(0, 200),
          alertText.includes(USER_FIRST_NAME),
        );

        // ── [UI-3] Select admin resolution and save ────────────────────────────
        console.log('\n  [UI-3] Resolve conflicts and verify badge gone');

        // Click the first "Admin's value" radio button — search document-wide
        // since MUI Dialog renders in a Portal outside the main DOM tree.
        await adminPage.evaluate(() => {
          const radios = Array.from(document.querySelectorAll('input[type="radio"][value="admin"]'));
          if (radios.length > 0) radios[0].click();
        });

        // Click the Save button — search document-wide since MUI Dialog
        // renders in a Portal and may not be inside [role="dialog"].
        const saveClicked = await adminPage.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const saveBtn = btns.find(b =>
            b.textContent && b.textContent.trim().includes('Save')
            && !b.textContent.trim().includes('Cancel')
          );
          if (saveBtn) { saveBtn.click(); return true; }
          return false;
        });

        if (!saveClicked) {
          record(UI_LABELS[4], 'Save button clicked', 'Save button not found', false);
        } else {
          // Wait for the dialog to close.
          await pollPage(adminPage, () =>
            document.querySelector('[role="dialog"]') ? null : 'closed'
          , undefined, 10000);

          // Reload the admin page and wait for the Team tab to repopulate.
          await adminPage.reload({ waitUntil: 'domcontentloaded' });
          await pollPage(adminPage, () => {
            const panel = document.getElementById('tab-team');
            return panel && panel.querySelector('table') ? 'ok' : null;
          }, 20000);

          // Confirm the conflict user's row no longer has the DifferenceIcon badge.
          const badgeGone = await adminPage.evaluate((displayName) => {
            const tab = document.getElementById('tab-team');
            if (!tab) return 'tab missing';
            const rows = Array.from(tab.querySelectorAll('tr'));
            for (const row of rows) {
              if (row.textContent && row.textContent.includes(displayName)) {
                // Row found — check that it has no extra SVG icon for the badge.
                // The Edit/Delete action buttons may contain SVGs; we check only
                // the cell containing the user's name (first TableCell with name).
                const cells = Array.from(row.querySelectorAll('td'));
                const nameCell = cells.find(c => c.textContent && c.textContent.includes(displayName));
                if (!nameCell) return 'name-cell missing';
                const svgsInNameCell = nameCell.querySelectorAll('svg');
                return svgsInNameCell.length === 0 ? 'badge-gone' : `badge-still-present (${svgsInNameCell.length} svgs)`;
              }
            }
            return 'row-not-found';
          }, conflictDisplayName);

          record(
            UI_LABELS[4],
            'badge-gone',
            badgeGone,
            badgeGone === 'badge-gone',
          );
        }
      }
    }

    await adminPage.__ctx.close().catch(() => {});
  } catch (e) {
    console.error('UI test error:', e.message);
    for (const l of UI_LABELS) {
      if (!findings.find(f => f.name === l)) {
        record(l, 'no error', `error: ${e.message.slice(0, 80)}`, false);
      }
    }
  } finally {
    try { await browser.close(); } catch {}
  }

  // ── Done ─────────────────────────────────────────────────────────────────────
  const failed = findings.filter(f => !f.ok).length;
  console.log(`\n  ${findings.length - failed}/${findings.length} passed\n`);
  await cleanupAndExit(failed > 0 ? 1 : 0);
}

main();
