'use strict';

const PROBE_LABELS = [
  '[STALE] banner appears when X-Cache-Status: stale',
  '[FRESH] banner absent when X-Cache-Status: fresh',
  '[DISMISS] banner disappears after clicking dismiss (×)',
];

// test/room-stale-banner/run.js
//
// Verifies that the room-assignments stale-data banner:
//   [STALE]   appears ("Room data may be out of date") when
//             GET /api/localdata/all returns X-Cache-Status: stale.
//   [FRESH]   is absent when the header is X-Cache-Status: fresh.
//   [DISMISS] disappears after the user clicks the dismiss (×) button.
//
// The test stubs /api/localdata/all via Puppeteer request interception so
// it controls the X-Cache-Status header without requiring a real HubSpot
// outage.  /api/open-leads is also stubbed (empty results) so the page
// bootstrap succeeds and renderProjectsView() is reached.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:room-stale-banner
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:room-stale-banner

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

const { pollUntil } = require('../helpers/poll');

// ── helpers ───────────────────────────────────────────────────────────────────

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

function findChromium() {
  const { findChromium: shared } = require('../shared/find-chromium');
  return shared() || undefined;
}

// Poll page.evaluate(fn) until it returns truthy or timeout elapses.
async function pollPage(page, fn, arg, timeoutMs = 8000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
}

// Open a fresh page with request interception. The cacheStatus argument
// controls what X-Cache-Status value /api/localdata/all will report.
// /api/open-leads is also stubbed to return an empty result set so that
// the page bootstrap completes without a live HubSpot token.
async function openProjectsPage(browser, cookie, cacheStatus) {
  const page = await browser.newPage();
  page.on('pageerror', () => {});
  page.on('console',   () => {});

  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();

    // Stub /api/localdata/all with the requested X-Cache-Status header.
    if (url.includes('/api/localdata/all')) {
      req.respond({
        status:      200,
        contentType: 'application/json',
        headers:     { 'X-Cache-Status': cacheStatus },
        body:        JSON.stringify({}),
      });
      return;
    }

    // Stub /api/open-leads so bootstrap succeeds without HubSpot.
    if (url.includes('/api/open-leads')) {
      req.respond({
        status:      200,
        contentType: 'application/json',
        body:        JSON.stringify({ results: [], total: 0 }),
      });
      return;
    }

    req.continue();
  });

  await injectSession(page, cookie);
  await page.goto(`${BASE}/projects`, {
    waitUntil: 'domcontentloaded',
    timeout:   25000,
  });

  // Wait for the React ProjectsPage to finish loading.
  // Step 1: wait for any content (React island mounts, skeleton appears).
  await pollPage(page, () => {
    const v = document.getElementById('projects-view');
    return v && v.innerHTML.trim().length > 0 ? 'ok' : null;
  }, null, 15000);
  // Step 2: wait for the loading skeleton to disappear and real content to render.
  // The sort-bar Select (.MuiSelect-root) is always present once loading=false.
  // #room-stale-banner is now appended to document.body by workflow-core.js,
  // so we no longer look for it inside #projects-view.
  await page.waitForSelector(
    '#projects-view .MuiSelect-root, #room-stale-banner',
    { timeout: 12000 },
  ).catch(() => {});

  return page;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  room-stale-banner E2E\n');

  const findings = [];
  function record(name, expected, observed, ok, detail) {
    findings.push({ name, expected, observed, ok, detail: detail || '' });
    const mark = ok ? '  \u2713' : '  \u2717';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${JSON.stringify(expected)}`);
      console.log(`     observed : ${JSON.stringify(observed)}`);
      if (detail) console.log(`     detail   : ${detail}`);
    }
  }

  // ── DB safety check ───────────────────────────────────────────────────────
  const dbUrl = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Set DATABASE_URL_TEST or DATABASE_URL before running.');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL_TEST && process.env.PRIVTEST_ALLOW_SHARED_DB !== '1') {
    console.error(
      'Refusing to run against shared DATABASE_URL.\n'
      + 'Set DATABASE_URL_TEST=<disposable> or PRIVTEST_ALLOW_SHARED_DB=1.',
    );
    process.exit(2);
  }

  if (!puppeteer) {
    for (const l of PROBE_LABELS) {
      record(l, 'puppeteer installed', 'puppeteer not installed', false);
    }
    writeReport(findings);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: dbUrl });
  setPool(pool);

  const runId = `rsb-${Date.now().toString(36)}`;
  const { child, logBuf } = spawnServer();

  let browser;
  let exitCode = 0;

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    await cleanupTestData(pool);

    const seeded = await seedUsers(pool, runId);
    const admin  = seeded.admin;

    const adminClient = await login(admin.email, admin.password);

    const executablePath = findChromium();
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      defaultViewport: { width: 1280, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    // ── [STALE] banner visible when X-Cache-Status: stale ────────────────────
    console.log('  [STALE] X-Cache-Status: stale → banner appears');
    {
      const page = await openProjectsPage(browser, adminClient.cookie, 'stale');

      const bannerVisible = await page.evaluate(() => {
        const el = document.getElementById('room-stale-banner');
        if (!el) return false;
        const st = window.getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden';
      });

      record(
        '[STALE] #room-stale-banner is visible in DOM',
        'element present and visible',
        bannerVisible ? 'present and visible' : 'absent or hidden',
        bannerVisible,
        bannerVisible ? '' : 'state.roomAssignmentsStale was not set from X-Cache-Status: stale header',
      );

      const bannerText = await page.evaluate(() => {
        const el = document.getElementById('room-stale-banner');
        return el ? el.textContent.trim() : '';
      });
      const textOk = bannerText.includes('Room data may be out of date');
      record(
        '[STALE] banner contains expected text',
        '"Room data may be out of date"',
        bannerText || '(empty)',
        textOk,
      );

      await page.close().catch(() => {});
    }

    // ── [FRESH] banner absent when X-Cache-Status: fresh ─────────────────────
    console.log('\n  [FRESH] X-Cache-Status: fresh → banner absent');
    {
      const page = await openProjectsPage(browser, adminClient.cookie, 'fresh');

      const bannerPresent = await page.evaluate(() =>
        !!document.getElementById('room-stale-banner'),
      );

      record(
        '[FRESH] #room-stale-banner is absent from DOM',
        'element not present',
        bannerPresent ? 'element found in DOM' : 'not present',
        !bannerPresent,
        bannerPresent ? 'Banner rendered despite X-Cache-Status: fresh — state.roomAssignmentsStale should be false' : '',
      );

      await page.close().catch(() => {});
    }

    // ── [DISMISS] clicking × removes the banner ───────────────────────────────
    console.log('\n  [DISMISS] clicking dismiss → banner disappears');
    {
      const page = await openProjectsPage(browser, adminClient.cookie, 'stale');

      // Confirm banner is present first.
      const beforeDismiss = await page.evaluate(() =>
        !!document.getElementById('room-stale-banner'),
      );
      record(
        '[DISMISS] banner present before dismiss click',
        'present',
        beforeDismiss ? 'present' : 'absent',
        beforeDismiss,
        beforeDismiss ? '' : 'Banner did not appear before the dismiss test — earlier STALE case should have caught this',
      );

      if (beforeDismiss) {
        // Click the dismiss button.
        const clicked = await page.evaluate(() => {
          const btn = document.querySelector('.room-stale-banner-dismiss');
          if (!btn) return false;
          btn.click();
          return true;
        });
        record(
          '[DISMISS] dismiss button (.room-stale-banner-dismiss) clickable',
          'click() succeeds',
          clicked ? 'clicked' : 'button not found',
          clicked,
        );

        // After click the banner should be gone from the DOM.
        const afterDismiss = await page.evaluate(() =>
          !!document.getElementById('room-stale-banner'),
        );
        record(
          '[DISMISS] #room-stale-banner removed after dismiss',
          'not present',
          afterDismiss ? 'still in DOM' : 'removed',
          !afterDismiss,
          afterDismiss ? 'Banner still present after clicking dismiss — onclick handler did not fire or remove() failed' : '',
        );
      }

      await page.close().catch(() => {});
    }

  } catch (e) {
    record('test harness setup', 'no error', `error: ${e.message}`, false,
      (logBuf || []).slice(-20).join(''));
    exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { await cleanupTestData(pool); } catch {}
    try { await pool.end(); } catch {}
    try { child.kill('SIGTERM'); } catch {}
  }

  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);
  writeReport(findings);
  process.exit(fail > 0 || exitCode ? 1 : 0);
}

function writeReport(findings) {
  try {
    const dir = path.resolve(__dirname, '..', '..', 'test-results');
    fs.mkdirSync(dir, { recursive: true });
    const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const pass = findings.filter(f => f.ok).length;
    const lines = [
      '# Room stale-data banner — E2E report',
      '',
      `- Date: ${new Date().toISOString()}`,
      `- Command: \`npm run test:room-stale-banner\``,
      '',
      '## Summary',
      '',
      `- Passed: ${pass} / ${findings.length}`,
      `- Failed: ${findings.filter(f => !f.ok).length} / ${findings.length}`,
      '',
      '## What is tested',
      '',
      'Stubs `GET /api/localdata/all` via Puppeteer request interception to',
      'control the `X-Cache-Status` response header without a real HubSpot',
      'outage.  Also stubs `/api/open-leads` with empty results so the page',
      'bootstrap completes and `renderProjectsView()` is reached.',
      '',
      '| Scenario | What is verified |',
      '|----------|-----------------|',
      '| STALE    | Banner `#room-stale-banner` is visible + contains "Room data may be out of date" when header is `stale` |',
      '| FRESH    | Banner is absent from DOM when header is `fresh` |',
      '| DISMISS  | Clicking the × button removes the banner from the DOM |',
      '',
      '## Results',
      '',
      '| Result | Probe | Expected | Observed |',
      '|--------|-------|----------|----------|',
      ...findings.map(f =>
        `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
      ),
      '',
      '## Relevant files',
      '',
      '- `public/workflow-core.js` — `_loadWorkflowStagesImpl` reads the',
      '  `X-Cache-Status` header and sets `state.roomAssignmentsStale`.',
      '- `server.js` — `GET /api/localdata/all` handler that sets the header.',
    ];
    fs.writeFileSync(path.join(dir, 'room-stale-banner.md'), lines.join('\n'));
    console.log('  Report: test-results/room-stale-banner.md');
  } catch (e) {
    console.error('writeReport failed:', e.message);
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(2);
});
