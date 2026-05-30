'use strict';
const { makeSkip3 } = require('../helpers/report');
// test/project-contacts-unknown-status/run.js
//
// Regression guard for the "orphan-check" logic added in task #1653.
// Verifies that contacts with room data (measure_once_rooms) but an absent or
// unconfigured HubSpot lead status appear in /api/project-contacts with
// _statusUnknown: true, and are NOT silently dropped from the Projects board.
//
// Probes:
//   [PC-A] API: GET /api/project-contacts returns 200 and includes the
//          synthetic unknown-status contact in results.
//   [PC-B] API: The synthetic contact carries _statusUnknown: true.
//   [PC-C] API: Contacts returned by the IN-filter (known statuses) are NOT
//          tagged with _statusUnknown (regression: they must not appear twice).
//   [PC-D] UI (Puppeteer): The Projects page card for the unknown-status
//          contact shows the amber "Unknown status" badge text.
//
// Strategy:
//   Spins up a mock HubSpot HTTP server (HUBSPOT_API_URL override).
//   POST /crm/v3/objects/contacts/search:
//     • With filterGroups (project-contacts IN-filter) → empty results.
//     • Without filterGroups (fetchAllContactsShared)  → returns the synthetic
//       unknown-status contact with measure_once_rooms set.
//   Seeds lead_status_config with one known key (PRIVTEST_PC_OPEN).
//   The synthetic contact has hs_lead_status='PRIVTEST_PC_UNKNOWN_UNCONFIGURED'
//   which is NOT in lead_status_config — so the IN-filter misses it, but the
//   shared-cache scan picks it up and tags it with _statusUnknown: true.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:project-contacts-unknown-status
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:project-contacts-unknown-status

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil } = require('../helpers/poll');

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'project-contacts-unknown-status.md',
);
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}
const skip = makeSkip3(findings);

// ── Synthetic test data ───────────────────────────────────────────────────────

const SYNTHETIC_CONTACT_ID   = 'privtest-pc-unknown-001';
const KNOWN_CONTACT_ID       = 'privtest-pc-known-001';
const UNKNOWN_STATUS_KEY     = 'PRIVTEST_PC_UNKNOWN_UNCONFIGURED';
const KNOWN_STATUS_KEY       = 'PRIVTEST_PC_OPEN';

const UNKNOWN_STATUS_CONTACT = {
  id: SYNTHETIC_CONTACT_ID,
  properties: {
    firstname:          'PrivTest',
    lastname:           'UnknownStatus',
    email:              'privtest-pc-unknown@privtest.local',
    hs_lead_status:     UNKNOWN_STATUS_KEY,
    measure_once_rooms: '[{"name":"Living Room","width":400,"height":300}]',
    createdate:         new Date().toISOString(),
    lastmodifieddate:   new Date().toISOString(),
  },
};

// A contact that would be returned by the IN-filter (known status, no room data).
// Used to populate the mock's filterGroups response so we can confirm _statusUnknown
// is NOT added to contacts returned via the known-status path.
const KNOWN_STATUS_CONTACT = {
  id: KNOWN_CONTACT_ID,
  properties: {
    firstname:          'PrivTest',
    lastname:           'KnownStatus',
    email:              'privtest-pc-known@privtest.local',
    hs_lead_status:     KNOWN_STATUS_KEY,
    measure_once_rooms: null,
    createdate:         new Date().toISOString(),
    lastmodifieddate:   new Date().toISOString(),
  },
};

// ── Mock HubSpot server ───────────────────────────────────────────────────────
// Handles POST /crm/v3/objects/contacts/search only; all other paths → 404.
// Differentiates the two callers by presence of filterGroups in the body:
//   • filterGroups present → project-contacts IN-filter → return known contact only.
//   • filterGroups absent  → fetchAllContactsShared     → return both contacts
//     (the unknown-status one is the critical one for the orphan-check path).

function startMockHubspot() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      if (!req.url.startsWith('/crm/v3/objects/contacts/search')) {
        // Property registration and other startup calls land here — return
        // a harmless 409 so the server treats it as "already exists".
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', message: 'already exists (mock)' }));
      }

      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {}

      const hasFilterGroups = Array.isArray(body.filterGroups) && body.filterGroups.length > 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });

      if (hasFilterGroups) {
        // Project-contacts IN-filter: return only the known-status contact so
        // the orphan-check later sees it has already been surfaced.
        res.end(JSON.stringify({ total: 1, results: [KNOWN_STATUS_CONTACT] }));
      } else {
        // fetchAllContactsShared: return both contacts so the orphan-check
        // can find the unknown-status one (id not in the IN-filter result set).
        res.end(JSON.stringify({ total: 2, results: [KNOWN_STATUS_CONTACT, UNKNOWN_STATUS_CONTACT] }));
      }
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
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
    const req = http.request({
      method,
      hostname: u.hostname,
      port:     u.port,
      path:     u.pathname + u.search,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
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
  console.log(`\n  project-contacts-unknown-status  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL'}`);

  const pool = new Pool({ connectionString: connStr });

  const mock = await startMockHubspot();
  console.log(`  mock HubSpot listening on http://127.0.0.1:${mock.port}`);

  // Point the spawned server's HubSpot HTTP calls at the mock server, and
  // provide a dummy token so requireHubspotToken passes.
  process.env.HUBSPOT_API_URL                   = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_ACCESS_TOKEN              = 'privtest-dummy-token';
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';

  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool, BASE,
  } = require('../privileges/harness');
  setPool(pool);

  // Pre-clean any leftovers from prior runs.
  await cleanupTestData(pool);
  await pool.query(`DELETE FROM lead_status_config WHERE key = $1`, [KNOWN_STATUS_KEY]);

  // Seed one configured lead-status row so the project-contacts IN-filter is
  // non-empty (otherwise the route short-circuits with an empty result set).
  await pool.query(
    `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
       VALUES ($1, 'PrivTest PC Open', 990, false)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label`,
    [KNOWN_STATUS_KEY],
  );

  const users = await seedUsers(pool, runId);
  const { child, logBuf } = spawnServer();
  let exitCode = 1;
  let browser;

  const cleanup = async () => {
    try { child.kill('SIGTERM'); } catch {}
    try {
      await pool.query(`DELETE FROM lead_status_config WHERE key = $1`, [KNOWN_STATUS_KEY]);
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

    const adminClient = await login(users.admin.email, users.admin.password);
    const cookie = adminClient.cookie;

    // ── [PC-A/B] API: unknown-status contact appears with _statusUnknown: true ─

    console.log('  [PC-A/B] GET /api/project-contacts — orphan-check produces _statusUnknown');

    // Bust the project-contacts cache so the route does a fresh HubSpot fan-out
    // rather than serving whatever warm data the test server started with.
    const bustResp = await httpReq(BASE, 'POST',
      '/api/admin/test/bust-project-contacts-cache', cookie, {});
    record('PC-A0 bust-project-contacts-cache succeeds',
      bustResp.status === 200, `status=${bustResp.status}`);

    const pcResp = await httpReq(BASE, 'GET', '/api/project-contacts', cookie);
    record('PC-A1 GET /api/project-contacts returns 200',
      pcResp.status === 200, `status=${pcResp.status} body=${pcResp.body.slice(0, 200)}`);

    const results   = pcResp.json?.results ?? [];
    const unknown   = results.find(c => c.id === SYNTHETIC_CONTACT_ID);
    const known     = results.find(c => c.id === KNOWN_CONTACT_ID);

    record('PC-A2 unknown-status contact present in results',
      !!unknown, `found=${!!unknown} totalResults=${results.length}`);

    record('PC-B1 unknown-status contact has _statusUnknown: true',
      unknown?._statusUnknown === true,
      `_statusUnknown=${unknown?._statusUnknown}`);

    record('PC-B2 unknown-status contact retains measure_once_rooms',
      !!(unknown?.properties?.measure_once_rooms),
      `measure_once_rooms=${String(unknown?.properties?.measure_once_rooms).slice(0, 80)}`);

    // ── [PC-C] Known-status contacts must NOT get _statusUnknown tagged ───────

    record('PC-C1 known-status contact present in results (from IN-filter mock)',
      !!known, `found=${!!known}`);

    // Contacts returned by the IN-filter path are added to allResults before the
    // orphan-check runs.  The orphan-check only adds contacts NOT already in
    // allResults, so the known contact must appear exactly once and without the
    // _statusUnknown flag (it keeps whatever the mock returned, no flag added).
    record('PC-C2 known-status contact does NOT have _statusUnknown: true',
      known?._statusUnknown !== true,
      `_statusUnknown=${known?._statusUnknown}`);

    const duplicates = results.filter(c => c.id === KNOWN_CONTACT_ID);
    record('PC-C3 known-status contact appears exactly once (not duplicated by orphan-check)',
      duplicates.length === 1,
      `count=${duplicates.length}`);

    // ── [PC-D] UI (Puppeteer): amber "Unknown status" badge on the card ───────

    console.log('\n  [PC-D] Puppeteer: "Unknown status" badge on the Projects page');

    const PC_D_PROBE_LABELS = [
      'PC-D0 headless chromium launches',
      'PC-D1 #projects-view renders content',
      'PC-D2 "Unknown status" badge text appears in #projects-view',
    ];

    if (!puppeteer) {
      for (const l of PC_D_PROBE_LABELS) {
        skip(l, 'puppeteer not installed — UI probes skipped');
      }
    } else {
      const { findChromium } = require('../shared/find-chromium');
      const executablePath = findChromium() || undefined;

      try {
        browser = await puppeteer.launch({
          headless:        true,
          executablePath,
          defaultViewport: { width: 1280, height: 900 },
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
      } catch (launchErr) {
        const msg = (launchErr?.message || String(launchErr)).slice(0, 200);
        for (const l of PC_D_PROBE_LABELS) record(l, false, `browser launch failed: ${msg}`);
        throw launchErr;
      }
      record('PC-D0 headless chromium launches', true, 'browser started');

      const page = await browser.newPage();
      await page.setCacheEnabled(false);

      page.on('console', msg => {
        const t = msg.text();
        if (t.startsWith('[diag') || t.startsWith('[test') || t.startsWith('[projects')) {
          console.log(`    [browser] ${t}`);
        }
      });

      // Override window.fetch for /api/project-contacts client-side so the
      // React island gets the synthetic unknown-status contact regardless of
      // whether the server-side warm cache has already been evicted.
      const contactJson = JSON.stringify({
        ...UNKNOWN_STATUS_CONTACT,
        _statusUnknown: true,
      });
      await page.evaluateOnNewDocument((json) => {
        const origFetch = window.fetch;
        window.fetch = function(input, init) {
          const url      = typeof input === 'string' ? input : (input && input.url) || '';
          const pathname = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0];
          if (pathname === '/api/project-contacts') {
            const c = JSON.parse(json);
            return Promise.resolve(new Response(
              JSON.stringify({ results: [c], total: 1 }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ));
          }
          return origFetch.call(this, input, init);
        };
      }, contactJson);

      await injectSession(page, cookie, BASE);
      await page.goto(`${BASE}/projects`, { waitUntil: 'domcontentloaded', timeout: 25000 });

      // Wait for the React island to render its first non-trivial content.
      const loaded = await pollPage(page, () => {
        const el = document.getElementById('projects-view');
        return el && el.innerHTML.trim().length > 100 ? 'ok' : null;
      }, 20000);
      record('PC-D1 #projects-view renders content', loaded === 'ok', `loaded=${loaded}`);

      // Allow React to settle after the project-contacts fetch resolves.
      await new Promise(r => setTimeout(r, 2500));

      // Check for the "Unknown status" badge text rendered by ProjectsPage.tsx
      // when a contact has _statusUnknown: true.
      const projectsText = await page.evaluate(() => {
        const el = document.getElementById('projects-view');
        return el ? (el.textContent || '') : '';
      });

      const hasBadge = projectsText.includes('Unknown status');
      record('PC-D2 "Unknown status" badge text appears in #projects-view',
        hasBadge, `found=${hasBadge}`);

      await page.close();
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
    '# Project-Contacts Unknown-Status — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:project-contacts-unknown-status\``,
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
    '- **(PC-A/B) API — orphan-check surfaces unknown-status contact**: starts a',
    '  mock HubSpot server; `POST /crm/v3/objects/contacts/search` with',
    '  `filterGroups` (project-contacts IN-filter) returns only the known-status',
    '  contact; without `filterGroups` (`fetchAllContactsShared`) returns both.',
    '  After busting the project-contacts cache, `GET /api/project-contacts`',
    '  must include the synthetic contact (id not in IN-filter results, has',
    '  `measure_once_rooms`) with `_statusUnknown: true`.',
    '- **(PC-C) API — known-status contacts unaffected**: the contact returned',
    '  by the IN-filter must appear exactly once, without `_statusUnknown: true`.',
    '  Confirms the orphan-check skips contacts already in `allResults` (the',
    '  `returnedIdSet` guard).',
    '- **(PC-D) UI — amber badge**: Puppeteer navigates to `/projects` with a',
    '  client-side fetch override for `/api/project-contacts` that injects the',
    '  synthetic unknown-status contact. Asserts that `"Unknown status"` appears',
    '  in `#projects-view` after the React island renders.',
    '',
    '## Relevant files',
    '',
    '- `server.js` — `/api/project-contacts` orphan-check block (~lines 1597–1615)',
    '- `src/react/pages/ProjectsPage.tsx` — `_statusUnknown` amber badge + banner',
    '- `src/react/hooks/useProjectsData.ts` — `ProjectContact._statusUnknown` field',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
