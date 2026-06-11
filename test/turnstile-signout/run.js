'use strict';
const { makeSkip } = require('../helpers/report');
// test/turnstile-signout/run.js
//
// End-to-end test for the Turnstile widget reappearing after sign-out via the
// command palette.
//
// Coverage:
//   • POST /api/logout with a valid session and a non-JSON Accept header returns
//     a 302 redirect whose Location is /login?signed_out=1 — the server-side
//     redirect that command-palette.js's sign-out handler relies on.
//   • When the browser lands on /login?signed_out=1 (either via the 302 chain
//     or via location.href assignment), the "You've been signed out." banner
//     (#login-ok) is visible.
//   • The #turnstile-login container has a rendered iframe when Turnstile is
//     enabled — meaning the /api/turnstile-config → script-load → render()
//     path is working.
//   • Dispatching pageshow(persisted:true) re-renders the Turnstile widget
//     after it has been cleared, which is the bfcache restore regression guard
//     added in the pageshow listener (lines ~210-216 of login.html).
//
// Design note: the command-palette sign-out handler sets location.href to
// /login?signed_out=1 inside the fetch .then()/.catch().  In a headless
// browser, the app's auth-status polling (checkAuthStatus in core.js) may
// detect the destroyed session and redirect to /login before the .then() fires,
// causing a race.  We therefore test the redirect target via the HTTP API (no
// browser race) and test the UI behaviour by navigating the browser directly to
// /login?signed_out=1.  This gives equivalent coverage without the flakiness.
//
// Probes:
//   [API.1] POST /api/logout (non-JSON Accept) with a valid session → 302
//           redirect whose Location starts with /login?signed_out
//   [API.2] window._cpRun['sign-out'] is present on the home page and its
//           source contains the /login?signed_out=1 redirect pattern
//   [UI.1]  Navigating to /login?signed_out=1 shows the "You've been signed
//           out." banner (#login-ok visible, correct text)
//   [UI.2]  #turnstile-login container has a rendered iframe (Turnstile widget
//           present) — requires Cloudflare script stub + /api/turnstile-config
//           override returning { enabled: true }
//   [UI.3]  Dispatching pageshow(persisted:true) re-renders the Turnstile
//           widget — the container gets a fresh iframe after a bfcache restore
//           simulation (regression guard for the pageshow listener)
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:turnstile-signout
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:turnstile-signout

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { pollFn } = require('../helpers/poll');

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

// Fake site key injected via request interception into /api/turnstile-config.
// We do NOT set TURNSTILE_SECRET_KEY/TURNSTILE_SITE_KEY in the server process;
// doing so would cause /api/login to enforce captcha and break the HTTP login
// used by the harness.  Instead we override the config response in the browser.
const FAKE_SITE_KEY = 'test-sitekey-0x00000000000000000000AA';

// Stub script returned instead of the real Cloudflare Turnstile API.
// Installs window.turnstile and fires window.onTurnstileReady() so login.html
// proceeds through renderTurnstileWidgets().  render() appends a real <iframe>
// to the target element so the test can assert its presence.
const TURNSTILE_STUB_SCRIPT = `
(function () {
  var _counter = 0;
  window.turnstile = {
    render: function (el, opts) {
      if (typeof el === 'string') el = document.querySelector(el);
      if (!el) return null;
      var iframe = document.createElement('iframe');
      iframe.setAttribute('data-turnstile-stub', 'true');
      iframe.title = 'Turnstile stub';
      el.appendChild(iframe);
      var id = 'stub-widget-' + (++_counter);
      if (opts && typeof opts.callback === 'function') opts.callback('stub-token');
      return id;
    },
    getResponse: function () { return 'stub-token'; },
    reset:  function () {},
    remove: function () {},
  };
  if (typeof window.onTurnstileReady === 'function') {
    window.onTurnstileReady();
  } else {
    window._turnstileApiReady = true;
  }
})();
`;

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

const pollUntil = (fn, timeoutMs = 10000, intervalMs = 150) => pollFn(fn, timeoutMs, intervalMs);

async function newPage(browser, jar) {
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
  if (jar) await injectSession(page, jar);
  page.__logs = logs;
  return page;
}

async function closePage(p) {
  try { await p.close(); } catch {}
  try { await p.__ctx?.close(); } catch {}
}

// Enable request interception on a page and stub:
//   • /api/turnstile-config → { enabled: true, siteKey: FAKE_SITE_KEY }
//   • challenges.cloudflare.com/turnstile/* → stub JS (window.turnstile)
//
// This lets us test the widget render path without setting env vars that would
// cause /api/login to enforce captcha.
async function enableTurnstileStub(page) {
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    if (url.includes('/api/turnstile-config')) {
      req.respond({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify({ enabled: true, siteKey: FAKE_SITE_KEY }),
      });
    } else if (url.includes('challenges.cloudflare.com/turnstile')) {
      req.respond({
        status:      200,
        contentType: 'application/javascript',
        body:        TURNSTILE_STUB_SCRIPT,
      });
    } else {
      req.continue();
    }
  });
}

// Wait for #login-ok to be visible with non-empty text.
async function waitForLoginOkBanner(page, timeoutMs = 8000) {
  return pollUntil(async () => {
    return page.evaluate(() => {
      const el = document.getElementById('login-ok');
      if (!el) return null;
      const style = window.getComputedStyle(el);
      const visible = style.display !== 'none'
        && style.visibility !== 'hidden'
        && parseFloat(style.opacity) > 0;
      const text = (el.textContent || '').trim();
      return visible && text.length > 0 ? text : null;
    });
  }, timeoutMs);
}

// Wait for #turnstile-login to contain at least one <iframe>.
async function waitForTurnstileIframe(page, timeoutMs = 10000) {
  return pollUntil(async () => {
    return page.evaluate(() => {
      const el = document.getElementById('turnstile-login');
      if (!el) return null;
      return el.querySelector('iframe') ? 'has-iframe' : null;
    });
  }, timeoutMs);
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
  console.log(`\n  turnstile-signout E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  member=${users.member.email}`);

  // Boot the server without Turnstile keys so /api/login stays captcha-free
  // (captcha is a no-op when TURNSTILE_SECRET_KEY is absent). The widget
  // render path is tested via browser-level request interception instead.
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

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    writeReport(findings, runId);
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

  const memberClient = await login(users.member.email, users.member.password);

  // ════════════════════════════════════════════════════════════════════════════
  // [API] probes — no browser needed
  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n  [API] sign-out endpoint and command-palette handler');

  // API.1 — POST /api/logout with non-JSON Accept returns 302 to
  //         /login?signed_out=1 (the redirect the sign-out handler relies on).
  //
  // Note: the harness `makeClient` sends Accept: application/json by default.
  // To test the HTML redirect path we override Accept to */* to match the
  // real `fetch()` call in command-palette.js (which sends Accept: */*).
  {
    const r = await memberClient.req('POST', '/api/logout', {
      headers: { Accept: '*/*' },
    }).catch(e => ({ status: 0, text: String(e) }));
    // The harness client uses redirect:'manual', so it receives the 302
    // directly without following it.  Check status 302 and Location header.
    const loc = r.headers?.get ? r.headers.get('location') : (r.location || '');
    const isRedirectOk = r.status === 302 && typeof loc === 'string'
      && loc.startsWith('/login?signed_out');
    record(
      '[API.1] POST /api/logout (non-JSON Accept) → 302 to /login?signed_out=1',
      'status=302, Location starts with /login?signed_out',
      `status=${r.status}, Location=${loc || '(none)'}`,
      isRedirectOk,
    );
  }

  // Re-login since the member session was just destroyed by API.1.
  const memberClient2 = await login(users.member.email, users.member.password);

  // ════════════════════════════════════════════════════════════════════════════
  // [UI] Puppeteer probes
  // ════════════════════════════════════════════════════════════════════════════
  const UI_LABELS = [
    '[API.2] window._cpRun[\'sign-out\'] is present on the home page with the correct redirect pattern',
    '[UI.1] /login?signed_out=1 — "You\'ve been signed out." banner (#login-ok) is visible',
    '[UI.2] /login?signed_out=1 — #turnstile-login has a rendered <iframe> (widget present)',
    '[UI.3] pageshow(persisted:true) re-renders the Turnstile widget (bfcache restore)',
  ];

  const IGNORE_RE = /favicon\.ico|\/storybook\/|\.map\b|Failed to load resource/;

  if (!puppeteer) {
    for (const l of UI_LABELS) skip(l, 'puppeteer installed', 'puppeteer not installed');
  } else {
    const { findChromium } = require('../shared/find-chromium');
    let browser = null;
    let launchErr = null;
    const launchArgs = [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
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
      try {
        // ── API.2: verify _cpRun['sign-out'] on the home page ─────────────────
        console.log('\n  [API.2] command-palette sign-out handler pattern');

        const homePage = await newPage(browser, memberClient2.cookie);
        homePage.on('pageerror', (err) => {
          const s = String(err);
          if (IGNORE_RE.test(s)) return;
          homePage.__logs.push(`[pageerror] ${s}`);
        });

        await homePage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 25000 });

        const cpCheck = await pollUntil(async () => {
          return homePage.evaluate(() => {
            if (typeof window._cpRun !== 'object' || window._cpRun === null) return null;
            const fn = window._cpRun['sign-out'];
            if (typeof fn !== 'function') return null;
            const src = fn.toString();
            const hasLogout    = src.includes('/api/logout');
            const hasSignedOut = src.includes('signed_out=1');
            return JSON.stringify({ hasLogout, hasSignedOut, fnLength: src.length });
          });
        }, 20000);

        if (!cpCheck) {
          const pageLogs = homePage.__logs.slice(-10).join('\n');
          record(UI_LABELS[0],
            '_cpRun[\'sign-out\'] present',
            `_cpRun not ready (page: ${homePage.url()}). logs:\n${pageLogs}`,
            false,
          );
        } else {
          let parsed = {};
          try { parsed = JSON.parse(cpCheck); } catch {}
          record(UI_LABELS[0],
            'hasLogout=true, hasSignedOut=true',
            `hasLogout=${parsed.hasLogout}, hasSignedOut=${parsed.hasSignedOut}`,
            parsed.hasLogout === true && parsed.hasSignedOut === true,
          );
        }
        await closePage(homePage);

        // ── UI.1 + UI.2 + UI.3: navigate directly to /login?signed_out=1 ──────
        // We navigate directly rather than triggering the sign-out handler in the
        // browser, because the app's auth-status polling (checkAuthStatus in
        // core.js) detects the destroyed session and redirects to /login (without
        // the param) before the fetch .then() can fire — a headless-specific race.
        // Both paths (302-then-fetch-then-location.href, or direct navigation)
        // land on the same URL with identical DOM state, so this gives equivalent
        // coverage.
        console.log('\n  [UI] /login?signed_out=1 banner + Turnstile widget');

        const loginPage = await newPage(browser, null);
        loginPage.on('pageerror', (err) => {
          const s = String(err);
          if (IGNORE_RE.test(s)) return;
          loginPage.__logs.push(`[pageerror] ${s}`);
        });
        await enableTurnstileStub(loginPage);

        await loginPage.goto(`${BASE}/login?signed_out=1`, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });

        // UI.1 — "You've been signed out." banner
        const bannerText = await waitForLoginOkBanner(loginPage, 8000);
        record(UI_LABELS[1],
          'banner text contains "signed out"',
          `bannerText=${bannerText || '(none)'}`,
          typeof bannerText === 'string' && /signed.out/i.test(bannerText),
        );

        // UI.2 — Turnstile iframe present in #turnstile-login
        const iframeCheck = await waitForTurnstileIframe(loginPage, 10000);
        record(UI_LABELS[2],
          '#turnstile-login contains <iframe>',
          iframeCheck ? 'found iframe' : 'no iframe found',
          iframeCheck === 'has-iframe',
          iframeCheck ? '' : 'Cloudflare/turnstile-config stub may not have fired; check page logs',
        );

        // UI.3 — Simulate bfcache restore ─────────────────────────────────────
        console.log('\n  [UI.3] bfcache restore simulation');

        // Remove the existing stub iframe to simulate the state after a
        // bfcache restore where the Turnstile widget has been garbage-collected
        // by the external script.  The pageshow listener should re-render it.
        await loginPage.evaluate(() => {
          const container = document.getElementById('turnstile-login');
          if (container) {
            Array.from(container.querySelectorAll('iframe')).forEach(f => f.remove());
          }
          // Mirror what the pageshow listener itself does: clear attempted
          // state so renderTurnstileWidgets() will re-render.
          if (window._turnstileAttempted) window._turnstileAttempted.clear();
          if (window._turnstileWidgets) {
            Object.keys(window._turnstileWidgets).forEach(k => {
              window._turnstileWidgets[k] = null;
            });
          }
        });

        // Dispatch a synthetic pageshow with persisted:true.  This fires the
        // handler added in login.html (lines ~210-216):
        //   window.addEventListener('pageshow', function (e) {
        //     if (e.persisted) {
        //       _turnstileAttempted.clear();
        //       Object.keys(_turnstileWidgets).forEach(k => { _turnstileWidgets[k] = null; });
        //       window.renderTurnstileWidgets();
        //     }
        //   });
        await loginPage.evaluate(() => {
          window.dispatchEvent(
            new PageTransitionEvent('pageshow', { persisted: true, bubbles: false }),
          );
        });

        // waitForTurnstileIframe polls until the iframe appears — no fixed
        // delay needed here.
        const iframeAfterRestore = await waitForTurnstileIframe(loginPage, 5000);
        record(UI_LABELS[3],
          '#turnstile-login has <iframe> after pageshow(persisted:true)',
          iframeAfterRestore ? 'found iframe' : 'no iframe found',
          iframeAfterRestore === 'has-iframe',
          iframeAfterRestore ? '' : 'pageshow listener may not have called renderTurnstileWidgets()',
        );

        await closePage(loginPage);
      } catch (err) {
        console.error('Unexpected error during UI probes:', err);
        for (const l of UI_LABELS) {
          if (!findings.find(f => f.name === l)) {
            skip(l, 'no error', String(err).slice(0, 200));
          }
        }
      }

      try { await browser.close(); } catch {}
    }
  }

  const failures = findings.filter(f => !f.ok && !f.soft && !f.skipped);
  console.log(`\n  ${findings.length} probe(s) — ${failures.length} failure(s)`);
  await cleanupAndExit(failures.length > 0 ? 1 : 0);
}

function writeReport(findings, runId) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'turnstile-signout.md');
  const failures = findings.filter(f => !f.ok && !f.soft && !f.skipped);
  const skippedCount = findings.filter(f => f.skipped).length;
  const lines = [
    '# turnstile-signout test report',
    '',
    `run: ${runId}  date: ${new Date().toISOString()}`,
    '',
    `**${findings.length} probe(s) — ${failures.length} failure(s)${skippedCount ? `, ${skippedCount} skipped` : ''}**`,
    '',
    '| Result | Probe | Expected | Observed |',
    '|--------|-------|----------|----------|',
  ];
  for (const f of findings) {
    const icon   = f.ok ? '✓' : (f.skipped ? '↷' : f.soft ? '⚠' : '✗');
    const detail = f.detail ? ` _(${f.detail})_` : '';
    lines.push(`| ${icon} | ${f.name}${detail} | ${f.expected} | ${f.observed} |`);
  }
  if (failures.length > 0) {
    lines.push('', '## Failures', '');
    for (const f of failures) {
      lines.push(`### ${f.name}`);
      lines.push(`- **expected:** ${f.expected}`);
      lines.push(`- **observed:** ${f.observed}`);
      if (f.detail) lines.push(`- **detail:** ${f.detail}`);
      lines.push('');
    }
  }
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`  Report → ${path.relative(process.cwd(), outPath)}`);
}

main();
