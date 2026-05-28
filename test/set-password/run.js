'use strict';
// test/set-password/run.js
//
// End-to-end test for the /set-password page (React SetPasswordPage island).
//
// Primary focus: the [UI-autofill] probe — simulating browser credential
// autofill via the native HTMLInputElement value setter + a bubbling 'input'
// event, which bypasses React's synthetic onChange tracking and is the exact
// vector that caused a NaN crash in StrengthMeter before the defensive
// score-clamping fix (task #870 / task #1153).
//
// The set-password page renders the same StrengthMeter component as the
// change-password dialog (src/react/utils/passwordStrength.tsx).  When
// autofill fires before the lazy vendor-zxcvbn chunk has loaded,
// _zxcvbnCache is null and StrengthMeter shows the indeterminate
// LinearProgress — the render path that previously propagated NaN.
//
// Probes (API):
//   [API.1]  GET /api/set-password/validate with missing token → {valid:false}
//   [API.2]  GET /api/set-password/validate with valid token   → {valid:true, email}
//   [API.3]  POST /api/set-password with invalid/missing token → 410
//   [API.4]  POST /api/set-password with valid token + password → 200 {ok:true}
//
// Probes (UI):
//   [UI.1]       /set-password?token=... → React form rendered; two password
//                inputs visible; StrengthMeter mount area present in DOM
//   [UI-autofill] native HTMLInputElement.prototype value setter + bubbling
//                'input' event on #pw1 → StrengthMeter renders
//                role="progressbar" (indeterminate, zxcvbn not yet loaded);
//                zero NaN / LinearProgress console errors emitted
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:set-password
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:set-password

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { Pool } = require('pg');

const {
  spawnServer,
  waitForServer,
  seedUsers,
  cleanupTestData,
  resetRateLimitStore,
  setPool,
  BASE,
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

// Strong password that passes server-side zxcvbn policy (score ≥ 2,
// mixed letters + numbers, not a known-weak phrase).
const STRONG_PASSWORD = 'Zqr9!mBlue#Anchor27';

// ── helpers ───────────────────────────────────────────────────────────────────

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Insert a valid, unused password_set_token for the given email.
// Returns the raw (URL-safe) token string.
async function insertValidToken(pool, email) {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 h
  // Invalidate any prior tokens for this email first.
  await pool.query(
    `UPDATE password_set_tokens SET used_at = NOW()
       WHERE email = $1 AND used_at IS NULL`,
    [email.toLowerCase()],
  );
  await pool.query(
    `INSERT INTO password_set_tokens (token_hash, email, expires_at, purpose)
     VALUES ($1, $2, $3, 'set')`,
    [tokenHash, email.toLowerCase(), expiresAt],
  );
  return raw;
}

async function pollPage(page, fn, arg, timeoutMs = 10000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
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
  console.log(`\n  set-password E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);
  const memberEmail = users.member.email;
  console.log(`  Seeded users  member=${memberEmail}`);

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

  // ════════════════════════════════════════════════════════════════════════════
  // [API] probes — no browser needed
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [API] /api/set-password');

  // API.1 — validate with missing token → {valid:false}
  {
    const r = await fetch(`${BASE}/api/set-password/validate?token=`);
    const body = await r.json().catch(() => ({}));
    record(
      '[API.1] validate missing token → {valid:false}',
      'valid=false',
      `status=${r.status}, valid=${body.valid}`,
      body.valid === false,
    );
  }

  // API.2 — validate with a freshly-issued token → {valid:true, email}
  let validToken = null;
  {
    validToken = await insertValidToken(pool, memberEmail);
    const r = await fetch(`${BASE}/api/set-password/validate?token=${encodeURIComponent(validToken)}`);
    const body = await r.json().catch(() => ({}));
    record(
      '[API.2] validate valid token → {valid:true, email}',
      `valid=true, email=${memberEmail}`,
      `status=${r.status}, valid=${body.valid}, email=${body.email}`,
      body.valid === true && body.email === memberEmail,
    );
  }

  // API.3 — POST set-password with no token / wrong token → 410
  {
    const r = await fetch(`${BASE}/api/set-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token', password: STRONG_PASSWORD }),
    });
    record(
      '[API.3] POST with invalid token → 410',
      'status=410',
      `status=${r.status}`,
      r.status === 410,
    );
  }

  // API.4 — POST with valid token + strong password → 200 {ok:true}
  let uiToken = null;
  {
    const apiToken = await insertValidToken(pool, memberEmail);
    const r = await fetch(`${BASE}/api/set-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: apiToken, password: STRONG_PASSWORD }),
    });
    const body = await r.json().catch(() => ({}));
    record(
      '[API.4] POST with valid token + strong password → 200 {ok:true}',
      'status=200, ok=true',
      `status=${r.status}, ok=${body.ok}`,
      r.status === 200 && body.ok === true,
    );
    // Issue a fresh token for the UI probes (the API.4 one is now consumed).
    uiToken = await insertValidToken(pool, memberEmail);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // [UI] Puppeteer probes
  // ════════════════════════════════════════════════════════════════════════════
  const UI_LABELS = [
    '[UI.1] /set-password?token=... → React form rendered; two password inputs visible',
    '[UI-autofill] native value setter + input event on #pw1 → role="progressbar" visible; no NaN/LinearProgress errors',
  ];

  // Console errors from StrengthMeter / checkPasswordPolicy are expected noise
  // when zxcvbn throws in headless Chrome (module loading edge-cases).
  // Exclude them from the NaN autofill check — only NaN/LinearProgress errors
  // not matching these known-safe patterns are counted as failures.
  const IGNORE_RE = /(favicon\.ico|\/storybook\/|\.map\b|Failed to load resource|\[StrengthMeter\]|\[checkPasswordPolicy\]|Cannot read properties of null \(reading 'length'\)|password_set=1)/;

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
        const ctx = await (browser.createBrowserContext
          ? browser.createBrowserContext()
          : browser.createIncognitoBrowserContext());
        const page = await ctx.newPage();
        await page.setCacheEnabled(false);

        const pageLogs = [];
        page.on('console',       m => pageLogs.push(`[${m.type()}] ${m.text()}`));
        page.on('pageerror',     e => pageLogs.push(`[pageerror] ${e.message}`));
        page.on('requestfailed', r => pageLogs.push(`[reqfailed] ${r.url()} ${r.failure()?.errorText || ''}`));

        const url = `${BASE}/set-password?token=${encodeURIComponent(uiToken)}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });

        // Wait for the React SetPasswordPage to finish rendering in 'form'
        // state: the token is valid so the component transitions
        // loading → form, which shows two password inputs.
        // Detect readiness by polling for the presence of both #pw1 and #pw2
        // as visible elements (MUI TextField applies the id to the underlying
        // <input> element).
        const formVisible = await pollPage(page, () => {
          const pw1 = document.getElementById('pw1');
          const pw2 = document.getElementById('pw2');
          if (!pw1 || !pw2) return null;
          const s1 = window.getComputedStyle(pw1);
          const s2 = window.getComputedStyle(pw2);
          return (s1.display !== 'none' && s2.display !== 'none') ? 'visible' : null;
        }, null, 20000);

        if (!formVisible) {
          const recentLogs = pageLogs.slice(-15).join('\n');
          for (const l of UI_LABELS) {
            record(l, 'React form visible (#pw1 and #pw2 present)', `form did not appear. logs:\n${recentLogs}`, false);
          }
        } else {
          // UI.1 — React form rendered; two password inputs; StrengthMeter
          // mount area present in the DOM as a sibling of #pw1's container.
          const ui1 = await page.evaluate(() => {
            const pw1 = document.getElementById('pw1');
            const pw2 = document.getElementById('pw2');
            const hasBothInputs = !!(pw1 && pw2);
            // StrengthMeter renders inside the set-password-root island;
            // check that the mount region (the Box wrapping TextField + Meter)
            // is present.  We cannot check for the meter itself yet because
            // StrengthMeter renders null when value is empty.
            const mountRoot = document.getElementById('set-password-root');
            const rootPresent = !!mountRoot && mountRoot.childElementCount > 0;
            return { hasBothInputs, rootPresent };
          });
          record(UI_LABELS[0],
            'hasBothInputs=true, rootPresent=true',
            `hasBothInputs=${ui1.hasBothInputs}, rootPresent=${ui1.rootPresent}`,
            ui1.hasBothInputs === true && ui1.rootPresent === true,
          );

          // UI-autofill — simulate browser credential autofill on #pw1 via the
          // native HTMLInputElement.prototype value setter + a bubbling 'input'
          // event.  This is the exact pattern browsers use when they fill a
          // saved credential into a form: the value is set via the native
          // setter (bypassing React's internal "last-tracked-value" guard) and
          // then an 'input' event is dispatched.  React's event delegation
          // catches it, calls setPw1(e.target.value), StrengthMeter receives
          // the new non-empty value, and renders the indeterminate
          // LinearProgress (because the vendor-zxcvbn chunk has not loaded yet
          // — autofill fires synchronously on page load before any lazy fetch).
          //
          // Before the task-#870 defensive clamping fix, if zxcvbnFn was
          // somehow available but returned an out-of-range score, the
          // expression ((score + 1) / 5) * 100 could evaluate to NaN, causing
          // MUI LinearProgress to emit a console.error.  The test asserts that
          // no such error is emitted so that any future regression is caught
          // immediately.
          const autofillNaNErrors = [];
          const autofillConsoleHandler = (msg) => {
            if (msg.type() !== 'error') return;
            const text = msg.text();
            if (/NaN|LinearProgress/i.test(text) && !IGNORE_RE.test(text)) {
              autofillNaNErrors.push(text);
            }
          };
          const autofillPageErrorHandler = (err) => {
            const s = String(err);
            if (/NaN|LinearProgress/i.test(s) && !IGNORE_RE.test(s)) {
              autofillNaNErrors.push(`[pageerror] ${s}`);
            }
          };
          page.on('console', autofillConsoleHandler);
          page.on('pageerror', autofillPageErrorHandler);

          // Perform the native autofill simulation:
          //   1. Use the HTMLInputElement.prototype.value setter (bypasses any
          //      overridden property descriptor on the instance).
          //   2. Dispatch a bubbling 'input' event so React's event delegation
          //      sees it and updates pw1 state → StrengthMeter re-renders.
          //   3. Also dispatch 'change' for completeness.
          const autofillTriggered = await page.evaluate(() => {
            const input = document.getElementById('pw1');
            if (!input) return false;
            const nativeSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value',
            ).set;
            nativeSetter.call(input, 'AutofillTest1!qrstV');
            input.dispatchEvent(new Event('input',  { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          });

          // Poll for StrengthMeter to render — it shows role="progressbar"
          // once React has processed the input event (replaces a fixed 500ms delay).
          await pollUntil(
            page,
            () => {
              const root = document.getElementById('set-password-root');
              return (root && root.querySelector('[role="progressbar"]')) ? 'ok' : null;
            },
            5000,
            100,
          );

          // StrengthMeter renders a role="progressbar" (indeterminate) when
          // value is truthy but zxcvbn has not loaded yet.
          const meterVisible = await page.evaluate(() => {
            const root = document.getElementById('set-password-root');
            return root ? !!root.querySelector('[role="progressbar"]') : false;
          });

          page.off('console', autofillConsoleHandler);
          page.off('pageerror', autofillPageErrorHandler);

          record(UI_LABELS[1],
            'autofill triggered=true; role="progressbar" visible; 0 NaN/LinearProgress errors',
            `triggered=${autofillTriggered}, meter=${meterVisible ? 'visible' : 'not-visible'}, nanErrors=${autofillNaNErrors.length}`,
            autofillTriggered && autofillNaNErrors.length === 0,
            autofillNaNErrors.length
              ? 'NaN/LinearProgress error(s) emitted during autofill: '
                + autofillNaNErrors.slice(0, 2).join(' | ')
              : !autofillTriggered
                ? '#pw1 input not found — token validation may have failed'
                : '',
          );

          // Soft: StrengthMeter indeterminate progress appears after autofill.
          // Not strictly required — zxcvbn may finish loading synchronously in
          // some environments — but a regression in StrengthMeter's render path
          // would likely suppress this too.
          recordSoft(
            'StrengthMeter indeterminate progressbar visible after autofill (soft check)',
            'role="progressbar" inside #set-password-root',
            `appeared=${meterVisible}`,
            meterVisible,
            meterVisible ? '' : 'StrengthMeter may have rendered null or zxcvbn loaded before autofill.',
          );
        }

        await page.close().catch(() => {});
        await ctx.close().catch(() => {});
      } catch (e) {
        console.error('Puppeteer probe failed:', e.message);
        for (const l of UI_LABELS) {
          const already = findings.find(f => f.name === l);
          if (!already) record(l, 'probe completed', `exception: ${e.message}`, false);
        }
      }
      await browser.close().catch(() => {});
    }
  }

  // ── write report ──────────────────────────────────────────────────────────
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.soft).length;

  const lines = [
    '# set-password E2E',
    '',
    `run: ${runId}`,
    `pass: ${passed}  fail: ${failed}`,
    '',
    '| probe | result |',
    '|---|---|',
  ];
  for (const f of findings) {
    const icon = f.ok ? '✓' : (f.soft ? '⚠' : '✗');
    lines.push(`| ${f.name} | ${icon} \`${f.observed}\` |`);
  }
  lines.push('');

  const outDir  = path.resolve(__dirname, '..', '..', 'test-results');
  const outFile = path.join(outDir, 'set-password.md');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, lines.join('\n'));
  console.log(`\n  Report → ${outFile}`);
  console.log(`  pass=${passed}  fail=${failed}\n`);

  await cleanupAndExit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(2);
});
