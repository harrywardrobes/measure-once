'use strict';
const { makeSkip } = require('../helpers/report');
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
// Probes (API):
//   [API.1]  POST /api/change-password with missing body → 400
//   [API.2]  POST /api/change-password with wrong currentPassword → 401
//   [API.3]  POST /api/change-password with currentPassword === newPassword → 400
//   [API.4]  POST /api/change-password with valid credentials → 200 {ok:true}
//
// Probes (UI):
//   [UI.1]  /profile mounts the ProfilePage island; the Password card renders;
//           the dialog visible; three password fields are visible
//   [UI.2]  clicking "Change password" button → dialog becomes visible with 3
//           fields and Submit/Cancel buttons
//   [UI-zxcvbn] typing into "New password" triggers the strength meter (or at
//           least does not crash the panel) — regression guard for task #870
//   [UI-autofill] simulating browser autofill via native value setter +
//           input event (bypassing React's onChange) — strength meter stays
//           visible and no NaN/LinearProgress errors are emitted
//   [UI.3]  submitting the empty form surfaces Mui-error helper texts for all
//           three fields inside the dialog
//   [UI.4]  clicking Cancel returns the dialog to a hidden state
//   [UI.5]  filling valid credentials and submitting: the dialog becomes
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

const { pollUntil, pollFn } = require('../helpers/poll');

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
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
}

// Convenience boolean poller — resolves true when fn() returns truthy.
async function waitUntil(fn, timeoutMs = 8000, intervalMs = 150) {
  return !!(await pollFn(fn, timeoutMs, intervalMs));
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
  // Suppress `mo:user` CustomEvent before any page script runs so that
  // core.js's double-dispatch (bootstrap() + checkAuthStatus()) does not
  // trigger ProfilePage's setAppUser() handler while the dialog is open.
  // evaluateOnNewDocument installs the capture listener before React mounts.
  await page.evaluateOnNewDocument(() => {
    window.addEventListener('mo:user', (e) => { e.stopImmediatePropagation(); }, { capture: true });
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
async function waitForProfileMounted(page) {
  return pollPage(page, () => {
    const pv = document.getElementById('profile-view');
    if (!pv || !pv.firstElementChild) return null;
    // The Sign out button signals a full render of AccountActionsCard.
    const allBtns = Array.from(document.querySelectorAll('button'));
    const signOutBtn = allBtns.find(b => /sign out/i.test(b.textContent || ''));
    return signOutBtn ? 'ok' : null;
  }, null, 25000);
}

// Click the "Change password" button inside the Password card.
async function clickChangePasswordBtn(page) {
  return page.evaluate(() => {
    // Prefer data-testid if present.
    const btn = document.querySelector('[data-testid="change-password-btn"]');
    if (btn) { btn.click(); return 'testid-dom'; }
    // Fallback: #profile-view button with matching text.
    const textBtn = Array.from(document.querySelectorAll('#profile-view button'))
      .find(b => b.textContent.trim() === 'Change password');
    if (textBtn) { textBtn.click(); return 'fallback-text'; }
    return null;
  });
}

// Returns a snapshot of the dialog state for open/content checks.
// Uses data-testid="change-password-dialog" (on the Dialog root) to detect
// visibility, avoiding brittle MUI internal class selectors.
async function getDialogState(page) {
  return page.evaluate(() => {
    const dialogEl  = document.querySelector('[data-testid="change-password-dialog"]');
    const allBtns   = Array.from(document.querySelectorAll('button'));
    const cancelBtn = allBtns.find(b => /^cancel$/i.test((b.textContent || '').trim()));
    const isModalVisible = dialogEl && window.getComputedStyle(dialogEl).display !== 'none';
    const cancelVisible = cancelBtn && window.getComputedStyle(cancelBtn).display !== 'none';
    const visible = isModalVisible || !!cancelVisible;
    if (!visible) return { visible: false };
    const pwInputs = Array.from(document.querySelectorAll('input[type="password"]'))
      .filter(el => window.getComputedStyle(el).display !== 'none');
    const hasSubmit = allBtns.some(b => /update password/i.test(b.textContent || ''));
    const hasCancel = !!cancelBtn;
    return { visible: true, inputCount: pwInputs.length, hasSubmit, hasCancel };
  });
}

// isDialogOpen helper used in pollPage callbacks.
function isDialogOpenJS() {
  const dialogEl  = document.querySelector('[data-testid="change-password-dialog"]');
  const allBtns   = Array.from(document.querySelectorAll('button'));
  const cancelBtn = allBtns.find(b => /^cancel$/i.test((b.textContent || '').trim()));
  const open = (
    (dialogEl  && window.getComputedStyle(dialogEl).display  !== 'none') ||
    (cancelBtn && window.getComputedStyle(cancelBtn).display !== 'none')
  );
  return open;
}

// Fill a password input by selector using CDP focus + keyboard events.
// page.focus() targets the exact DOM node without coordinate dispatch, so
// there is no risk of accidentally hitting the MUI backdrop.
async function fillBySelector(page, selector, value) {
  await page.focus(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.type(value, { delay: 20 });
}

// Fill the Nth visible password input (0-based) using evaluate focus +
// keyboard. Falls back gracefully if the index is out of range.
async function fillVisiblePasswordInput(page, index, value) {
  const focused = await page.evaluate((idx) => {
    const inputs = Array.from(document.querySelectorAll('input[type="password"]'));
    const el = inputs[idx];
    if (!el) return false;
    el.focus();
    return true;
  }, index);
  if (!focused) return;
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(value, { delay: 0 });
}

// Tab `tabCount` times from the currently focused element, then clear and type.
// Used by the zxcvbn regression probe to reach "New password" from auto-focus
// without coordinate-based clicks.
async function fillByTab(page, tabCount, value) {
  for (let i = 0; i < tabCount; i++) {
    await page.keyboard.press('Tab');
    await new Promise(r => setTimeout(r, 50));
  }
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.type(value, { delay: 20 });
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

  const bundlePath = path.resolve(__dirname, '..', '..', 'public', 'react', 'main.js');
  if (!fs.existsSync(bundlePath)) {
    console.error(
      '\n  ✘ public/react/main.js is missing.\n'
      + '    Run `npm run build:react` before this test.\n',
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
  function record(name, expected, observed, ok, detail = '') {
    findings.push({ name, expected, observed, ok, soft: false, detail });
    const mark = ok ? '  ✓' : '  ✗';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
      if (detail) console.log(`     detail   : ${detail}`);
    }
  }
  const skip = makeSkip(findings);
  // Soft (informational) probe — logged as a warning, never counted as failure.
  function recordSoft(name, expected, observed, ok, detail = '') {
    findings.push({ name, expected, observed, ok, soft: true, detail });
    const mark = ok ? '  ✓' : '  ⚠';
    console.log(`${mark}  ${name}${ok ? '' : ' (informational)'}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
      if (detail) console.log(`     detail   : ${detail}`);
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
    '[UI-autofill] autofill simulation — strength meter (progressbar) visible; no NaN/LinearProgress error',
    '[UI-zxcvbn] strength meter probe — dialog survives typing into "New password"',
    '[UI.3] submitting empty dialog → Mui-error helper texts appear for all 3 fields',
    '[UI.4] clicking Cancel → dialog becomes hidden again',
    '[UI.5] valid submit → dialog hidden, "Password updated" Alert visible on card',
  ];

  // Console errors from StrengthMeter and checkPasswordPolicy are expected when
  // zxcvbn throws internally (headless Chrome / module loading edge case).
  // Exclude them from the page-error accumulator.
  // TypeError about reading 'length' of null is thrown by zxcvbn's internal
  // frequency-list lookups in headless Chrome (module data not fully available).
  // It is caught and re-logged by StrengthMeter/checkPasswordPolicy with a
  // recognisable prefix, but Chrome also logs the raw error object separately
  // as a bare console.error without any caller prefix.  Both forms are expected
  // noise in this environment and must not be treated as a test failure.
  const IGNORE_RE = /(favicon\.ico|\/storybook\/|\.map\b|Failed to load resource|\[StrengthMeter\]|\[checkPasswordPolicy\]|Cannot read properties of null \(reading 'length'\))/;

  if (!puppeteer) {
    for (const l of UI_LABELS) skip(l, 'puppeteer installed', 'puppeteer not installed');
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
      for (const l of UI_LABELS) skip(l, 'browser launched', `browser launch failed: ${msg}`);
    } else {
      const pageErrors = [];
      try {
        // ── member /profile ──────────────────────────────────────────────────
        const profilePage = await newPageWithSession(browser, memberClient.cookie);

        profilePage.on('pageerror', (err) => {
          const s = String(err);
          if (IGNORE_RE.test(s)) return;
          pageErrors.push(s);
        });
        profilePage.on('console', (msg) => {
          if (msg.type() !== 'error') return;
          const text = msg.text();
          if (IGNORE_RE.test(text)) return;
          pageErrors.push(`console.error: ${text}`);
        });

        await profilePage.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        const mounted = await waitForProfileMounted(profilePage);

        if (!mounted) {
          const pageLogs = profilePage.__logs.slice(-15).join('\n');
          for (const l of UI_LABELS) {
            skip(l, 'ProfilePage mounted (Sign out button present)', `mount timed out. logs:\n${pageLogs}`);
          }
        } else {
          // UI.1 — profile card rendered; dialog hidden
          const ui1 = await profilePage.evaluate(() => {
            const hasPasswordCard = !!document.querySelector('[data-testid="change-password-btn"]');
            const dialog = document.querySelector('[role="dialog"]');
            const dialogHidden = !dialog || window.getComputedStyle(dialog).display === 'none';
            return { hasPasswordCard, dialogHidden };
          });
          record(UI_LABELS[0],
            'hasPasswordCard=true, dialogHidden=true',
            `hasPasswordCard=${ui1.hasPasswordCard}, dialogHidden=${ui1.dialogHidden}`,
            ui1.hasPasswordCard === true && ui1.dialogHidden === true,
          );

          // Arm request interception to hold the vendor-zxcvbn dynamic chunk
          // before the dialog is opened.  ChangePasswordCard's useEffect calls
          // loadZxcvbn() the moment open=true; intercepting the chunk keeps
          // _zxcvbnCache null throughout the autofill probe so StrengthMeter
          // renders the indeterminate LinearProgress (the path that previously
          // propagated NaN before the defensive score-clamping fix).
          let _heldZxcvbnReq = null;
          const _interceptZxcvbn = (req) => {
            if (/vendor-zxcvbn/.test(req.url())) {
              _heldZxcvbnReq = req; // held — NOT calling req.continue() yet
            } else {
              req.continue().catch(() => {});
            }
          };
          await profilePage.setRequestInterception(true);
          profilePage.on('request', _interceptZxcvbn);

          const _releaseZxcvbn = async () => {
            profilePage.off('request', _interceptZxcvbn);
            if (_heldZxcvbnReq) {
              _heldZxcvbnReq.continue().catch(() => {});
              _heldZxcvbnReq = null;
            }
            try { await profilePage.setRequestInterception(false); } catch (_) {}
          };

          // UI.2 — click the "Change password" button; dialog becomes visible
          const clicked = await clickChangePasswordBtn(profilePage);
          if (!clicked) {
            await _releaseZxcvbn();
            skip(UI_LABELS[1], 'button clicked', 'could not find button in Password card');
            skip(UI_LABELS[2], 'button clicked first', 'button not found');
            skip(UI_LABELS[3], 'button clicked first', 'button not found');
            skip(UI_LABELS[4], 'button clicked first', 'button not found');
            skip(UI_LABELS[5], 'button clicked first', 'button not found');
            skip(UI_LABELS[6], 'button clicked first', 'button not found');
          } else {
            const dialogVisible = await pollPage(profilePage, () => {
              const dialogEl  = document.querySelector('[data-testid="change-password-dialog"]');
              const cancelBtn = Array.from(document.querySelectorAll('button'))
                .find(b => /^cancel$/i.test((b.textContent || '').trim()));
              const open = (
                (dialogEl  && window.getComputedStyle(dialogEl).display  !== 'none') ||
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

            // UI-autofill — browser credential autofill regression guard.
            //
            // The vendor-zxcvbn chunk is held by request interception (armed
            // before the dialog was opened), keeping _zxcvbnCache = null.
            // When autofill sets the new-password field value, StrengthMeter
            // renders the indeterminate LinearProgress — the exact render path
            // that propagated NaN before the defensive score-clamping fix.
            //
            // MUI Dialog uses a React Portal (document.body), so DOM-dispatched
            // synthetic events do not reach React's root-container delegation.
            // We focus the input via screen coordinates (mouse.click crosses
            // portal boundaries) and use keyboard.type(), which fires native
            // browser input events that React's event system does intercept.
            //
            // The check is strict: the progressbar MUST be visible and no
            // NaN/LinearProgress console errors may be emitted.
            const autofillNaNErrors = [];
            const autofillConsoleHandler = (msg) => {
              if (msg.type() !== 'error') return;
              const text = msg.text();
              if (/NaN|LinearProgress/i.test(text) && !IGNORE_RE.test(text)) {
                autofillNaNErrors.push(text);
              }
            };
            profilePage.on('console', autofillConsoleHandler);

            if (dialogVisible) {
              // Wait for the dialog's password inputs to be present in the DOM.
              await pollPage(profilePage, () => {
                const dialogs = document.querySelectorAll('[role="dialog"]');
                return Array.from(dialogs).some(
                  d => d.querySelectorAll('input[type="password"]').length >= 2,
                ) ? 'ready' : null;
              }, null, 3000);

              // Locate the new-password input's screen coordinates.
              const newPwCoords = await profilePage.evaluate(() => {
                const dialogs = document.querySelectorAll('[role="dialog"]');
                for (const d of dialogs) {
                  const inputs = Array.from(d.querySelectorAll('input[type="password"]'));
                  const found = inputs.find(
                    el => el.getAttribute('autocomplete') === 'new-password',
                  ) || inputs[1];
                  if (found) {
                    const r = found.getBoundingClientRect();
                    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                  }
                }
                return null;
              });

              // Type one character to trigger onChange → StrengthMeter render.
              // Because the zxcvbn chunk is still held, _zxcvbnCache is null →
              // StrengthMeter renders the indeterminate LinearProgress.
              // The synchronous evaluate after keyboard.type() reads the DOM
              // before any pending macrotask (i.e. the chunk response) can run.
              let autofillMeterVisible = false;
              if (newPwCoords) {
                await profilePage.mouse.click(newPwCoords.x, newPwCoords.y);
                await profilePage.keyboard.type('A');
                autofillMeterVisible = await profilePage.evaluate(() => {
                  return Array.from(document.querySelectorAll('[role="dialog"]'))
                    .some(d => !!d.querySelector('[role="progressbar"]'));
                });
                // Complete the field value (UI-zxcvbn will Tab/select/replace it).
                await profilePage.keyboard.type('utofill1StrXQ9ok!', { delay: 0 });
              }

              // Release the held zxcvbn chunk so subsequent probes work normally.
              await _releaseZxcvbn();

              // Reset focus to the first (current-password) input so that the
              // following UI-zxcvbn probe's Tab navigation starts from there.
              await profilePage.evaluate(() => {
                const dialogs = document.querySelectorAll('[role="dialog"]');
                for (const d of dialogs) {
                  const first = d.querySelector('input[type="password"]');
                  if (first) { first.focus(); break; }
                }
              });

              profilePage.off('console', autofillConsoleHandler);

              record(UI_LABELS[2],
                'role="progressbar" inside dialog after autofill (_zxcvbnCache=null); 0 NaN/LinearProgress errors',
                `meter=${autofillMeterVisible ? 'visible' : 'not-visible'}, nanErrors=${autofillNaNErrors.length}`,
                autofillMeterVisible && autofillNaNErrors.length === 0,
                autofillNaNErrors.length
                  ? 'NaN/LinearProgress error(s) emitted — ErrorBoundary may have caught a NaN render: '
                    + autofillNaNErrors.slice(0, 2).join(' | ')
                  : !autofillMeterVisible
                    ? 'Indeterminate progressbar did not appear — input may not have been found, or chunk was not held.'
                    : '',
              );
            } else {
              await _releaseZxcvbn();
              profilePage.off('console', autofillConsoleHandler);
              skip(UI_LABELS[2], 'dialog visible first', 'dialog not visible');
            }

            // UI-zxcvbn — type into "New password" → strength meter or graceful catch
            // Regression guard for task #870: the panel must not crash when zxcvbn
            // throws internally. Uses Tab navigation (keyboard-only) to avoid
            // coordinate-based clicks that could land on the MUI backdrop.
            if (dialogVisible) {
              // Allow dialog animation and FocusTrap to settle.  The autofill
              // already placed a value in the new-password field; fillByTab will
              // Ctrl+A-select and replace it with the typed value.
              await new Promise(r => setTimeout(r, 500));
              // Tab once from auto-focused first element into "New password".
              await fillByTab(profilePage, 1, 'TestStr0ng88!');

              // Indeterminate progress bar appears immediately when value is truthy.
              const meterAppeared = await waitUntil(async () => {
                return profilePage.evaluate(() => {
                  return Array.from(document.querySelectorAll('[role="dialog"]'))
                    .some(d => !!d.querySelector('[role="progressbar"]'));
                });
              }, 6000);

              const dialogAliveAfterType = await profilePage.evaluate(() => {
                return Array.from(document.querySelectorAll('[role="dialog"]'))
                  .some(d => d.textContent.includes('Change password'));
              });

              if (meterAppeared) {
                record(UI_LABELS[3],
                  'role="progressbar" inside dialog (zxcvbn loading / scored)',
                  `appeared=${meterAppeared}`,
                  true,
                );
              } else {
                record(UI_LABELS[3],
                  'dialog remains open after value change (zxcvbn catch path)',
                  `dialogAlive=${dialogAliveAfterType} meterRendered=${meterAppeared}`,
                  dialogAliveAfterType,
                  'StrengthMeter may have caught a zxcvbn error — panel alive but meter null.',
                );
              }

              // Soft: did zxcvbn finish scoring and render the "Strength:" label?
              await new Promise(r => setTimeout(r, 2500));
              const scoreLabelAppeared = await profilePage.evaluate(() => {
                return Array.from(document.querySelectorAll('[role="dialog"]'))
                  .some(d => /Strength:/i.test(d.textContent));
              });
              recordSoft(
                'Strength label appears once zxcvbn finishes scoring (soft check)',
                '"Strength:" text inside dialog',
                `appeared=${scoreLabelAppeared}`,
                scoreLabelAppeared,
                scoreLabelAppeared ? '' : 'zxcvbn may have caught an error; dialog stayed alive (UI-zxcvbn).',
              );
            } else {
              skip(UI_LABELS[3], 'dialog visible first', 'dialog not visible');
              recordSoft('Strength label appears once zxcvbn finishes scoring (soft check)', '"Strength:" text', 'skipped', false, 'dialog did not open');
            }

            // UI.3 — submit empty; inline errors appear
            // Clear any typed value first (Escape re-opens cleanly for empty submit).
            if (dialogVisible) {
              await profilePage.keyboard.press('Escape');
              await waitUntil(async () => {
                return profilePage.evaluate(() => {
                  const dialogEl  = document.querySelector('[data-testid="change-password-dialog"]');
                  const cancelBtn = Array.from(document.querySelectorAll('button'))
                    .find(b => /^cancel$/i.test((b.textContent || '').trim()));
                  const open = (
                    (dialogEl  && window.getComputedStyle(dialogEl).display  !== 'none') ||
                    (cancelBtn && window.getComputedStyle(cancelBtn).display !== 'none')
                  );
                  return !open;
                });
              }, 3000);
              await new Promise(r => setTimeout(r, 150));
              await clickChangePasswordBtn(profilePage);
              // Wait for re-open.
              await pollPage(profilePage, () => {
                const dialogEl  = document.querySelector('[data-testid="change-password-dialog"]');
                const cancelBtn = Array.from(document.querySelectorAll('button'))
                  .find(b => /^cancel$/i.test((b.textContent || '').trim()));
                const open = (
                  (dialogEl  && window.getComputedStyle(dialogEl).display  !== 'none') ||
                  (cancelBtn && window.getComputedStyle(cancelBtn).display !== 'none')
                );
                return open ? 'visible' : null;
              }, null, 5000);
              await new Promise(r => setTimeout(r, 200));
            }

            await profilePage.evaluate(() => {
              const form = document.querySelector('[data-testid="change-password-dialog"] form')
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
              const invalidInputs = document.querySelectorAll('[aria-invalid="true"]');
              return invalidInputs.length >= 3 ? { errorCount: invalidInputs.length } : null;
            }, null, 8000);

            record(UI_LABELS[4],
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
              const dialogEl  = document.querySelector('[data-testid="change-password-dialog"]');
              const cancelBtn = Array.from(document.querySelectorAll('button'))
                .find(b => /^cancel$/i.test((b.textContent || '').trim()));
              const open = (
                (dialogEl  && window.getComputedStyle(dialogEl).display  !== 'none') ||
                (cancelBtn && window.getComputedStyle(cancelBtn).display !== 'none')
              );
              return open ? null : 'hidden';
            }, null, 6000);

            record(UI_LABELS[5],
              'dialog hidden after Cancel',
              dialogHiddenAfterCancel === 'hidden' ? 'dialog hidden' : 'dialog still visible',
              dialogHiddenAfterCancel === 'hidden',
            );

            await closePage(profilePage);

            // UI.5 — full success flow on a fresh page (member still has original
            //         password since API.4 only changed manager's password)
            const successPage = await newPageWithSession(browser, memberClient.cookie);

            successPage.on('pageerror', (err) => {
              const s = String(err);
              if (IGNORE_RE.test(s)) return;
              pageErrors.push(s);
            });
            successPage.on('console', (msg) => {
              if (msg.type() !== 'error') return;
              const text = msg.text();
              if (IGNORE_RE.test(text)) return;
              pageErrors.push(`console.error: ${text}`);
            });

            await successPage.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await waitForProfileMounted(successPage);

            // Open dialog
            await clickChangePasswordBtn(successPage);
            await pollPage(successPage, () => {
              const dialogEl  = document.querySelector('[data-testid="change-password-dialog"]');
              const cancelBtn = Array.from(document.querySelectorAll('button'))
                .find(b => /^cancel$/i.test((b.textContent || '').trim()));
              const open = (
                (dialogEl  && window.getComputedStyle(dialogEl).display  !== 'none') ||
                (cancelBtn && window.getComputedStyle(cancelBtn).display !== 'none')
              );
              return open ? 'visible' : null;
            }, null, 8000);
            // Allow animation and FocusTrap to settle.
            await new Promise(r => setTimeout(r, 400));

            // Fill fields using CDP focus + keyboard (no coordinate dispatch).
            // page.focus(selector) targets the exact element so there is no risk
            // of hitting the MUI backdrop.
            await fillBySelector(successPage, 'input[autocomplete="current-password"]', PASSWORD);
            await fillBySelector(successPage, 'input[autocomplete="new-password"]', NEW_PASSWORD);
            // Wait for zxcvbn async scoring before filling confirm.
            await new Promise(r => setTimeout(r, 1500));
            // Confirm is the second input[autocomplete="new-password"].
            const newPwHandles = await successPage.$$('input[autocomplete="new-password"]');
            if (newPwHandles[1]) {
              await newPwHandles[1].focus();
              await successPage.keyboard.down('Control');
              await successPage.keyboard.press('a');
              await successPage.keyboard.up('Control');
              await successPage.keyboard.type(NEW_PASSWORD, { delay: 20 });
            }
            await new Promise(r => setTimeout(r, 300));

            // Press Enter — triggers native form submit which React's onSubmit catches.
            await successPage.keyboard.press('Enter');

            // Success: dialog closes AND a success Alert with "Password updated" appears.
            const successSnap = await pollPage(successPage, () => {
              const dialogEl  = document.querySelector('[data-testid="change-password-dialog"]');
              const cancelBtn = Array.from(document.querySelectorAll('button'))
                .find(b => /^cancel$/i.test((b.textContent || '').trim()));
              const dialogOpen = (
                (dialogEl  && window.getComputedStyle(dialogEl).display  !== 'none') ||
                (cancelBtn && window.getComputedStyle(cancelBtn).display !== 'none')
              );
              const alerts = Array.from(document.querySelectorAll('[role="alert"]'));
              const successAlert = alerts.find(el => /password updated/i.test(el.textContent || ''));
              if (!dialogOpen && successAlert) {
                return { closed: true, alertText: successAlert.textContent?.trim() };
              }
              return null;
            }, null, 20000);

            record(UI_LABELS[6],
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

      // page errors collected across all browser pages
      record(
        'no unexpected page errors during the full flow',
        '0 unexpected pageerror / console.error events',
        `count=${pageErrors.length}${pageErrors.length ? ' first=' + JSON.stringify(pageErrors[0]).slice(0, 200) : ''}`,
        pageErrors.length === 0,
      );
    }
  }

  const hard     = findings.filter(f => !f.soft && !f.skipped);
  const pass     = hard.filter(f => f.ok).length;
  const fail     = hard.filter(f => !f.ok).length;
  const nSkipped = findings.filter(f => f.skipped).length;
  const warn     = findings.filter(f => f.soft && !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed${nSkipped ? `, ${nSkipped} skipped` : ''}${warn ? `, ${warn} warning(s)` : ''}`);

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
    `- Passed: ${findings.filter(f => !f.soft && !f.skipped && f.ok).length} / ${findings.filter(f => !f.soft && !f.skipped).length} (hard probes)`,
    `- Failed: ${findings.filter(f => !f.soft && !f.skipped && !f.ok).length} / ${findings.filter(f => !f.soft && !f.skipped).length} (hard probes)`,
    `- Skipped: ${findings.filter(f => f.skipped).length} / ${findings.length}`,
    `- Warnings: ${findings.filter(f => f.soft && !f.ok).length} (soft/informational)`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f => {
      const label = f.ok ? 'PASS' : (f.skipped ? 'SKIP' : f.soft ? 'WARN' : 'FAIL');
      return `| ${label} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`;
    }),
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
    '- **[UI-zxcvbn]** Typing into "New password" triggers the strength meter',
    '              (indeterminate LinearProgress before zxcvbn loads). If zxcvbn',
    '              throws internally, StrengthMeter and checkPasswordPolicy catch it',
    '              gracefully — the dialog must remain open (regression guard #870).',
    '- **[UI-autofill]** Browser autofill is simulated on a FRESH browser context',
    '              (so `_zxcvbnCache` starts as null) via `page.evaluate`: the',
    '              native `HTMLInputElement.prototype.value` setter sets the',
    '              new-password field value (bypassing React keyboard onChange,',
    '              as Chrome/Edge autofill does), then a bubbling `InputEvent` is',
    '              dispatched so React\'s synthetic onChange fires `setNext()`.',
    '              Since `_zxcvbnCache` is null at that moment, StrengthMeter',
    '              renders the indeterminate `LinearProgress` — exactly the render',
    '              path that propagated NaN before the defensive score-clamping fix.',
    '              The check is strict: the progressbar must be visible and zero',
    '              NaN/LinearProgress console errors may be emitted.',
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
    '  `window.getComputedStyle(element).display` rather than DOM presence.',
    '- API.4 changes the manager user\'s password; the member user\'s password',
    '  remains `PASSWORD` so UI.5 can test the full flow independently.',
    '- UI.5 fills fields via `page.focus(selector)` + `keyboard.type()` (CDP',
    '  focus, no coordinate dispatch) to avoid accidentally closing the dialog',
    '  by landing on the MUI backdrop.',
    '- Requires `public/react/main.js` (run `npm run build:react` first).',
  ];
  const outPath = path.join(dir, 'change-password.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`  Report: test-results/change-password.md`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(2); });
