'use strict';

const PROBE_LABELS = [
  '(A) priority sort hides contacts older than 60 days',
  '(B) priority sort + search returns contacts older than 60 days',
  '(C) non-priority sort is unaffected by the age filter',
];

// test/contacts-priority-active/run.js
//
// Integration test for the priority-active filter on GET /api/contacts-all.
//
//   (A) Priority sort, no search: contacts whose `lastmodifieddate` is more
//       than 60 days in the past are excluded.  total and totalPages reflect
//       the post-filter count.
//
//   (B) Priority sort + non-empty search query: the age filter is bypassed —
//       both a recent and a stale contact that match the query are returned.
//
//   (C) Non-priority sorts (newest, name-asc, name-desc): all contacts are
//       returned regardless of lastmodifieddate (no age filter applied).
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:contacts-priority-active
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:contacts-priority-active

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'contacts-priority-active.md');
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
// The active-filter cutoff is Date.now() - 60 days.
// "Recent" = modified 10 days ago (within window).
// "Stale"  = modified 90 days ago (outside window).

const DAYS = 24 * 60 * 60 * 1000;
const NOW  = Date.now();
const recentDate = new Date(NOW - 10 * DAYS).toISOString();
const staleDate  = new Date(NOW - 90 * DAYS).toISOString();

const RECENT_CONTACT = {
  id: '501',
  properties: {
    firstname:        'Recent',
    lastname:         'Active',
    email:            'recent@example.com',
    phone:            '555-0501',
    hs_lead_status:   'OPEN_DEAL',
    createdate:       recentDate,
    lastmodifieddate: recentDate,
  },
};

const STALE_CONTACT = {
  id: '502',
  properties: {
    firstname:        'Stale',
    lastname:         'Inactive',
    email:            'stale@example.com',
    phone:            '555-0502',
    hs_lead_status:   'OPEN_DEAL',
    createdate:       staleDate,
    lastmodifieddate: staleDate,
  },
};

const CONTACTS_SEARCH_RESPONSE = {
  results: [RECENT_CONTACT, STALE_CONTACT],
  paging: null,
};

// ── Mock HubSpot server ────────────────────────────────────────────────────────
function startMockHubspot() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const url = req.url.split('?')[0];

      if (url === '/crm/v3/objects/contacts/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(CONTACTS_SEARCH_RESPONSE));
      }

      if (req.method === 'GET' && url.startsWith('/crm/v3/properties/contacts/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ name: 'hw_test_user', type: 'bool' }));
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

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function httpGet(base, urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const req = http.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: cookie ? { Cookie: cookie } : {},
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(base, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const bodyStr = JSON.stringify(body);
    const req = http.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function waitForServer(base, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await httpGet(base, '/api/turnstile-config', null);
      if (r.status === 200) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Test server did not start on ${base} within ${timeoutMs}ms`);
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
  console.log(`\n  contacts-priority-active  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL'}`);

  const pool = new Pool({ connectionString: connStr });
  const mock = await startMockHubspot();
  console.log(`  mock HubSpot listening on http://127.0.0.1:${mock.port}`);

  process.env.HUBSPOT_API_URL                   = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_ACCESS_TOKEN              = 'privtest-dummy-token';
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';
  process.env.PRIVTEST_USE_HUBSPOT_API_URL      = '1';

  const {
    spawnServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool, BASE, PASSWORD,
  } = require('../privileges/harness');
  setPool(pool);

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);

  const { child, logBuf } = spawnServer();
  let exitCode = 1;

  const cleanup = async () => {
    try { child.kill('SIGTERM'); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    try { mock.server.close(); } catch {}
  };
  process.on('SIGINT',  () => cleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => cleanup().then(() => process.exit(130)));

  try {
    await waitForServer(BASE);
    await resetRateLimitStore(pool);
    console.log(`  test server up at ${BASE}\n`);

    const memberClient = await login(users.member.email, PASSWORD);
    const adminClient  = await login(users.admin.email,  PASSWORD);
    const memberCookie = memberClient.cookie;
    const adminCookie  = adminClient.cookie;

    // Ensure dev mode is off so the hw_test_user filter does not interfere.
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('dev_mode_enabled', 'false')
       ON CONFLICT (key) DO UPDATE SET value = 'false'`,
    );

    // Bust the contacts cache so every GET fetches fresh from mock HubSpot.
    await httpPost(BASE, '/api/admin/test/bust-contacts-cache', {}, adminCookie);

    // ── (A) Priority sort, no search — stale contacts hidden ─────────────────
    console.log('  [A] priority sort, no search — contacts older than 60 days hidden');

    const aRes = await httpGet(
      BASE,
      '/api/contacts-all?priorityFirst=1',
      memberCookie,
    );
    const aIds = (aRes.json?.results || []).map(c => c.id);

    record('A.1 contacts-all returns 200',
      aRes.status === 200,
      `status=${aRes.status}`);
    record('A.2 recent contact is present',
      aIds.includes(RECENT_CONTACT.id),
      `ids=${JSON.stringify(aIds)}`);
    record(PROBE_LABELS[0],
      !aIds.includes(STALE_CONTACT.id),
      `ids=${JSON.stringify(aIds)} total=${aRes.json?.total}`);
    record('A.4 total reflects post-filter count (1 not 2)',
      aRes.json?.total === 1,
      `total=${aRes.json?.total}`);

    // Bust cache before next test to ensure fresh mock data.
    await httpPost(BASE, '/api/admin/test/bust-contacts-cache', {}, adminCookie);

    // ── (B) Priority sort + search — age filter bypassed ─────────────────────
    console.log('\n  [B] priority sort + search — age filter bypassed');

    const bRes = await httpGet(
      BASE,
      '/api/contacts-all?priorityFirst=1&q=stale',
      memberCookie,
    );
    const bIds = (bRes.json?.results || []).map(c => c.id);

    record('B.1 contacts-all returns 200',
      bRes.status === 200,
      `status=${bRes.status}`);
    record(PROBE_LABELS[1],
      bIds.includes(STALE_CONTACT.id),
      `ids=${JSON.stringify(bIds)} total=${bRes.json?.total}`);

    // Bust cache before next test.
    await httpPost(BASE, '/api/admin/test/bust-contacts-cache', {}, adminCookie);

    // ── (C) Non-priority sorts — no age filter applied ────────────────────────
    console.log('\n  [C] non-priority sorts — all contacts returned regardless of age');

    for (const sort of ['newest', 'name-asc', 'name-desc']) {
      await httpPost(BASE, '/api/admin/test/bust-contacts-cache', {}, adminCookie);

      const cRes = await httpGet(
        BASE,
        `/api/contacts-all?sort=${sort}`,
        memberCookie,
      );
      const cIds = (cRes.json?.results || []).map(c => c.id);

      record(`C.${sort} recent contact present`,
        cIds.includes(RECENT_CONTACT.id),
        `sort=${sort} ids=${JSON.stringify(cIds)}`);
      record(`C.${sort} stale contact present (no age filter)`,
        cIds.includes(STALE_CONTACT.id),
        `sort=${sort} ids=${JSON.stringify(cIds)}`);
    }

    // Mark C probe label passed if all sub-checks above passed.
    const cFailed = findings.filter(f => f.id.startsWith('C.') && !f.ok).length;
    record(PROBE_LABELS[2],
      cFailed === 0,
      `sub-failures=${cFailed}`);

    const failed = findings.filter(f => !f.ok).length;
    exitCode = failed === 0 ? 0 : 1;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);
  } catch (e) {
    console.error('Test crashed:', e);
    console.error('--- server log (last 2000 chars) ---');
    console.error(logBuf.join('').slice(-2000));
  } finally {
    await writeReport(runId);
    await cleanup();
    process.exit(exitCode);
  }
}

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Contacts Priority-Active Filter — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:contacts-priority-active\``,
    '',
    '## Summary',
    '',
    `- Passed: ${findings.filter(f => f.ok).length} / ${findings.length}`,
    `- Failed: ${findings.filter(f => !f.ok).length} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Detail |',
    '|---|---|---|',
    ...findings.map(f => `| ${f.ok ? 'PASS' : 'FAIL'} | ${esc(f.id)} | ${esc(f.detail)} |`),
    '',
    '## Coverage',
    '',
    '- **(A) Priority sort, no search**: `GET /api/contacts-all?priorityFirst=1`',
    '  with two contacts — one modified 10 days ago, one 90 days ago.',
    '  Asserts only the recent contact is returned and `total` equals 1.',
    '- **(B) Priority sort + search**: `GET /api/contacts-all?priorityFirst=1&q=stale`',
    '  bypasses the age filter so the stale contact is returned despite being',
    '  outside the 60-day window.',
    '- **(C) Non-priority sorts** (`newest`, `name-asc`, `name-desc`): both',
    '  contacts are returned on each sort, confirming the age filter is not',
    '  applied outside "Priority first" mode.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
