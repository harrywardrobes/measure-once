'use strict';
const { makeSkip } = require('../helpers/report');

const DEF_UI_PROBE_LABELS = [
  '[DEF-UI] Bar contains renderable custom default keys (home, projects)',
  '[DEF-UI] Default "customers" key is NOT in bar (overridden by custom default)',
  '[DEF-UI-RESTORE] Bar falls back to member defaults (home, customers, projects)',
];

// test/bottom-nav-default/run.js
//
// Regression guard: the admin-configured __default__ nav layout
// must reach a user who has no job_role assigned.
//
// Covers:
//   [DEF-API]    GET /api/nav-role-config for a no-role user includes
//                default_is_customized=false when __default__ is not customised.
//   [DEF-API-CUSTOM] After PATCH /api/admin/nav-role-config/__default__, the
//                endpoint returns the new keys AND default_is_customized=true.
//   [DEF-UI]     BottomNav renders the admin-configured __default__ keys for a
//                no-role user (Puppeteer, request-intercept).
//   [DEF-UI-RESTORE] After the __default__ is reset (is_customized=false),
//                the bar falls back to privilege-level defaults.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:bottom-nav-default
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:bottom-nav-default

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const {
  spawnServer,
  waitForServer,
  seedUsers,
  cleanupTestData,
  login,
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
 * Open the home page, inject the session cookie, wait for BottomNav to mount,
 * and wait for the nav bar to stabilise.
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

  await waitForNavBarStability(page, 4000, 100);

  page.__logs = pageLogs;
  return page;
}

/**
 * Return the nav key ids currently rendered inside the bar (excludes "more").
 */
function readBarKeys(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('nav.bottom-nav#main-content');
    if (!nav) return null;
    return ['home', 'customers', 'projects']
      .filter(k => !!nav.querySelector(`#bnav-${k}`));
  });
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
  console.log(`\n  bottom-nav-default E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);
  console.log(`  Seeded  member=${users.member.email}  admin=${users.admin.email}`);

  // Ensure member user has no job_role
  await pool.query('UPDATE users SET job_role = NULL WHERE id = $1', [users.member.id]);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  const findings = [];
  function record(name, expected, observed, ok) {
    findings.push({ name, expected, observed, ok });
    const icon = ok ? '  ✔' : '  ✘';
    console.log(`${icon} ${name}`);
    if (!ok) console.log(`      expected: ${expected}\n      observed: ${observed}`);
  }
  const skip = makeSkip(findings);

  let adminClient = null;
  let memberClient = null;

  try {
    await waitForServer(BASE);

    adminClient  = await login(users.admin.email, PASSWORD);
    memberClient = await login(users.member.email, PASSWORD);

    // ── [DEF-API] No-role user sees default keys, default_is_customized=false ──

    {
      const r = await memberClient.get('/api/nav-role-config');
      record(
        '[DEF-API] /api/nav-role-config returns 200',
        'status=200',
        `status=${r.status}`,
        r.status === 200,
      );
      record(
        '[DEF-API] role field is null for no-role user',
        'role=null',
        `role=${JSON.stringify(r.json?.role)}`,
        r.json?.role === null,
      );
      record(
        '[DEF-API] default_is_customized is false before any admin change',
        'default_is_customized=false',
        `default_is_customized=${r.json?.default_is_customized}`,
        r.json?.default_is_customized === false,
      );
    }

    // ── [DEF-API-CUSTOM] After admin patches __default__, flags update ─────────

    const CUSTOM_KEYS = ['home', 'projects', 'invoices'];
    const origDefaultKeys = ['home', 'customers', 'projects'];

    {
      const patch = await adminClient.patch(
        '/api/admin/nav-role-config/__default__',
        { primary_keys: CUSTOM_KEYS },
      );
      record(
        '[DEF-API-CUSTOM] PATCH /api/admin/nav-role-config/__default__ returns 200',
        'status=200',
        `status=${patch.status}`,
        patch.status === 200,
      );

      const r = await memberClient.get('/api/nav-role-config');
      record(
        '[DEF-API-CUSTOM] primary_keys reflects custom default',
        `primary_keys=${JSON.stringify(CUSTOM_KEYS)}`,
        `primary_keys=${JSON.stringify(r.json?.primary_keys)}`,
        JSON.stringify(r.json?.primary_keys) === JSON.stringify(CUSTOM_KEYS),
      );
      record(
        '[DEF-API-CUSTOM] default_is_customized=true after admin PATCH',
        'default_is_customized=true',
        `default_is_customized=${r.json?.default_is_customized}`,
        r.json?.default_is_customized === true,
      );
    }

    // ── UI probes ─────────────────────────────────────────────────────────────

    if (!puppeteer) {
      console.warn('\n  [UI] puppeteer not installed — skipping UI probes');
      for (const l of DEF_UI_PROBE_LABELS) {
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
        for (const l of DEF_UI_PROBE_LABELS) skip(l, 'browser launched', `browser launch failed: ${msg}`);
        return;
      }

      try {
        // ════════════════════════════════════════════════════════════════════════
        // [DEF-UI] BottomNav renders the custom __default__ keys for a no-role user
        //
        // Strategy:
        //   The __default__ is already patched to CUSTOM_KEYS above.  Log in as
        //   member (no job_role) and verify the bar shows the renderable custom
        //   keys (home, projects); 'invoices' is configured but no longer rendered.
        // ════════════════════════════════════════════════════════════════════════
        console.log('\n  [DEF-UI] BottomNav renders admin-configured __default__ tabs for no-role user');

        // Re-login to get a fresh session that sees the updated __default__
        const memberClient2 = await login(users.member.email, PASSWORD);

        const page = await openHomePage(browser, memberClient2.cookie);
        const barKeys = await readBarKeys(page);

        // 'invoices' is part of the custom __default__ config but is no longer a
        // rendered nav item (the /invoices page was removed), so the bar filters
        // it out — assert only the renderable custom keys are present.
        const renderableCustomKeys = CUSTOM_KEYS.filter(k => k !== 'invoices');
        record(
          '[DEF-UI] Bar contains renderable custom default keys (home, projects)',
          `bar includes ${JSON.stringify(renderableCustomKeys)}`,
          `bar=${JSON.stringify(barKeys)}`,
          !!barKeys && renderableCustomKeys.every(k => barKeys.includes(k)),
        );
        record(
          '[DEF-UI] Default "customers" key is NOT in bar (overridden by custom default)',
          'customers absent',
          barKeys && barKeys.includes('customers') ? 'present' : 'absent',
          !!(barKeys && !barKeys.includes('customers')),
        );

        await page.close().catch(() => {});
        await page.__ctx.close().catch(() => {});

        // ════════════════════════════════════════════════════════════════════════
        // [DEF-UI-RESTORE] After clearing __default__ customisation, bar uses
        // privilege-level defaults
        //
        // Strategy:
        //   Reset __default__ directly in DB (is_customized=false, canonical keys).
        //   DELETE /api/admin/nav-role-config/__default__ is intentionally blocked
        //   (400) so we use pool.query to reset state.
        //   Open a fresh page as the no-role member and verify the bar falls back
        //   to the hardcoded DEFAULT_PRIMARY_KEYS (home, customers, projects).
        // ════════════════════════════════════════════════════════════════════════
        console.log('\n  [DEF-UI-RESTORE] BottomNav falls back to defaults when __default__ is reset');

        await pool.query(
          `UPDATE nav_role_configs
             SET primary_keys = $1, is_customized = FALSE
           WHERE role_name = '__default__'`,
          [JSON.stringify(origDefaultKeys)],
        );

        const memberClient3 = await login(users.member.email, PASSWORD);
        const page2 = await openHomePage(browser, memberClient3.cookie);
        const barKeys2 = await readBarKeys(page2);

        const MEMBER_DEFAULTS = ['home', 'customers', 'projects'];
        record(
          '[DEF-UI-RESTORE] Bar falls back to member defaults (home, customers, projects)',
          `bar includes ${JSON.stringify(MEMBER_DEFAULTS)}`,
          `bar=${JSON.stringify(barKeys2)}`,
          !!barKeys2 && MEMBER_DEFAULTS.every(k => barKeys2.includes(k)),
        );

        await page2.close().catch(() => {});
        await page2.__ctx.close().catch(() => {});

      } finally {
        await browser.close().catch(() => {});
      }
    }

    // Restore __default__ to its canonical uncustomised state via DB
    await pool.query(
      `UPDATE nav_role_configs
         SET primary_keys = $1, is_customized = FALSE
       WHERE role_name = '__default__'`,
      [JSON.stringify(origDefaultKeys)],
    );

  } finally {
    // ── Report ──────────────────────────────────────────────────────────────
    const passed = findings.filter(f => f.ok).length;
    const failed = findings.filter(f => !f.ok && !f.skipped).length;
    const skipped = findings.filter(f => f.skipped).length;
    console.log(`\n  Passed: ${passed}  Failed: ${failed}`);

    const outDir = path.resolve(__dirname, '../../test-results');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'bottom-nav-default.md');

    const rows = findings.map(f =>
      `| ${f.ok ? '✅' : '❌'} | ${f.name} | ${f.expected} | ${f.observed} |`
    ).join('\n');

    const summary = `# bottom-nav-default test results\n\nRun: ${new Date().toISOString()}  run-id: ${runId}\n\n`
      + `**${passed} passed / ${failed} failed**\n\n`
      + `| Result | Name | Expected | Observed |\n`
      + `| --- | --- | --- | --- |\n`
      + rows + '\n';

    fs.writeFileSync(outFile, summary);
    console.log(`  Report → ${outFile}`);

    if (failed > 0) {
      const failNames = findings.filter(f => !f.ok).map(f => `  • ${f.name}`).join('\n');
      console.error(`\n  FAILED probes:\n${failNames}\n`);
      if (logBuf.length) {
        console.error('\n  --- server log tail ---');
        console.error(logBuf.join('').slice(-3000));
      }
    }

    if (!exited) child.kill('SIGTERM');
    await pool.end().catch(() => {});
    process.exit(failed > 0 ? 1 : 0);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(2);
});
