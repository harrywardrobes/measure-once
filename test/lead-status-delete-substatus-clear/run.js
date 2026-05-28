'use strict';
// test/lead-status-delete-substatus-clear/run.js
//
// Focused integration test for clearOrphanedSubstatusesForDeletedStatus
// (server.js).  When a lead status is deleted via
// DELETE /api/admin/lead-statuses/:key, a background job must:
//
//   (A) Search + patch — POST /crm/v3/objects/contacts/search filtered by the
//       deleted key + HAS_PROPERTY hw_lead_substatus, then PATCH each matched
//       contact clearing hw_lead_substatus to "".
//
//   (B) Zero results — when the search returns no contacts, no PATCH is made.
//
//   (C) Search failure — when the search request errors, a 'search' failure
//       record is persisted in substatus_clear_failures and the admin can
//       retrieve it via GET /api/admin/substatus-clear-failures.
//
//   (D) PATCH failure — when the contact PATCH errors (after retries), a
//       'patch' failure record is persisted per affected contact. The manual
//       retry endpoint re-triggers the job.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:lead-status-delete-substatus-clear
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:lead-status-delete-substatus-clear

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');
const { pollFn } = require('../helpers/poll');

require('dotenv').config();

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'lead-status-delete-substatus-clear.md'
);

const LS_KEY_A = 'PRIVTEST_LSDSC_A';  // scenario A: contacts to clear
const LS_KEY_B = 'PRIVTEST_LSDSC_B';  // scenario B: no contacts
const LS_KEY_C = 'PRIVTEST_LSDSC_C';  // scenario C: search fails
const LS_KEY_D = 'PRIVTEST_LSDSC_D';  // scenario D: PATCH fails

const findings = [];
function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Mock HubSpot server ───────────────────────────────────────────────────────
//
// Supports configurable per-scenario search results and records every search
// and PATCH call so tests can assert what the server sent.
//
// Extra state flags:
//   state.searchShouldFail  — if true, /search returns 500
//   state.patchShouldFail   — if true, contact PATCH returns 500

function startMockHubspot() {
  const state = {
    searchResults:    [],    // contacts returned from next /search call
    calls:            [],    // { method, url, body, at }
    searchShouldFail: false, // scenario C: search returns 500
    patchShouldFail:  false, // scenario D: contact PATCH returns 500
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const method = req.method.toUpperCase();
      const url    = req.url;
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch {}

      state.calls.push({ method, url, body, at: Date.now() });

      // contacts search
      if (method === 'POST' && url.startsWith('/crm/v3/objects/contacts/search')) {
        if (state.searchShouldFail) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'mock search error' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          total:   state.searchResults.length,
          results: state.searchResults,
          paging:  undefined,
        }));
      }

      // contact PATCH (clear substatus)
      if (method === 'PATCH' && /^\/crm\/v3\/objects\/contacts\//.test(url)) {
        if (state.patchShouldFail) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'mock patch error' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: 'mock-id', properties: {} }));
      }

      // hs_lead_status property PATCH (from syncLeadStatusesToHubSpot)
      if (method === 'PATCH' && url.startsWith('/crm/v3/properties/contacts/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({}));
      }

      // anything else — accept silently
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, state });
    });
  });
}

// ── Poll helper ───────────────────────────────────────────────────────────────
// clearOrphanedSubstatusesForDeletedStatus is fire-and-forget; poll until the
// expected calls appear or the deadline passes.
// predicate may be sync or async.

const pollUntil = (predicate, timeoutMs = 5000, intervalMs = 100) =>
  pollFn(predicate, timeoutMs, intervalMs).then(Boolean);

// ── DB poll helper ────────────────────────────────────────────────────────────
// Poll substatus_clear_failures for an expected row, since the INSERT is async.

async function pollDbFailures(pool, { deletedKey, failureType, contactId }, timeoutMs = 5000) {
  return await pollFn(async () => {
    const q = contactId
      ? `SELECT * FROM substatus_clear_failures
           WHERE deleted_key = $1 AND failure_type = $2 AND contact_id = $3 AND resolved = FALSE`
      : `SELECT * FROM substatus_clear_failures
           WHERE deleted_key = $1 AND failure_type = $2 AND resolved = FALSE`;
    const params = contactId ? [deletedKey, failureType, contactId] : [deletedKey, failureType];
    const { rows } = await pool.query(q, params);
    return rows.length > 0 ? rows : null;
  }, timeoutMs, 100) ?? [];
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
  console.log(`\n  lead-status-delete-substatus-clear  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL'}`);

  const pool = new Pool({ connectionString: connStr });
  const mock = await startMockHubspot();
  console.log(`  mock HubSpot listening on http://127.0.0.1:${mock.port}`);

  process.env.HUBSPOT_API_URL                   = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_API_BASE_OVERRIDE         = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_ACCESS_TOKEN              = 'privtest-dummy-token';
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';

  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool, BASE,
  } = require('../privileges/harness');
  setPool(pool);

  const ALL_KEYS = [LS_KEY_A, LS_KEY_B, LS_KEY_C, LS_KEY_D];

  const cleanup = async () => {
    try { child.kill('SIGTERM'); } catch {}
    try {
      await pool.query(
        'DELETE FROM lead_status_config WHERE key = ANY($1::text[])',
        [ALL_KEYS],
      );
      await pool.query(
        'DELETE FROM substatus_clear_failures WHERE deleted_key = ANY($1::text[])',
        [ALL_KEYS],
      );
      await cleanupTestData(pool);
    } catch {}
    await pool.end().catch(() => {});
    try { mock.server.close(); } catch {}
  };
  process.on('SIGINT',  () => cleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => cleanup().then(() => process.exit(130)));

  await cleanupTestData(pool);
  await pool.query(
    'DELETE FROM lead_status_config WHERE key = ANY($1::text[])',
    [ALL_KEYS],
  );
  await pool.query(
    'DELETE FROM substatus_clear_failures WHERE deleted_key = ANY($1::text[])',
    [ALL_KEYS],
  ).catch(() => {});

  const users = await seedUsers(pool, runId);
  const { child, logBuf } = spawnServer();
  let exitCode = 1;

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  test server up at ${BASE}\n`);

    const admin = await login(users.admin.email, users.admin.password);

    // ── (A) Search + patch ────────────────────────────────────────────────────
    // Seed a lead-status row, configure mock to return two contacts matching
    // it, then DELETE the status and assert the background job searched with
    // the right filter and PATCHed both contacts.
    console.log('  [A] Search + patch: contacts with orphaned substatus are cleared');

    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
         VALUES ($1, 'PrivTest LSDSC A', 980, false)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label`,
      [LS_KEY_A],
    );

    const mockContactA1 = { id: 'privtest-lsdsc-contact-1', properties: { hs_lead_status: LS_KEY_A, hw_lead_substatus: 'SUB_OLD' } };
    const mockContactA2 = { id: 'privtest-lsdsc-contact-2', properties: { hs_lead_status: LS_KEY_A, hw_lead_substatus: 'SUB_OLD' } };
    mock.state.searchResults = [mockContactA1, mockContactA2];
    mock.state.searchShouldFail = false;
    mock.state.patchShouldFail = false;
    mock.state.calls = [];

    const delA = await admin.delete(`/api/admin/lead-statuses/${encodeURIComponent(LS_KEY_A)}`);
    record('A1 DELETE returns 200',
      delA.status === 200,
      `status=${delA.status} body=${(delA.text || '').slice(0, 120)}`);

    // Wait for fire-and-forget background job to complete its search + PATCHes.
    const searchArrived = await pollUntil(
      () => mock.state.calls.some(c => c.method === 'POST' && c.url.startsWith('/crm/v3/objects/contacts/search')),
    );
    record('A2 search was called',
      searchArrived,
      `arrived=${searchArrived}`);

    // Find the search call and check its filter body.
    const searchCall = mock.state.calls.find(
      c => c.method === 'POST' && c.url.startsWith('/crm/v3/objects/contacts/search')
    );
    const filters = searchCall?.body?.filterGroups?.[0]?.filters ?? [];
    const hasLeadStatusFilter = filters.some(
      f => f.propertyName === 'hs_lead_status' && f.operator === 'EQ' && f.value === LS_KEY_A
    );
    const hasSubstatusFilter = filters.some(
      f => f.propertyName === 'hw_lead_substatus' && f.operator === 'HAS_PROPERTY'
    );
    record('A3 search filtered by deleted key (EQ)',
      hasLeadStatusFilter,
      `filters=${JSON.stringify(filters)}`);
    record('A4 search filtered by HAS_PROPERTY hw_lead_substatus',
      hasSubstatusFilter,
      `filters=${JSON.stringify(filters)}`);

    // Wait for both PATCH calls.
    const patchesArrived = await pollUntil(
      () => {
        const patches = mock.state.calls.filter(
          c => c.method === 'PATCH' && /\/crm\/v3\/objects\/contacts\//.test(c.url)
        );
        return patches.length >= 2;
      },
    );
    const patches = mock.state.calls.filter(
      c => c.method === 'PATCH' && /\/crm\/v3\/objects\/contacts\//.test(c.url)
    );
    record('A5 PATCH issued for each matched contact (2)',
      patchesArrived && patches.length === 2,
      `patches=${patches.length}`);

    // Each PATCH body must clear hw_lead_substatus to "".
    const allClear = patches.every(p => p.body?.properties?.hw_lead_substatus === '');
    record('A6 each PATCH clears hw_lead_substatus to ""',
      allClear,
      `bodies=${JSON.stringify(patches.map(p => p.body?.properties))}`);

    // The PATCHed contact ids must match the two mock contacts.
    const patchedIds = new Set(patches.map(p => {
      const m = p.url.match(/\/crm\/v3\/objects\/contacts\/([^/?]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    }));
    const expectedIds = new Set([mockContactA1.id, mockContactA2.id]);
    const idsMatch = [...expectedIds].every(id => patchedIds.has(id));
    record('A7 PATCHed contact ids match search results',
      idsMatch,
      `patched=${[...patchedIds].join(',')} expected=${[...expectedIds].join(',')}`);

    // ── (B) Zero results — no PATCH ──────────────────────────────────────────
    // Seed a second status, configure mock to return empty results, DELETE it,
    // and assert no PATCH was issued.
    console.log('\n  [B] Zero results: no PATCH issued when search returns empty');

    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
         VALUES ($1, 'PrivTest LSDSC B', 981, false)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label`,
      [LS_KEY_B],
    );

    mock.state.searchResults = [];
    mock.state.searchShouldFail = false;
    mock.state.patchShouldFail = false;
    mock.state.calls = [];

    const delB = await admin.delete(`/api/admin/lead-statuses/${encodeURIComponent(LS_KEY_B)}`);
    record('B1 DELETE returns 200',
      delB.status === 200,
      `status=${delB.status} body=${(delB.text || '').slice(0, 120)}`);

    // Wait for the background job's search call.
    const searchArrivedB = await pollUntil(
      () => mock.state.calls.some(c => c.method === 'POST' && c.url.startsWith('/crm/v3/objects/contacts/search')),
    );
    record('B2 search was called',
      searchArrivedB,
      `arrived=${searchArrivedB}`);

    // Give the background job extra time to issue any unexpected PATCHes.
    await new Promise(r => setTimeout(r, 500));

    const patchesB = mock.state.calls.filter(
      c => c.method === 'PATCH' && /\/crm\/v3\/objects\/contacts\//.test(c.url)
    );
    record('B3 no PATCH issued when search returns zero contacts',
      patchesB.length === 0,
      `patches=${patchesB.length}`);

    // ── (C) Search failure — failure record persisted ─────────────────────────
    // Configure the mock to return 500 for the search, DELETE a status, and
    // assert that a 'search' failure row appears in substatus_clear_failures.
    // Also verify the admin API endpoint returns it.
    console.log('\n  [C] Search failure: failure record persisted and retrievable via API');

    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
         VALUES ($1, 'PrivTest LSDSC C', 982, false)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label`,
      [LS_KEY_C],
    );

    mock.state.searchResults = [];
    mock.state.searchShouldFail = true;
    mock.state.patchShouldFail = false;
    mock.state.calls = [];

    const delC = await admin.delete(`/api/admin/lead-statuses/${encodeURIComponent(LS_KEY_C)}`);
    record('C1 DELETE returns 200 even when background job will fail',
      delC.status === 200,
      `status=${delC.status} body=${(delC.text || '').slice(0, 120)}`);

    // Wait for the search call to arrive at the mock (it will fail).
    const searchArrivedC = await pollUntil(
      () => mock.state.calls.some(c => c.method === 'POST' && c.url.startsWith('/crm/v3/objects/contacts/search')),
      8000,
    );
    record('C2 search was attempted',
      searchArrivedC,
      `arrived=${searchArrivedC}`);

    // Wait for the failure record to be written to the DB (async after all retries).
    const failRowsC = await pollDbFailures(pool, { deletedKey: LS_KEY_C, failureType: 'search' }, 10000);
    record('C3 search failure persisted to substatus_clear_failures',
      failRowsC.length > 0,
      `rows=${failRowsC.length} first=${JSON.stringify(failRowsC[0] || null)}`);

    // Verify the admin API returns the failure record.
    const listC = await admin.get(`/api/admin/substatus-clear-failures?key=${encodeURIComponent(LS_KEY_C)}`);
    const listCBody = listC.json || {};
    const listCFailures = listCBody.failures || [];
    record('C4 GET /api/admin/substatus-clear-failures returns the failure',
      listC.status === 200 && listCFailures.some(f => f.deleted_key === LS_KEY_C && f.failure_type === 'search'),
      `status=${listC.status} count=${listCFailures.length}`);

    // Reset mock to normal mode.
    mock.state.searchShouldFail = false;

    // ── (D) PATCH failure — per-contact failure records persisted ─────────────
    // Configure the mock to return one matching contact but fail all PATCHes.
    // Assert that 'patch' failure rows are persisted for the affected contact,
    // and that the retry endpoint re-triggers the job (clears stale records
    // and runs the job again, this time successfully).
    console.log('\n  [D] PATCH failure: per-contact failure records persisted; retry endpoint works');

    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
         VALUES ($1, 'PrivTest LSDSC D', 983, false)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label`,
      [LS_KEY_D],
    );

    const mockContactD = { id: 'privtest-lsdsc-contact-d', properties: { hs_lead_status: LS_KEY_D, hw_lead_substatus: 'SUB_D' } };
    mock.state.searchResults = [mockContactD];
    mock.state.searchShouldFail = false;
    mock.state.patchShouldFail = true;
    mock.state.calls = [];

    const delD = await admin.delete(`/api/admin/lead-statuses/${encodeURIComponent(LS_KEY_D)}`);
    record('D1 DELETE returns 200 even when PATCH will fail',
      delD.status === 200,
      `status=${delD.status} body=${(delD.text || '').slice(0, 120)}`);

    // Wait for at least one PATCH attempt (it will fail).
    const patchAttemptedD = await pollUntil(
      () => mock.state.calls.some(c => c.method === 'PATCH' && /\/crm\/v3\/objects\/contacts\//.test(c.url)),
      8000,
    );
    record('D2 PATCH was attempted for the contact',
      patchAttemptedD,
      `attempted=${patchAttemptedD}`);

    // Wait for the patch failure record to be persisted (async after all retries exhaust).
    const failRowsD = await pollDbFailures(
      pool,
      { deletedKey: LS_KEY_D, failureType: 'patch', contactId: mockContactD.id },
      15000,
    );
    record('D3 patch failure persisted to substatus_clear_failures',
      failRowsD.length > 0,
      `rows=${failRowsD.length} first=${JSON.stringify(failRowsD[0] || null)}`);

    // Verify the admin API returns the patch failure.
    const listD = await admin.get(`/api/admin/substatus-clear-failures?key=${encodeURIComponent(LS_KEY_D)}`);
    const listDBody = listD.json || {};
    const listDFailures = listDBody.failures || [];
    record('D4 GET /api/admin/substatus-clear-failures returns the patch failure',
      listD.status === 200 && listDFailures.some(f => f.deleted_key === LS_KEY_D && f.failure_type === 'patch' && f.contact_id === mockContactD.id),
      `status=${listD.status} count=${listDFailures.length}`);

    // Fix the mock and retry — the retry endpoint should mark old failures resolved
    // and re-trigger the job successfully.
    mock.state.searchResults = [mockContactD];
    mock.state.patchShouldFail = false;
    mock.state.calls = [];

    const retryD = await admin.post('/api/admin/substatus-clear-failures/retry', { deletedKey: LS_KEY_D });
    record('D5 retry endpoint returns 200',
      retryD.status === 200,
      `status=${retryD.status} body=${(retryD.text || '').slice(0, 120)}`);

    // After retry, the old failure records for key D should be marked resolved.
    const resolvedD = await pollUntil(async () => {
      try {
        const { rows } = await pool.query(
          `SELECT * FROM substatus_clear_failures
             WHERE deleted_key = $1 AND failure_type = 'patch' AND resolved = FALSE`,
          [LS_KEY_D]
        );
        return rows.length === 0;
      } catch { return false; }
    }, 3000);
    record('D6 prior patch failures marked resolved after retry',
      resolvedD,
      `resolved=${resolvedD}`);

    // After retry the job should successfully PATCH the contact.
    const retryPatchArrived = await pollUntil(
      () => mock.state.calls.some(c => c.method === 'PATCH' && /\/crm\/v3\/objects\/contacts\//.test(c.url)),
      8000,
    );
    record('D7 retry re-triggers the clear job (PATCH observed)',
      retryPatchArrived,
      `arrived=${retryPatchArrived}`);

    const failed = findings.filter(f => !f.ok).length;
    exitCode = failed === 0 ? 0 : 1;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);
  } catch (e) {
    console.error('Test crashed:', e);
    console.error(logBuf.join('').slice(-3000));
  } finally {
    await writeReport(runId);
    await cleanup();
    process.exit(exitCode);
  }
}

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# Lead-Status Delete — Orphaned Substatus Clear — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:lead-status-delete-substatus-clear\``,
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
    '- **(A) Search + patch**: `DELETE /api/admin/lead-statuses/:key` with the mock',
    '  returning two contacts. Asserts the background job POSTed to',
    '  `/crm/v3/objects/contacts/search` with filters',
    '  `hs_lead_status EQ <key>` + `hw_lead_substatus HAS_PROPERTY`, then',
    '  issued a PATCH for each contact clearing `hw_lead_substatus` to `""`.',
    '- **(B) Zero results**: same DELETE path but mock returns an empty results',
    '  array. Asserts the search was called and no PATCH was issued.',
    '- **(C) Search failure**: mock returns 500 for the search. Asserts a',
    '  `failure_type=search` row is persisted in `substatus_clear_failures` and',
    '  that `GET /api/admin/substatus-clear-failures` returns it.',
    '- **(D) PATCH failure**: mock returns 500 for contact PATCHes. Asserts a',
    '  `failure_type=patch` row is persisted per contact. Then fixes the mock and',
    '  calls `POST /api/admin/substatus-clear-failures/retry` — asserts the prior',
    '  failures are marked resolved and the job re-runs successfully.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
