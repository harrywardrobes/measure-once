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

async function apiPost(path, cookie, body = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual',
  });
  return res.status;
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

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

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
