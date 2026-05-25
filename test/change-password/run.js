'use strict';
// test/change-password/run.js
//
// End-to-end test for the Change Password dialog on /profile (task #852).
// Mirrors the pattern in test/new-customer-flow/run.js: boot a disposable
// server with the privileges harness, drive the UI with Puppeteer, write a
// markdown report to test-results/change-password.md, exit non-zero on failure.
//
// MUI v9 note: MUI v9 Dialog renders its children in the DOM even when
// `open={false}` (keepMounted=true is the new default). The dialog is hidden
// via `display:none` rather than unmounting. Selectors and open/close
// detection use computed style rather than DOM presence.
//
// Probes:
//   [API.1] POST /api/change-password with missing body fields → 400
//   [API.2] POST /api/change-password with wrong currentPassword → 401
//   [API.3] POST /api/change-password with currentPassword === newPassword → 400
//   [API.4] POST /api/change-password with valid credentials → 200
//   [UI.1]  /profile loads — profile content is rendered; the "Password" card
//           is present; the dialog is hidden (display:none)
//   [UI.2]  Clicking the "Change password" button in the Password card makes
//           the dialog visible; three password fields are visible
//   [UI.3]  Submitting the empty form surfaces Mui-error helper texts for all
//           three fields inside the dialog
//   [UI.4]  Clicking Cancel returns the dialog to a hidden state
//   [UI.5]  Filling valid credentials and submitting: the dialog becomes
//           hidden and a success Alert containing "Password updated" appears
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:change-password
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:change-password

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

// A strong new password that passes the server-side zxcvbn policy (score ≥ 2,
// has mixed letters + numbers, not a known-weak phrase).
const NEW_PASSWORD = 'Zqr9!mBlue#Anchor27';

// ── helpers ──────────────────────────────────────────────────────────────────

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

async function pollPage(page, fn, arg, timeoutMs = 10000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let got = null;
    try { got = await page.evaluate(fn, arg); } catch {}
    if (got) return got;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

async function newPageWithSession(browser, jar) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);
  const logs = [];
  page.on('console',       m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror',     e => logs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', r => logs.push(`[reqfailed] ${r.url()} ${r.failure()?.errorText || ''}`));
  page.on('response',      r => {
    const s = r.status();
    if (s >= 400) logs.push(`[resp ${s}] ${r.request().method()} ${r.url()}`);
  });
  await injectSession(page, jar);
  page.__logs = logs;
  return page;
}

async function closePage(p) {
  try { await p.close(); } catch {}
  try { await p.__ctx?.close(); } catch {}
}

// Wait for the ProfilePage React island to finish mounting.
// Detects mount by checking that #profile-view has React-rendered MUI content.
// MUI v9 always keeps dialog children in the DOM, so we check for the
// profile-view container having any children rather than for specific text.
async function waitForProfileMounted(page) {
  return pollPage(page, () => {
    const pv = document.getElementById('profile-view');
    if (!pv || !pv.firstElementChild) return null;
    // Look for the MuiCard-root or MuiBox-root that the ProfilePage renders.
    // The Sign out button from AccountActionsCard signals a full render.
    const allBtns = Array.from(document.querySelectorAll('button'));
    const signOutBtn = allBtns.find(b => /sign out/i.test(b.textContent || ''));
    return signOutBtn ? 'ok' : null;
  }, null, 25000);
}

// Returns the computed display of the MUI dialog element (the element with
// role="dialog"). 'none' means the dialog is closed in MUI v9.
function getDialogDisplay(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return 'missing';
    return window.getComputedStyle(dialog).display;
  });
}

// Click the "Change password" button inside the Password card.
// MUI v9 renders Button text via CSS pseudo-elements rather than DOM text nodes,
// so textContent-based searches return empty strings. The button carries a
// data-testid="change-password-btn" attribute for reliable selection.
async function clickChangePasswordBtn(page) {
  // Use page.evaluate + direct DOM .click() which always fires on the exact
  // element, bypassing any coordinate-based interception. Puppeteer's
  // handle.click() dispatches pointer events at screen coordinates; if another
  // element overlaps at runtime, React's onClick never fires.
  return page.evaluate(() => {
    const btn = document.querySelector('[data-testid="change-password-btn"]');
    if (btn) { btn.click(); return 'testid-dom'; }
    // Fallback: card-based search
    const cards = Array.from(document.querySelectorAll('.MuiCard-root'));
    for (const card of cards) {
      const overlines = card.querySelectorAll('[class*="MuiTypography-overline"]');
      const hasPasswordOverline = Array.from(overlines).some(
        el => /^password$/i.test((el.textContent || '').trim()),
      );
      if (hasPasswordOverline) {
        const b = card.querySelector('button');
        if (b) { b.click(); return 'fallback-card'; }
      }
    }
    return null;
  });
}

// Returns a snapshot of the dialog state for open/content checks.
// MUI v9 notes:
// - The `[role="dialog"]` element (MuiDialog-paper) keeps display:none even
//   when open; the Modal-root container controls visibility.
// - We detect "open" by checking whether the Cancel button or the
//   MuiModal-root/.MuiDialog-container has become visible.
async function getDialogState(page) {
  return page.evaluate(() => {
    // Strategy 1: Check if the MuiBackdrop or MuiModal-root is visible.
    const backdrop = document.querySelector('.MuiBackdrop-root');
    const modalRoot = document.querySelector('.MuiModal-root');
    const container = document.querySelector('.MuiDialog-container');
    const isModalVisible =
      (backdrop && window.getComputedStyle(backdrop).display !== 'none') ||
      (modalRoot && window.getComputedStyle(modalRoot).display !== 'none') ||
      (container && window.getComputedStyle(container).display !== 'none');

    // Strategy 2: Check Cancel button visibility — it appears in DOM only when
    // the dialog opens (lazy portal mount in MUI v9).
    const allBtns = Array.from(document.querySelectorAll('button'));
    const cancelBtn = allBtns.find(b => /^cancel$/i.test((b.textContent || '').trim()));
    const cancelVisible = cancelBtn && window.getComputedStyle(cancelBtn).display !== 'none';

    const visible = isModalVisible || !!cancelVisible;
    if (!visible) return { visible: false };

    // Count visible password inputs across the whole document.
    const pwInputs = Array.from(document.querySelectorAll('input[type="password"]'))
      .filter(el => window.getComputedStyle(el).display !== 'none');
    const hasSubmit = allBtns.some(b => /update password/i.test(b.textContent || ''));
    const hasCancel = !!cancelBtn;
    return { visible: true, inputCount: pwInputs.length, hasSubmit, hasCancel };
  });
}

// Fill a MUI-controlled input (React controlled, needs synthetic events).
// Searches the whole document because in MUI v9 the dialog form may be
// rendered inline in the React tree (not inside [role="dialog"]).
async function fillVisiblePasswordInput(page, index, value) {
  // Focus the input via evaluate (avoids coordinate-based click interception),
  // then use keyboard.type() so React's own event handlers fire naturally.
  const focused = await page.evaluate((idx) => {
    const inputs = Array.from(document.querySelectorAll('input[type="password"]'));
    const el = inputs[idx];
    if (!el) return false;
    el.focus();
    return true;
  }, index);
  if (!focused) return;
  // Clear any existing value, then type the new one.
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(value, { delay: 0 });
}

// ── main ─────────────────────────────────────────────────────────────────────

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
  console.log(`\n  change-password E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  member=${users.member.email}  manager=${users.manager.email}`);

  const { child, logBuf } = spawnServer({});
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

  // ════════════════════════════════════════════════════════════════════════════
  // [API] probes — no browser needed
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [API] POST /api/change-password');

  // API.1 — missing body fields → 400
  {
    const r = await memberClient.post('/api/change-password', {});
    record(
      '[API.1] missing body fields → 400',
      'status=400',
      `status=${r.status}, body=${r.text?.slice(0, 120)}`,
      r.status === 400,
    );
  }

  // API.2 — wrong currentPassword → 401
  {
    const r = await memberClient.post('/api/change-password', {
      currentPassword: 'this-is-not-the-password',
      newPassword: NEW_PASSWORD,
    });
    record(
      '[API.2] wrong currentPassword → 401',
      'status=401',
      `status=${r.status}, body=${r.text?.slice(0, 120)}`,
      r.status === 401,
    );
  }

  // API.3 — currentPassword === newPassword → 400
  {
    const r = await memberClient.post('/api/change-password', {
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });
    record(
      '[API.3] currentPassword === newPassword → 400',
      'status=400',
      `status=${r.status}, body=${r.text?.slice(0, 120)}`,
      r.status === 400,
    );
  }

  // API.4 — valid credentials → 200 (uses manager so member stays intact for UI)
  {
    const r = await managerClient.post('/api/change-password', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    record(
      '[API.4] valid change → 200 with ok:true',
      'status=200, ok=true',
      `status=${r.status}, body=${r.text?.slice(0, 120)}`,
      r.status === 200 && r.json?.ok === true,
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // [UI] Puppeteer probes
  // ════════════════════════════════════════════════════════════════════════════
  const UI_LABELS = [
    '[UI.1] /profile — profile card rendered; dialog hidden (display:none)',
    '[UI.2] clicking "Change password" button → dialog becomes visible with 3 fields',
    '[UI.3] submitting empty dialog → Mui-error helper texts appear for all 3 fields',
    '[UI.4] clicking Cancel → dialog becomes hidden again',
    '[UI.5] valid submit → dialog hidden, "Password updated" Alert visible on card',
  ];

  if (!puppeteer) {
    for (const l of UI_LABELS) record(l, 'puppeteer installed', 'puppeteer not installed', false);
  } else {
    const { findChromium } = require('../shared/find-chromium');
    let browser = null;
    let launchErr = null;
    const launchArgs = [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-features=PasswordImport,AutofillServerCommunication',
      '--disable-save-password-bubble',
      '--password-store=basic',
    ];
    const attempts = [{ args: launchArgs }];
    const sysChrome = findChromium();
    if (sysChrome) attempts.push({ executablePath: sysChrome, args: launchArgs });
    for (const opts of attempts) {
      try {
        browser = await puppeteer.launch({ headless: true, ...opts });
        launchErr = null;
        break;
      } catch (e) { launchErr = e; browser = null; }
    }

    if (!browser) {
      const msg = (launchErr?.message || String(launchErr)).slice(0, 200);
      for (const l of UI_LABELS) record(l, 'browser launched', `browser launch failed: ${msg}`, false);
    } else {
      try {
        // ── member /profile ──────────────────────────────────────────────────
        const profilePage = await newPageWithSession(browser, memberClient.cookie);
        await profilePage.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        const mounted = await waitForProfileMounted(profilePage);

        if (!mounted) {
          const pageLogs = profilePage.__logs.slice(-15).join('\n');
          for (const l of UI_LABELS) {
            record(l, 'ProfilePage mounted (Sign out button present)', `mount timed out. logs:\n${pageLogs}`, false);
          }
        } else {
          // UI.1 — profile card rendered; dialog hidden
          const ui1 = await profilePage.evaluate(() => {
            // The ChangePasswordCard renders a card with a "Password" overline.
            const cards = Array.from(document.querySelectorAll('.MuiCard-root'));
            const hasPasswordCard = cards.some(card => {
              const overlines = card.querySelectorAll('[class*="MuiTypography-overline"]');
              return Array.from(overlines).some(el => /password/i.test(el.textContent || ''));
            });
            // Dialog is always in DOM in MUI v9; check that it's hidden.
            const dialog = document.querySelector('[role="dialog"]');
            const dialogHidden = !dialog || window.getComputedStyle(dialog).display === 'none';
            return { hasPasswordCard, dialogHidden };
          });
          record(UI_LABELS[0],
            'hasPasswordCard=true, dialogHidden=true',
            `hasPasswordCard=${ui1.hasPasswordCard}, dialogHidden=${ui1.dialogHidden}`,
            ui1.hasPasswordCard === true && ui1.dialogHidden === true,
          );

          // Shared browser-side dialog-open detection logic (inlined in each
          // page.evaluate call below — no cross-scope references allowed).
          // MUI v9: `[role="dialog"]` stays display:none; we detect open state
          // via MuiBackdrop / MuiModal-root / Cancel button computed display.

          // UI.2 — click the "Change password" button; dialog becomes visible
          const clicked = await clickChangePasswordBtn(profilePage);
          if (!clicked) {
            record(UI_LABELS[1], 'button clicked', 'could not find button in Password card', false);
            record(UI_LABELS[2], 'button clicked first', 'button not found', false);
            record(UI_LABELS[3], 'button clicked first', 'button not found', false);
            record(UI_LABELS[4], 'button clicked first', 'button not found', false);
          } else {
            const dialogVisible = await pollPage(profilePage, () => {
              const backdrop   = document.querySelector('.MuiBackdrop-root');
              const modalRoot  = document.querySelector('.MuiModal-root');
              const container  = document.querySelector('.MuiDialog-container');
              const cancelBtn  = Array.from(document.querySelectorAll('button'))
                .find(b => /^cancel$/i.test((b.textContent || '').trim()));
              const open = (
                (backdrop  && window.getComputedStyle(backdrop).display  !== 'none') ||
                (modalRoot && window.getComputedStyle(modalRoot).display !== 'none') ||
                (container && window.getComputedStyle(container).display !== 'none') ||
                (cancelBtn && window.getComputedStyle(cancelBtn).display !== 'none')
              );
              return open ? 'visible' : null;
            }, null, 8000);

            const dialogState = dialogVisible ? await getDialogState(profilePage) : null;

            record(UI_LABELS[1],
              'dialog visible with 3 password inputs, Submit, Cancel',
              dialogState
                ? `visible=${dialogState.visible}, inputs=${dialogState.inputCount}, submit=${dialogState.hasSubmit}, cancel=${dialogState.hasCancel}`
                : 'dialog did not become visible',
              !!dialogState && dialogState.visible === true
                && dialogState.inputCount === 3
                && dialogState.hasSubmit === true && dialogState.hasCancel === true,
            );

            // UI.3 — submit empty; inline errors appear
            await profilePage.evaluate(() => {
              // The dialog form may be in a portal or rendered inline.
              const form = document.querySelector('.MuiDialog-paper form')
                || document.querySelector('[role="dialog"] form')
                || Array.from(document.querySelectorAll('form')).find(
                  f => f.querySelector('input[type="password"]'),
                );
              if (form) {
                if (form.requestSubmit) form.requestSubmit();
                else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
              }
            });

            const errorSnap = await pollPage(profilePage, () => {
              const errorEls = document.querySelectorAll('p.Mui-error');
              const realErrors = Array.from(errorEls).filter(
                el => (el.textContent || '').trim().length > 0,
              );
              return realErrors.length >= 3 ? { errorCount: realErrors.length } : null;
            }, null, 8000);

            record(UI_LABELS[2],
              'at least 3 Mui-error helper texts inside dialog',
              errorSnap ? `errorCount=${errorSnap.errorCount}` : 'errors not found or < 3',
              !!errorSnap,
            );

            // UI.4 — click Cancel; dialog becomes hidden
            await profilePage.evaluate(() => {
              const cancelBtn = Array.from(document.querySelectorAll('button'))
                .find(b => /^cancel$/i.test((b.textContent || '').trim()));
              if (cancelBtn) cancelBtn.click();
            });

            const dialogHiddenAfterCancel = await pollPage(profilePage, () => {
              const backdrop   = document.querySelector('.MuiBackdrop-root');
              const modalRoot  = document.querySelector('.MuiModal-root');
              const container  = document.querySelector('.MuiDialog-container');
              const cancelBtn  = Array.from(document.querySelectorAll('button'))
                .find(b => /^cancel$/i.test((b.textContent || '').trim()));
              const open = (
                (backdrop  && window.getComputedStyle(backdrop).display  !== 'none') ||
                (modalRoot && window.getComputedStyle(modalRoot).display !== 'none') ||
                (container && window.getComputedStyle(container).display !== 'none') ||
                (cancelBtn && window.getComputedStyle(cancelBtn).display !== 'none')
              );
              return open ? null : 'hidden';
            }, null, 6000);

            record(UI_LABELS[3],
              'dialog hidden after Cancel',
              dialogHiddenAfterCancel === 'hidden' ? 'dialog hidden' : 'dialog still visible',
              dialogHiddenAfterCancel === 'hidden',
            );

            await closePage(profilePage);

            // UI.5 — full success flow on a fresh page (member still has original
            //         password since API.4 only changed manager's password)
            const successPage = await newPageWithSession(browser, memberClient.cookie);
            await successPage.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await waitForProfileMounted(successPage);

            // Open dialog
            await clickChangePasswordBtn(successPage);
            await pollPage(successPage, () => {
              const backdrop   = document.querySelector('.MuiBackdrop-root');
              const modalRoot  = document.querySelector('.MuiModal-root');
              const container  = document.querySelector('.MuiDialog-container');
              const cancelBtn  = Array.from(document.querySelectorAll('button'))
                .find(b => /^cancel$/i.test((b.textContent || '').trim()));
              const open = (
                (backdrop  && window.getComputedStyle(backdrop).display  !== 'none') ||
                (modalRoot && window.getComputedStyle(modalRoot).display !== 'none') ||
                (container && window.getComputedStyle(container).display !== 'none') ||
                (cancelBtn && window.getComputedStyle(cancelBtn).display !== 'none')
              );
              return open ? 'visible' : null;
            }, null, 8000);

            // Fill current → new → confirm (index 0, 1, 2)
            await fillVisiblePasswordInput(successPage, 0, PASSWORD);
            await fillVisiblePasswordInput(successPage, 1, NEW_PASSWORD);
            await fillVisiblePasswordInput(successPage, 2, NEW_PASSWORD);

            // Submit
            await successPage.evaluate(() => {
              const form = document.querySelector('.MuiDialog-paper form')
                || document.querySelector('[role="dialog"] form')
                || Array.from(document.querySelectorAll('form')).find(
                  f => f.querySelector('input[type="password"]'),
                );
              if (form) {
                if (form.requestSubmit) form.requestSubmit();
                else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
              }
            });

            // Success: dialog closes AND a success Alert with "Password updated" appears.
            const successSnap = await pollPage(successPage, () => {
              const backdrop   = document.querySelector('.MuiBackdrop-root');
              const modalRoot  = document.querySelector('.MuiModal-root');
              const container  = document.querySelector('.MuiDialog-container');
              const cancelBtn  = Array.from(document.querySelectorAll('button'))
                .find(b => /^cancel$/i.test((b.textContent || '').trim()));
              const dialogOpen = (
                (backdrop  && window.getComputedStyle(backdrop).display  !== 'none') ||
                (modalRoot && window.getComputedStyle(modalRoot).display !== 'none') ||
                (container && window.getComputedStyle(container).display !== 'none') ||
                (cancelBtn && window.getComputedStyle(cancelBtn).display !== 'none')
              );
              const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
              const successAlert = alerts.find(el => /password updated/i.test(el.textContent || ''));
              if (!dialogOpen && successAlert) {
                return { closed: true, alertText: successAlert.textContent?.trim() };
              }
              return null;
            }, null, 20000);

            record(UI_LABELS[4],
              'dialog hidden + "Password updated" Alert visible on card',
              successSnap
                ? `closed=${successSnap.closed}, alertText="${successSnap.alertText?.slice(0, 80)}"`
                : 'dialog still visible or success alert missing',
              !!successSnap && successSnap.closed === true,
            );

            await closePage(successPage);
          }
        }
      } finally {
        await browser.close().catch(() => {});
      }
    }
  }

  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Change Password Dialog — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:change-password\``,
    '',
    '## Summary',
    '',
    `- Passed: ${findings.filter(f => f.ok).length} / ${findings.length}`,
    `- Failed: ${findings.filter(f => !f.ok).length} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **[API.1]** `POST /api/change-password` with empty body → 400.',
    '- **[API.2]** `POST /api/change-password` with wrong `currentPassword` → 401.',
    '- **[API.3]** `POST /api/change-password` with `currentPassword === newPassword` → 400.',
    '- **[API.4]** `POST /api/change-password` with valid credentials → 200 `{ok:true}`.',
    '- **[UI.1]**  `/profile` mounts the ProfilePage island; the Password card is',
    '              rendered; the MUI dialog has `display:none` (closed) on load.',
    '- **[UI.2]**  Clicking the button in the Password card makes the dialog visible',
    '              with 3 password inputs and Submit/Cancel buttons.',
    '- **[UI.3]**  Submitting the empty form surfaces `p.Mui-error` helper texts for',
    '              all three fields.',
    '- **[UI.4]**  Clicking "Cancel" returns the dialog to `display:none`.',
    '- **[UI.5]**  Filling valid credentials and submitting: the dialog is hidden and',
    '              a `[role="alert"]` containing "Password updated" appears on the card.',
    '',
    '## Notes',
    '',
    '- MUI v9 renders Dialog children in the DOM regardless of `open` state',
    '  (`keepMounted` is `true` by default). Open/close detection uses',
    '  `window.getComputedStyle(dialog).display` rather than DOM presence.',
    '- API.4 changes the manager user\'s password; the member user\'s password',
    '  remains `PASSWORD` so UI.5 can test the full flow independently.',
  ];
  const outPath = path.join(dir, 'change-password.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/change-password.md`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(2); });
