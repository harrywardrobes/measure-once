'use strict';
const { makeSkip3 } = require('../helpers/report');

const PROBE_LABELS = [
  '[A] dev mode OFF → all contacts returned (including hw_test_user=true)',
  '[B] dev mode ON → hw_test_user=true contacts excluded',
  '[C] dev mode OFF again → all contacts visible once more',
  '[D] UI smoke — projects board renders after dev-mode toggle',
];

// test/project-contacts-dev-mode/run.js
//
// Regression guard for the dev-mode filtering added to /api/project-contacts
// in task #1883.  Verifies:
//
//   [A] Dev mode OFF: GET /api/project-contacts returns all contacts —
//       both the hw_test_user=true contact and the normal contact.
//
//   [B] Dev mode ON:  GET /api/project-contacts returns only the
//       hw_test_user=true contact; the real contact is filtered out.
//
//   [C] Dev mode OFF again: all contacts visible once more (toggle is
//       reversible without a server restart).
//
//   [D] UI — admin + dev mode ON:  #dev-mode-banner Alert is visible on
//       the /projects page.
//
//   [E] UI — dev mode OFF: #dev-mode-banner is absent on /projects.
//
// Strategy:
//   Spins up a mock HubSpot HTTP server (HUBSPOT_API_URL override).
//   Seeds one lead_status_config row so the IN-filter is non-empty.
//   Two contacts returned by POST /crm/v3/objects/contacts/search:
//     • TEST_CONTACT  — hw_test_user: 'true'
//     • REAL_CONTACT  — hw_test_user: 'false'
//   Dev mode is toggled via POST /api/admin/hubspot/dev-mode.
//   The project-contacts cache is busted between filter-state changes so
//   the route always re-reads from the mock (no stale-cache hits).
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:project-contacts-dev-mode
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:project-contacts-dev-mode

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'project-contacts-dev-mode.md',
);
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}
const skip = makeSkip3(findings);

// ── Synthetic test data ───────────────────────────────────────────────────────

const STATUS_KEY    = 'PRIVTEST_PCDM_OPEN';
const TEST_CONTACT  = {
  id: 'privtest-pcdm-test-001',
  properties: {
    firstname:        'PrivTest',
    lastname:         'TestUser',
    email:            'privtest-pcdm-test@privtest.local',
    hs_lead_status:   STATUS_KEY,
    hw_test_user:     'true',
    createdate:       new Date().toISOString(),
    lastmodifieddate: new Date().toISOString(),
  },
};

const REAL_CONTACT  = {
  id: 'privtest-pcdm-real-001',
  properties: {
    firstname:        'PrivTest',
    lastname:         'RealUser',
    email:            'privtest-pcdm-real@privtest.local',
    hs_lead_status:   STATUS_KEY,
    hw_test_user:     'false',
    createdate:       new Date().toISOString(),
    lastmodifieddate: new Date().toISOString(),
  },
};

// ── Mock HubSpot server ───────────────────────────────────────────────────────

function startMockHubspot() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const url = req.url.split('?')[0];

      if (url === '/crm/v3/objects/contacts/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          total: 2,
          results: [TEST_CONTACT, REAL_CONTACT],
        }));
      }

      if (req.method === 'GET' && url.startsWith('/crm/v3/properties/contacts/')) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', message: 'already exists (mock)' }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: `no mock for ${req.method} ${url}` }));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpReq(base, method, urlPath, cookie, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const bodyStr = bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined;
    const headers = {};
    if (cookie) headers['Cookie'] = cookie;
    if (bodyStr) {
      headers['Content-Type']   = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: data, json });
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Puppeteer helpers ─────────────────────────────────────────────────────────

function parseCookieKV(jar) {
  if (!jar) return null;
  const idx = jar.indexOf('=');
  if (idx < 0) return null;
  return { name: jar.slice(0, idx), value: jar.slice(idx + 1) };
}

async function injectSession(page, jar, base) {
  const kv = parseCookieKV(jar);
  if (!kv) return;
  const { hostname } = new URL(base);
  await page.setCookie({ name: kv.name, value: kv.value, domain: hostname, path: '/', httpOnly: true });
}

async function pollPage(page, fn, timeoutMs = 14000, intervalMs = 150) {
  return pollUntil(page, fn, timeoutMs, intervalMs);
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

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  project-contacts-dev-mode  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL'}`);

  const pool = new Pool({ connectionString: connStr });
  const mock = await startMockHubspot();
  console.log(`  mock HubSpot listening on http://127.0.0.1:${mock.port}`);

  process.env.HUBSPOT_API_URL                   = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_ACCESS_TOKEN              = 'privtest-dummy-token';
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';
  process.env.PRIVTEST_USE_HUBSPOT_API_URL      = '1';

  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool, BASE, PASSWORD,
  } = require('../privileges/harness');
  setPool(pool);

  await cleanupTestData(pool);
  await pool.query('DELETE FROM lead_status_config WHERE key = $1', [STATUS_KEY]);

  await pool.query(
    `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
       VALUES ($1, 'PrivTest PCDM Open', 991, false)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label`,
    [STATUS_KEY],
  );

  const users = await seedUsers(pool, runId);
  const { child, logBuf } = spawnServer();
  let exitCode = 1;
  let browser;

  const cleanup = async () => {
    try { child.kill('SIGTERM'); } catch {}
    try {
      await pool.query('DELETE FROM lead_status_config WHERE key = $1', [STATUS_KEY]);
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('dev_mode_enabled', 'false')
         ON CONFLICT (key) DO UPDATE SET value = 'false'`,
      );
      await cleanupTestData(pool);
    } catch {}
    await pool.end().catch(() => {});
    try { mock.server.close(); } catch {}
  };
  process.on('SIGINT',  () => cleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => cleanup().then(() => process.exit(130)));

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  test server up at ${BASE}\n`);

    const adminClient = await login(users.admin.email, PASSWORD);
    const cookie = adminClient.cookie;

    // Ensure dev mode starts as OFF.
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('dev_mode_enabled', 'false')
       ON CONFLICT (key) DO UPDATE SET value = 'false'`,
    );

    // ── Helper: bust cache then GET /api/project-contacts ─────────────────────
    async function fetchProjectContacts() {
      const bust = await httpReq(BASE, 'POST',
        '/api/admin/test/bust-project-contacts-cache', cookie, {});
      if (bust.status !== 200) {
        throw new Error(`bust-project-contacts-cache returned ${bust.status}`);
      }
      return httpReq(BASE, 'GET', '/api/project-contacts', cookie);
    }

    // ── [A] Dev mode OFF: all contacts returned ───────────────────────────────
    console.log('  [A] Dev mode OFF — all contacts returned');

    const aResp = await fetchProjectContacts();
    const aIds  = (aResp.json?.results || []).map(c => c.id);

    record('A.1 GET /api/project-contacts returns 200',
      aResp.status === 200,
      `status=${aResp.status}`);
    record('A.2 test contact is present',
      aIds.includes(TEST_CONTACT.id),
      `ids=${JSON.stringify(aIds)}`);
    record('A.3 real contact is present',
      aIds.includes(REAL_CONTACT.id),
      `ids=${JSON.stringify(aIds)}`);
    record('A.4 total includes both contacts',
      (aResp.json?.total ?? 0) >= 2,
      `total=${aResp.json?.total}`);

    // ── [B] Dev mode ON: only hw_test_user contacts returned ─────────────────
    console.log('\n  [B] Dev mode ON — only test contacts returned');

    const bToggle = await httpReq(BASE, 'POST',
      '/api/admin/hubspot/dev-mode', cookie, { devMode: true });
    record('B.1 POST dev-mode true returns 200',
      bToggle.status === 200,
      `status=${bToggle.status}`);
    record('B.2 response echoes devMode=true',
      bToggle.json?.devMode === true,
      `devMode=${bToggle.json?.devMode}`);

    const bResp = await fetchProjectContacts();
    const bIds  = (bResp.json?.results || []).map(c => c.id);

    record('B.3 GET /api/project-contacts returns 200',
      bResp.status === 200,
      `status=${bResp.status}`);
    record('B.4 test contact is present',
      bIds.includes(TEST_CONTACT.id),
      `ids=${JSON.stringify(bIds)}`);
    record('B.5 real contact is absent (filtered out)',
      !bIds.includes(REAL_CONTACT.id),
      `ids=${JSON.stringify(bIds)}`);
    record('B.6 total is 1 (only the test contact)',
      bResp.json?.total === 1,
      `total=${bResp.json?.total}`);

    // ── [C] Dev mode OFF: all contacts visible again ──────────────────────────
    console.log('\n  [C] Dev mode OFF again — all contacts returned');

    const cToggle = await httpReq(BASE, 'POST',
      '/api/admin/hubspot/dev-mode', cookie, { devMode: false });
    record('C.1 POST dev-mode false returns 200',
      cToggle.status === 200,
      `status=${cToggle.status}`);
    record('C.2 response echoes devMode=false',
      cToggle.json?.devMode === false,
      `devMode=${cToggle.json?.devMode}`);

    const cResp = await fetchProjectContacts();
    const cIds  = (cResp.json?.results || []).map(c => c.id);

    record('C.3 GET /api/project-contacts returns 200',
      cResp.status === 200,
      `status=${cResp.status}`);
    record('C.4 test contact is present again',
      cIds.includes(TEST_CONTACT.id),
      `ids=${JSON.stringify(cIds)}`);
    record('C.5 real contact is present again',
      cIds.includes(REAL_CONTACT.id),
      `ids=${JSON.stringify(cIds)}`);
    record('C.6 total includes both contacts again',
      (cResp.json?.total ?? 0) >= 2,
      `total=${cResp.json?.total}`);

    // ── [D/E] UI banner probes (Puppeteer) ────────────────────────────────────
    console.log('\n  [D/E] Puppeteer: #dev-mode-banner on /projects');

    const D_UI_PROBE_LABELS = [
      'D.0 headless chromium launches',
      'D.1 #projects-view renders',
      'D.2 #dev-mode-banner is visible (dev mode ON + admin)',
      'D.3 banner text mentions "Dev mode is ON"',
      'E.1 #projects-view renders',
      'E.2 #dev-mode-banner is absent (dev mode OFF)',
    ];

    if (!puppeteer) {
      for (const l of D_UI_PROBE_LABELS) {
        skip(l, 'puppeteer not installed — UI probes skipped');
      }
    } else {
      const { findChromium } = require('../shared/find-chromium');
      const executablePath   = findChromium() || undefined;

      try {
        browser = await puppeteer.launch({
          headless:        true,
          executablePath,
          defaultViewport: { width: 1280, height: 900 },
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
      } catch (launchErr) {
        const msg = (launchErr?.message || String(launchErr)).slice(0, 200);
        for (const l of PROBE_LABELS) record(l, false, `browser launch failed: ${msg}`);
        throw launchErr;
      }
      record('D.0 headless chromium launches', true, 'browser started');

      // ── [D] Banner present when dev mode ON ──────────────────────────────
      console.log('\n    [D] admin + dev mode ON → banner present');

      await httpReq(BASE, 'POST',
        '/api/admin/hubspot/dev-mode', cookie, { devMode: true });

      const pageD = await browser.newPage();
      await pageD.setCacheEnabled(false);

      pageD.on('console', msg => {
        const t = msg.text();
        if (t.startsWith('[diag') || t.startsWith('[test') || t.startsWith('[projects')) {
          console.log(`    [browser] ${t}`);
        }
      });

      // Stub /api/project-contacts so React renders without waiting on the
      // real HubSpot cache (which may still be warm from probe C).
      await pageD.evaluateOnNewDocument(() => {
        const orig = window.fetch;
        window.fetch = function(input, init) {
          const url      = typeof input === 'string' ? input : (input?.url ?? '');
          const pathname = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0];
          if (pathname === '/api/project-contacts') {
            return Promise.resolve(new Response(
              JSON.stringify({ results: [], total: 0 }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ));
          }
          return orig.call(this, input, init);
        };
      });

      await injectSession(pageD, cookie, BASE);
      await pageD.goto(`${BASE}/projects`, { waitUntil: 'domcontentloaded', timeout: 25000 });

      const dLoaded = await pollPage(pageD, () => {
        const el = document.getElementById('projects-view');
        return el && el.innerHTML.trim().length > 50 ? 'ok' : null;
      }, 20000);
      record('D.1 #projects-view renders', dLoaded === 'ok', `loaded=${dLoaded}`);

      // Allow React to settle after the devMode fetch completes.
      await new Promise(r => setTimeout(r, 2500));

      const dBanner = await pageD.evaluate(
        () => !!document.getElementById('dev-mode-banner'),
      );
      record('D.2 #dev-mode-banner is visible (dev mode ON + admin)',
        dBanner, `found=${dBanner}`);

      const dText = await pageD.evaluate(() => {
        const el = document.getElementById('dev-mode-banner');
        return el ? el.textContent : '';
      });
      record('D.3 banner text mentions "Dev mode is ON"',
        (dText || '').includes('Dev mode is ON'),
        `text=${String(dText).slice(0, 120)}`);

      await pageD.close();

      // ── [E] Banner absent when dev mode OFF ──────────────────────────────
      console.log('\n    [E] dev mode OFF → banner absent');

      await httpReq(BASE, 'POST',
        '/api/admin/hubspot/dev-mode', cookie, { devMode: false });

      const pageE = await browser.newPage();
      await pageE.setCacheEnabled(false);

      await pageE.evaluateOnNewDocument(() => {
        const orig = window.fetch;
        window.fetch = function(input, init) {
          const url      = typeof input === 'string' ? input : (input?.url ?? '');
          const pathname = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0];
          if (pathname === '/api/project-contacts') {
            return Promise.resolve(new Response(
              JSON.stringify({ results: [], total: 0 }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ));
          }
          return orig.call(this, input, init);
        };
      });

      await injectSession(pageE, cookie, BASE);
      await pageE.goto(`${BASE}/projects`, { waitUntil: 'domcontentloaded', timeout: 25000 });

      const eLoaded = await pollPage(pageE, () => {
        const el = document.getElementById('projects-view');
        return el && el.innerHTML.trim().length > 50 ? 'ok' : null;
      }, 20000);
      record('E.1 #projects-view renders', eLoaded === 'ok', `loaded=${eLoaded}`);

      await new Promise(r => setTimeout(r, 2500));

      const eBanner = await pageE.evaluate(
        () => !!document.getElementById('dev-mode-banner'),
      );
      record('E.2 #dev-mode-banner is absent (dev mode OFF)',
        !eBanner, `found=${eBanner}`);

      await pageE.close();
    }

    const failed = findings.filter(f => !f.ok && !f.skipped).length;
    const skipped = findings.filter(f => f.skipped).length;
    exitCode = failed === 0 ? 0 : 1;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);

  } catch (e) {
    console.error('Test crashed:', e);
    console.error('--- server log (last 3000 chars) ---');
    console.error((logBuf || []).join('').slice(-3000));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await writeReport(runId);
    await cleanup();
    process.exit(exitCode);
  }
}

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc    = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const lines = [
    '# Project-Contacts Dev-Mode Filter — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:project-contacts-dev-mode\``,
    '',
    '## Summary',
    '',
    `- Passed: ${passed} / ${findings.length}`,
    `- Failed: ${failed} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Detail |',
    '|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'} | ${esc(f.id)} | ${esc(f.detail)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **(A) Baseline (dev mode off)**: `GET /api/project-contacts` returns both',
    '  contacts — the `hw_test_user=true` contact and the `hw_test_user=false` contact.',
    '- **(B) Dev mode ON**: `POST /api/admin/hubspot/dev-mode { devMode: true }` persists',
    '  the flag; subsequent `GET /api/project-contacts` returns only the test contact.',
    '  The real contact is absent (`total=1`).',
    '- **(C) Dev mode OFF**: `POST /api/admin/hubspot/dev-mode { devMode: false }` restores',
    '  full visibility — both contacts are returned again.',
    '- **(D) UI banner present**: Puppeteer navigates to `/projects` as admin while',
    '  dev mode is ON; asserts `#dev-mode-banner` is visible and contains',
    '  "Dev mode is ON".',
    '- **(E) UI banner absent**: Puppeteer navigates to `/projects` as admin while',
    '  dev mode is OFF; asserts `#dev-mode-banner` is not in the DOM.',
    '',
    '## Relevant files',
    '',
    '- `server.js` — `applyProjectContactsDevModeFilter` and `/api/project-contacts` route',
    '- `src/react/pages/ProjectsPage.tsx` — `#dev-mode-banner` Alert',
    '- `src/react/hooks/useDevMode.ts` — `GET /api/admin/hubspot/dev-mode` hook',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
