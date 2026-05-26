'use strict';
// test/login/run.js
//
// Autofill-crash guard for the /login page (React LoginPage island).
//
// The login form has two credential fields that browsers fill via the native
// HTMLInputElement value setter + a bubbling 'input' event — bypassing React's
// synthetic onChange tracking.  This is the same vector tested on the
// set-password page (task #1153 / task #1258).  Unlike set-password, the login
// form renders no StrengthMeter, so the probe is purely a crash/error guard:
// simulating autofill must not produce any console errors.
//
// Probes (UI):
//   [UI.1]        /login → React LoginPage rendered; #login-email and
//                 #login-password inputs visible
//   [UI-autofill] native HTMLInputElement.prototype value setter + bubbling
//                 'input' event on both #login-email and #login-password →
//                 no console errors emitted
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:login
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:login

const fs   = require('fs');
const path = require('path');
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

// ── helpers ───────────────────────────────────────────────────────────────────

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
  console.log(`\n  login autofill E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  await seedUsers(pool, runId);
  console.log(`  Seeded users  runId=${runId}`);

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
  // [UI] Puppeteer probes
  // ════════════════════════════════════════════════════════════════════════════
  const UI_LABELS = [
    '[UI.1] /login → React LoginPage rendered; #login-email and #login-password visible',
    '[UI-autofill] native value setter + input event on email and password → no console errors',
  ];

  // Patterns that are acceptable noise and should not count as failures.
  const IGNORE_RE = /(favicon\.ico|\/storybook\/|\.map\b|Failed to load resource|turnstile|challenges\.cloudflare)/i;

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

        await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 25000 });

        // Wait for the React LoginPage to finish rendering: both #login-email
        // and #login-password must be present and visible in the DOM.
        const formVisible = await pollPage(page, () => {
          const email = document.getElementById('login-email');
          const pw    = document.getElementById('login-password');
          if (!email || !pw) return null;
          const se = window.getComputedStyle(email);
          const sp = window.getComputedStyle(pw);
          return (se.display !== 'none' && sp.display !== 'none') ? 'visible' : null;
        }, null, 20000);

        if (!formVisible) {
          const recentLogs = pageLogs.slice(-15).join('\n');
          for (const l of UI_LABELS) {
            record(l, 'React form visible (#login-email and #login-password present)', `form did not appear. logs:\n${recentLogs}`, false);
          }
        } else {
          // UI.1 — React form rendered; both inputs present.
          const ui1 = await page.evaluate(() => {
            const email = document.getElementById('login-email');
            const pw    = document.getElementById('login-password');
            const root  = document.getElementById('login-root');
            return {
              hasEmail: !!(email),
              hasPassword: !!(pw),
              rootPresent: !!(root && root.childElementCount > 0),
            };
          });
          record(UI_LABELS[0],
            'hasEmail=true, hasPassword=true, rootPresent=true',
            `hasEmail=${ui1.hasEmail}, hasPassword=${ui1.hasPassword}, rootPresent=${ui1.rootPresent}`,
            ui1.hasEmail && ui1.hasPassword && ui1.rootPresent,
          );

          // UI-autofill — simulate browser credential autofill on both the
          // email and password fields via the native HTMLInputElement.prototype
          // value setter + a bubbling 'input' event.  This bypasses React's
          // internal "last-tracked-value" guard (the same bypass browsers use
          // when filling saved credentials), which is the exact vector that
          // could trigger crashes in any input-driven component added in the
          // future.  Assert that no console errors are emitted.
          const autofillErrors = [];
          const autofillConsoleHandler = (msg) => {
            if (msg.type() !== 'error') return;
            const text = msg.text();
            if (!IGNORE_RE.test(text)) {
              autofillErrors.push(text);
            }
          };
          const autofillPageErrorHandler = (err) => {
            const s = String(err);
            if (!IGNORE_RE.test(s)) {
              autofillErrors.push(`[pageerror] ${s}`);
            }
          };
          page.on('console',   autofillConsoleHandler);
          page.on('pageerror', autofillPageErrorHandler);

          // Perform the native autofill simulation on both fields:
          //   1. Use HTMLInputElement.prototype.value setter (bypasses any
          //      overridden property descriptor on the instance).
          //   2. Dispatch a bubbling 'input' event so React's event delegation
          //      sees it and updates state.
          //   3. Also dispatch 'change' for completeness.
          const autofillTriggered = await page.evaluate(() => {
            const emailInput = document.getElementById('login-email');
            const pwInput    = document.getElementById('login-password');
            if (!emailInput || !pwInput) return false;
            const nativeSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value',
            ).set;
            nativeSetter.call(emailInput, 'autofill-test@example.com');
            emailInput.dispatchEvent(new Event('input',  { bubbles: true }));
            emailInput.dispatchEvent(new Event('change', { bubbles: true }));
            nativeSetter.call(pwInput, 'AutofillTest1!qrstV');
            pwInput.dispatchEvent(new Event('input',  { bubbles: true }));
            pwInput.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          });

          // Give React's render cycle time to settle.
          await new Promise(r => setTimeout(r, 500));

          page.off('console',   autofillConsoleHandler);
          page.off('pageerror', autofillPageErrorHandler);

          record(UI_LABELS[1],
            'autofill triggered=true; 0 console errors',
            `triggered=${autofillTriggered}, errors=${autofillErrors.length}`,
            autofillTriggered && autofillErrors.length === 0,
            autofillErrors.length
              ? 'Console error(s) emitted during autofill: '
                + autofillErrors.slice(0, 2).join(' | ')
              : !autofillTriggered
                ? '#login-email or #login-password not found'
                : '',
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
    '# login autofill E2E',
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
  const outFile = path.join(outDir, 'login.md');
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
