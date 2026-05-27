'use strict';
// test/invoice-admin-controls/run.js
//
// API privilege gate test confirming that all QuickBooks invoice endpoints
// require admin privilege:
//
//   - A manager-level user gets HTTP 403 on every QB invoice route.
//   - An unauthenticated request gets HTTP 401 / redirect.
//   - An admin user gets a non-403 response (200, 404, or QB-auth error
//     is all acceptable — what matters is the gate is not 403).
//
// Also verifies data-scoping on GET /api/quickbooks/invoices:
//
//   - When QB is disconnected (no tokens in DB) the response is a structured
//     error object and never exposes raw token fields.
//   - When a fake token is stored in the DB and the QB call fails, the error
//     response still does not expose token fields from the DB row.
//
// Routes tested (all require requireAdmin middleware in quickbooks.js):
//   GET  /api/quickbooks/invoices
//   GET  /api/quickbooks/invoice/:id
//   POST /api/quickbooks/invoice/:id
//   GET  /api/quickbooks/invoice/:id/pdf
//   POST /api/quickbooks/invoice/:id/send
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:invoice-admin-controls
//   PRIVTEST_ALLOW_SHARED_DB=1   npm run test:invoice-admin-controls

const fs   = require('fs');
const http = require('http');
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

require('dotenv').config();

// ── helpers ───────────────────────────────────────────────────────────────────

async function apiGet(path, cookie) {
  const headers = cookie ? { cookie } : {};
  const res = await fetch(`${BASE}${path}`, { headers, redirect: 'manual' });
  return res.status;
}

async function apiGetFull(path, cookie) {
  const headers = cookie ? { cookie } : {};
  const res = await fetch(`${BASE}${path}`, { headers, redirect: 'manual' });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function apiPost(path, cookie, body = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual',
  });
  return res.status;
}

const TOKEN_FIELDS = ['access_token', 'refresh_token', 'realm_id', 'expires_at'];

function bodyLeaksTokens(body) {
  if (!body || typeof body !== 'object') return false;
  const flat = JSON.stringify(body).toLowerCase();
  return TOKEN_FIELDS.some(f => flat.includes(`"${f}"`));
}

// ── Mock QuickBooks HTTP server ───────────────────────────────────────────────
// Responds to GET /v3/company/:realm/query with an empty invoice list.
// Records every request URL so tests can assert the realm_id was used.
function startMockQbServer() {
  const requests = [];

  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const u = new URL(req.url, `http://${req.headers.host}`);
    const isQuery = /^\/v3\/company\/[^/]+\/query$/.test(u.pathname);
    if (req.method === 'GET' && isQuery) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ QueryResponse: { Invoice: [] } }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path: u.pathname }));
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        requests,
        stop: () => new Promise(r => server.close(r)),
      });
    });
  });
}

// ── report ────────────────────────────────────────────────────────────────────

async function writeReport(findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# QB invoice API — privilege gate test',
    '',
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:invoice-admin-controls\``,
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
    '## What is tested',
    '',
    'Sends HTTP requests as manager, unauthenticated, and admin to all five',
    'QuickBooks invoice endpoints in quickbooks.js and asserts that:',
    '',
    '- Manager: every route returns 403.',
    '- Unauthenticated: every route returns 401 or a redirect (3xx).',
    '- Admin: every route returns something other than 403 (200, 404, or a',
    '  QB-not-connected error are all acceptable — the gate itself is what',
    '  is tested, not the QB backend behaviour).',
    '- QB disconnected (no tokens in DB): GET /api/quickbooks/invoices returns',
    '  HTTP 503 with body { error: string, code: "QB_ERROR" } and no raw token',
    '  field keys (access_token, refresh_token, realm_id, expires_at).',
    '- Mock QB connected (known realm_id stored as token): the endpoint routes',
    '  its QB API call to the realm_id from the stored token (org-scoping),',
    '  returns HTTP 200 with body.invoices as an array, and exposes no raw token',
    '  values or field keys in the response.',
    '',
    '## Relevant files',
    '',
    '- `quickbooks.js` — all five `requireAdmin`-gated invoice routes',
  ];
  const outPath = path.join(dir, 'invoice-admin-controls.md');
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log('  Report: test-results/invoice-admin-controls.md');
}

// ── main ──────────────────────────────────────────────────────────────────────

const FAKE_ID = 'test-inv-000';

const ROUTES = [
  { method: 'GET',  path: `/api/quickbooks/invoices` },
  { method: 'GET',  path: `/api/quickbooks/invoice/${FAKE_ID}` },
  { method: 'POST', path: `/api/quickbooks/invoice/${FAKE_ID}` },
  { method: 'GET',  path: `/api/quickbooks/invoice/${FAKE_ID}/pdf` },
  { method: 'POST', path: `/api/quickbooks/invoice/${FAKE_ID}/send` },
];

async function main() {
  console.log('\n  invoice-admin-controls  QB API privilege gate\n');

  const findings = [];
  function record(name, expected, observed, ok, detail = '') {
    findings.push({ name, expected, observed, ok, detail });
    const mark = ok ? '  ✓' : '  ✗';
    console.log(`${mark}  ${name}`);
    if (!ok) {
      console.log(`     expected : ${expected}`);
      console.log(`     observed : ${observed}`);
      if (detail) console.log(`     detail   : ${detail}`);
    }
  }

  // ── DB safety check ────────────────────────────────────────────────────────
  const dbUrl = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Set DATABASE_URL_TEST or DATABASE_URL before running.');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL_TEST && process.env.PRIVTEST_ALLOW_SHARED_DB !== '1') {
    console.error(
      '\n  ✘ Refuses to run against the shared DATABASE_URL by default.\n'
      + '    Set DATABASE_URL_TEST=<disposable> or PRIVTEST_ALLOW_SHARED_DB=1.\n',
    );
    process.exit(2);
  }

  const pool = new Pool({ connectionString: dbUrl });
  setPool(pool);

  const runId = `inv-${Date.now().toString(36)}`;
  await cleanupTestData(pool);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded  member=${users.member.email}  manager=${users.manager.email}  admin=${users.admin.email}`);

  // Start mock QB server BEFORE spawning the app so QB_API_BASE_OVERRIDE is
  // inherited by the child process and the app routes invoice API calls to our
  // local stub instead of the real QuickBooks endpoint.
  const mockQb = await startMockQbServer();
  process.env.QB_API_BASE_OVERRIDE = `http://127.0.0.1:${mockQb.port}`;
  console.log(`  Mock QB server on port ${mockQb.port}`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await mockQb.stop(); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  };

  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:', e);  cleanupAndExit(2); });
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

  try {
    // ── Authenticate actors ────────────────────────────────────────────────
    const [memberClient, managerClient, adminClient] = await Promise.all([
      login(users.member.email, users.member.password),
      login(users.manager.email, users.manager.password),
      login(users.admin.email, users.admin.password),
    ]);

    // ── Scenario A: unauthenticated → 401 or 3xx ─────────────────────────
    console.log('\n  [A] Unauthenticated requests');
    for (const route of ROUTES) {
      const status = route.method === 'POST'
        ? await apiPost(route.path, null)
        : await apiGet(route.path, null);
      const ok = status === 401 || (status >= 300 && status < 400);
      record(
        `UNAUTH: ${route.method} ${route.path} → 401 or 3xx`,
        '401 or 3xx',
        String(status),
        ok,
      );
    }

    // ── Scenario B: member → 403 ──────────────────────────────────────────
    console.log('\n  [B] Member requests');
    for (const route of ROUTES) {
      const status = route.method === 'POST'
        ? await apiPost(route.path, memberClient.cookie)
        : await apiGet(route.path, memberClient.cookie);
      record(
        `MEMBER: ${route.method} ${route.path} → 403`,
        '403',
        String(status),
        status === 403,
      );
    }

    // ── Scenario C: manager → 403 ─────────────────────────────────────────
    console.log('\n  [C] Manager requests');
    for (const route of ROUTES) {
      const status = route.method === 'POST'
        ? await apiPost(route.path, managerClient.cookie)
        : await apiGet(route.path, managerClient.cookie);
      record(
        `MANAGER: ${route.method} ${route.path} → 403`,
        '403',
        String(status),
        status === 403,
      );
    }

    // ── Scenario D: admin → not 403 ───────────────────────────────────────
    console.log('\n  [D] Admin requests (gate must pass — QB not connected is OK)');
    for (const route of ROUTES) {
      const status = route.method === 'POST'
        ? await apiPost(route.path, adminClient.cookie)
        : await apiGet(route.path, adminClient.cookie);
      const ok = status !== 403;
      record(
        `ADMIN: ${route.method} ${route.path} → not 403`,
        'not 403',
        String(status),
        ok,
      );
    }

    // ── Scenario E: QB disconnected — structured error, no token leak ──────
    // No qb_tokens row → the endpoint must return HTTP 503 with a structured
    // JSON error body carrying an "error" string and code "QB_ERROR". The
    // response must never expose any of the raw token column names.
    console.log('\n  [E] QB disconnected — response shape and token-field check');
    {
      await pool.query('DELETE FROM qb_tokens');

      const { status, body } = await apiGetFull('/api/quickbooks/invoices', adminClient.cookie);

      record(
        'QB_DISCONNECTED: GET /api/quickbooks/invoices → 503',
        '503',
        String(status),
        status === 503,
      );

      const isErrorShape =
        body !== null &&
        typeof body === 'object' &&
        typeof body.error === 'string' &&
        body.code === 'QB_ERROR';
      record(
        'QB_DISCONNECTED: GET /api/quickbooks/invoices → { error: string, code: "QB_ERROR" }',
        '{ error: string, code: "QB_ERROR" }',
        isErrorShape ? 'ok' : JSON.stringify(body),
        isErrorShape,
      );

      const leaks = bodyLeaksTokens(body);
      record(
        'QB_DISCONNECTED: GET /api/quickbooks/invoices → no token fields in body',
        'no token field keys',
        leaks
          ? `LEAKED: ${TOKEN_FIELDS.filter(f => JSON.stringify(body).includes(`"${f}"`)).join(', ')}`
          : 'clean',
        !leaks,
      );
    }

    // ── Scenario F: mock QB connected — org realm_id scoping + response shape
    // Store a token with a known realm_id in the DB. The app will call
    // GET /v3/company/<realm_id>/query on the mock QB server. The test then:
    //   (F1) asserts the mock received the request at the correct realm-scoped URL
    //   (F2) asserts the response is HTTP 200 with body.invoices as an array
    //   (F3) asserts the response body contains no raw token values
    //   (F4) asserts the response body contains no token field keys
    console.log('\n  [F] Mock QB connected — org realm_id scoping and response shape');
    {
      const REALM = 'PRIVTEST_REALM_INVOICE_SCOPING';
      const fakeAccessToken  = `fake-at-${Date.now()}`;
      const fakeRefreshToken = `fake-rt-${Date.now()}`;

      await pool.query('DELETE FROM qb_tokens');
      await pool.query(
        'INSERT INTO qb_tokens (access_token, refresh_token, realm_id, expires_at) VALUES ($1, $2, $3, $4)',
        [fakeAccessToken, fakeRefreshToken, REALM, Date.now() + 3600 * 1000],
      );
      mockQb.requests.length = 0;

      const { status, body } = await apiGetFull('/api/quickbooks/invoices', adminClient.cookie);

      // (F1) Org-scoping: the mock QB server must have received a request whose
      // URL path includes the stored realm_id — this proves the endpoint scopes
      // its QB API call to the authenticated org's realm, not a hardcoded one.
      const realmInUrl = mockQb.requests.some(u => u.includes(`/company/${REALM}/`));
      record(
        `QB_MOCK_CONNECTED: GET /api/quickbooks/invoices → QB request uses realm_id "${REALM}"`,
        `URL path includes /company/${REALM}/`,
        realmInUrl
          ? `ok — ${mockQb.requests.find(u => u.includes(REALM))}`
          : `not found in: ${JSON.stringify(mockQb.requests)}`,
        realmInUrl,
      );

      // (F2) Response shape: 200 with body.invoices as an array.
      record(
        'QB_MOCK_CONNECTED: GET /api/quickbooks/invoices → 200',
        '200',
        String(status),
        status === 200,
      );
      const hasInvoicesArray = status === 200 && Array.isArray(body?.invoices);
      record(
        'QB_MOCK_CONNECTED: GET /api/quickbooks/invoices → body.invoices is an array',
        'Array.isArray(body.invoices)',
        hasInvoicesArray ? 'ok' : JSON.stringify(body),
        hasInvoicesArray,
      );

      // (F3) Raw token values must not appear in the response body.
      const bodyStr = JSON.stringify(body || {});
      const leaksRaw = bodyStr.includes(fakeAccessToken) || bodyStr.includes(fakeRefreshToken);
      record(
        'QB_MOCK_CONNECTED: GET /api/quickbooks/invoices → raw token values not in body',
        'no raw token values',
        leaksRaw ? 'LEAKED raw token value(s)' : 'clean',
        !leaksRaw,
      );

      // (F4) Token field keys must not appear in the response body.
      const leaksFields = bodyLeaksTokens(body);
      record(
        'QB_MOCK_CONNECTED: GET /api/quickbooks/invoices → no token field keys in body',
        'no token field keys',
        leaksFields
          ? `LEAKED: ${TOKEN_FIELDS.filter(f => bodyStr.includes(`"${f}"`)).join(', ')}`
          : 'clean',
        !leaksFields,
      );

      await pool.query('DELETE FROM qb_tokens');
    }

  } catch (e) {
    record('test harness', 'no error', `error: ${e.message}`, false,
      (logBuf || []).slice(-20).join(''));
  }

  const pass = findings.filter(f => f.ok).length;
  const fail = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${pass} passed, ${fail} failed`);
  await writeReport(findings);
  await cleanupAndExit(fail > 0 ? 1 : 0);
}

main();
