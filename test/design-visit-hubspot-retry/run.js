'use strict';
// test/design-visit-hubspot-retry/run.js
//
// Focused integration test confirming that dvHubspotRequestWithRetry (in
// design-visits.js) and hubspotRequestWithRetry (in server.js) recover from
// a transient HubSpot 429 in the design-visit submission and localdata pipelines,
// and that a permanently-failing HubSpot notes or lead-status endpoint does not
// prevent the visit row from reaching `submitted` status.
//
//   (DV1) design-visit note creation retry — POST /api/design-visits/:id/submit:
//         first attempt to POST /crm/v3/objects/notes returns 429 + Retry-After: 0;
//         retry succeeds → endpoint returns 200.
//
//   (DV2) design-visit lead status update retry — POST /api/design-visits/:id/submit
//         with handlerConfig.submittedLeadStatus set: first PATCH to
//         /crm/v3/objects/contacts/:id returns 429; retry succeeds → endpoint
//         returns 200.
//
//   (DV3) design-visit note permanent failure — POST /api/design-visits/:id/submit
//         with /crm/v3/objects/notes always returning 500 on every attempt.
//         The submission still returns 200, the DB row reaches `submitted`, and
//         no uncaught exception surfaces to the client.
//
//   (DV4) design-visit lead-status permanent failure — POST /api/design-visits/:id/submit
//         with handlerConfig.submittedLeadStatus set and PATCH /crm/v3/objects/contacts/:id
//         always returning 500. All 4 retry attempts are exhausted; the outer non-fatal
//         try/catch in runSubmitSideEffects swallows the error. The endpoint still returns
//         200 and the DB row reaches `submitted` status.
//
//   (LD) localdata PATCH retry — POST /api/contacts/:id/localdata: first PATCH
//        to /crm/v3/objects/contacts/:id returns 429; retry succeeds → endpoint
//        returns 200 (not 502 HUBSPOT_RATE_LIMIT).
//
//   (LD2) localdata PATCH permanent failure — POST /api/contacts/:id/localdata
//         with PATCH /crm/v3/objects/contacts/:id always returning 500. All 4
//         retry attempts are exhausted; the inner non-fatal try/catch swallows the
//         error. The endpoint still returns 200 and does not surface the failure.
//
//   (RA1) room-assignments fitter PATCH retry — PATCH /api/contacts/:id/rooms/:roomIdx/fitter:
//         first PATCH to /crm/v3/objects/contacts/:id returns 429; retry succeeds →
//         endpoint returns 200.
//
//   (RA2) room-assignments fitter PATCH permanent failure — PATCH /api/contacts/:id/rooms/:roomIdx/fitter
//         with PATCH /crm/v3/objects/contacts/:id always returning 500. All 4 retry
//         attempts are exhausted; the inner non-fatal try/catch swallows the error.
//         The endpoint still returns 200 and no uncaught exception surfaces to the client.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:design-visit-hubspot-retry
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:design-visit-hubspot-retry

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');
const { pollFn } = require('../helpers/poll');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'design-visit-hubspot-retry.md');
const CONTACT_ID  = 'privtest-dv-hs-retry-contact';
const findings    = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Method-aware mock HubSpot server ─────────────────────────────────────────
//
// Rules are keyed by either "<METHOD>:<url-prefix>" (method-specific) or
// "<url-prefix>" (method-agnostic). Method-specific rules take precedence over
// method-agnostic rules of equal prefix length.
//
// In 'retryOnce' mode the first matching hit returns 429 + Retry-After: 0
// (zero delay so tests stay fast); subsequent hits return successBody with 200.
// 'ok' mode always returns 200.

function startMockHubspot() {
  const rules = {};  // key → { mode, hits, successBody }
  const calls = [];  // { method, url, status, at }

  function configEndpoint(urlPrefix, mode, successBody, method) {
    const key = method ? `${method.toUpperCase()}:${urlPrefix}` : urlPrefix;
    rules[key] = { mode, hits: 0, successBody };
  }

  function resetHits() {
    for (const r of Object.values(rules)) r.hits = 0;
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const method  = req.method.toUpperCase();
      const url     = req.url.split('?')[0];

      // Match: prefer method-specific rule over method-agnostic; within each
      // group prefer the longest matching prefix.
      let matched        = null;
      let matchedKey     = null;
      let matchedSpecific = false;

      for (const key of Object.keys(rules)) {
        const colonIdx = key.indexOf(':');
        const hasMethod = colonIdx !== -1
          && colonIdx <= 7   // method names are ≤7 chars (DELETE)
          && /^[A-Z]+$/.test(key.slice(0, colonIdx));

        let ruleMethod = null;
        let prefix;
        if (hasMethod) {
          ruleMethod = key.slice(0, colonIdx);
          prefix     = key.slice(colonIdx + 1);
        } else {
          prefix = key;
        }

        if (!url.startsWith(prefix)) continue;
        if (ruleMethod && ruleMethod !== method) continue;

        const specific = !!ruleMethod;
        const better   =
          !matched ||
          (specific && !matchedSpecific) ||
          (specific === matchedSpecific && prefix.length > matched.length);

        if (better) {
          matched         = prefix;
          matchedKey      = key;
          matchedSpecific = specific;
        }
      }

      if (!matchedKey) {
        calls.push({ method, url, status: 404, at: Date.now() });
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', message: `no mock for ${method} ${url}` }));
      }

      const rule = rules[matchedKey];
      rule.hits++;

      if (rule.mode === 'retryOnce' && rule.hits === 1) {
        calls.push({ method, url, status: 429, at: Date.now() });
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        return res.end(JSON.stringify({ status: 'error', message: 'rate limited' }));
      }

      if (rule.mode === 'alwaysFail') {
        calls.push({ method, url, status: 500, at: Date.now() });
        res.writeHead(500, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        return res.end(JSON.stringify({ status: 'error', message: 'internal server error' }));
      }

      calls.push({ method, url, status: 200, at: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rule.successBody));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, calls, configEndpoint, resetHits });
    });
  });
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function waitForTable(pool, table, timeoutMs = 15000) {
  const found = await pollFn(async () => {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1`,
      [table]
    );
    return r.rowCount || null;
  }, timeoutMs, 200);
  if (!found) throw new Error(`Table ${table} did not appear within ${timeoutMs}ms`);
}

async function seedVisit(pool, runId) {
  await pool.query(`
    INSERT INTO design_visits
      (contact_id, contact_name, contact_email, created_by,
       visit_date, duration_min, location, notes, terms_accepted, status)
    VALUES ($1, 'PrivTest Retry Contact', 'privtest-dv-retry@example.com',
            $2, NOW(), 90, 'Test location', 'test note', TRUE, 'revision_requested')
  `, [CONTACT_ID, `privtest-dv-retry-${runId}@privtest.local`]);

  const r = await pool.query(
    `SELECT id FROM design_visits WHERE created_by = $1`,
    [`privtest-dv-retry-${runId}@privtest.local`]
  );
  const visitId = r.rows[0].id;

  await pool.query(`
    INSERT INTO design_visit_rooms
      (design_visit_id, room_name, unit_count, unit_price_pence, sort_order)
    VALUES ($1, 'Kitchen', 2, 50000, 0)
  `, [visitId]);

  return visitId;
}

async function resetVisit(pool, visitId) {
  await pool.query(
    `UPDATE design_visits
        SET status = 'revision_requested', updated_at = NOW()
      WHERE id = $1`,
    [visitId]
  );
}

async function cleanupVisits(pool, runId) {
  await pool.query(
    `DELETE FROM design_visits WHERE created_by LIKE 'privtest-dv-retry-%'`
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

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
  console.log(`\n  design-visit-hubspot-retry  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL'}`);

  const pool = new Pool({ connectionString: connStr });
  const mock = await startMockHubspot();
  console.log(`  mock HubSpot listening on http://127.0.0.1:${mock.port}`);

  // Both server.js (HS = process.env.HUBSPOT_API_URL) and design-visits.js
  // (hubspotApiBase() = process.env.HUBSPOT_API_BASE_OVERRIDE) must point to
  // the same mock server.  Set BEFORE requiring the harness so spawnServer
  // inherits these via ...process.env.
  process.env.HUBSPOT_API_URL                   = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_API_BASE_OVERRIDE         = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_ACCESS_TOKEN              = 'privtest-dummy-token';
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';

  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool,
  } = require('../privileges/harness');
  setPool(pool);

  await cleanupTestData(pool);

  const { child, logBuf } = spawnServer();
  let exitCode = 1;

  const cleanup = async () => {
    try { child.kill('SIGTERM'); } catch {}
    try { await cleanupVisits(pool, runId); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    try { mock.server.close(); } catch {}
  };
  process.on('SIGINT',  () => cleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => cleanup().then(() => process.exit(130)));

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log('  test server up\n');

    // Wait for design_visits table (created asynchronously on server boot)
    await waitForTable(pool, 'design_visits');

    const users   = await seedUsers(pool, runId);
    const client  = await login(users.member.email, users.member.password);
    const manager = await login(users.manager.email, users.manager.password);

    const visitId = await seedVisit(pool, runId);

    // ── (DV1) design-visit note creation: POST /crm/v3/objects/notes → 429 retry
    console.log('  [DV1] design-visit note POST: 429 → retry → success');
    mock.configEndpoint('/crm/v3/objects/contacts/', 'ok',
      { id: CONTACT_ID, properties: {} });
    mock.configEndpoint('/crm/v3/objects/notes', 'retryOnce',
      { id: 'note-mock-1', properties: {} });
    mock.calls.length = 0;

    const dv1 = await client.post(`/api/design-visits/${visitId}/submit`, {});

    const dv1NoteCalls = mock.calls.filter(c => c.url.startsWith('/crm/v3/objects/notes'));
    record('DV1.1 submit returns 200',
      dv1.status === 200,
      `status=${dv1.status} body=${dv1.text.slice(0, 120)}`);
    record('DV1.2 notes endpoint called twice (429 + retry)',
      dv1NoteCalls.length === 2,
      `calls=${dv1NoteCalls.length} statuses=${dv1NoteCalls.map(c => c.status).join(',')}`);
    record('DV1.3 first notes call was 429',
      dv1NoteCalls[0]?.status === 429,
      `first status=${dv1NoteCalls[0]?.status}`);
    record('DV1.4 second notes call succeeded (200)',
      dv1NoteCalls[1]?.status === 200,
      `second status=${dv1NoteCalls[1]?.status}`);

    // ── (DV2) design-visit lead status: PATCH /crm/v3/objects/contacts/:id → 429 retry
    // Use method-specific rules so the GET for existing contacts (issued by
    // the stage-guard in POST /api/contacts/:id/localdata and any server-side
    // contact fetch) returns 200 immediately while only the PATCH uses retryOnce.
    console.log('\n  [DV2] design-visit lead status PATCH: 429 → retry → success');
    await resetVisit(pool, visitId);
    mock.resetHits();
    mock.calls.length = 0;

    mock.configEndpoint('/crm/v3/objects/contacts/', 'ok',
      { id: CONTACT_ID, properties: {} }, 'GET');
    mock.configEndpoint('/crm/v3/objects/contacts/', 'retryOnce',
      { id: CONTACT_ID, properties: {} }, 'PATCH');
    mock.configEndpoint('/crm/v3/objects/notes', 'ok',
      { id: 'note-mock-2', properties: {} });

    const dv2 = await manager.post(`/api/design-visits/${visitId}/submit`, {
      handlerConfig: { submittedLeadStatus: 'PRIVTEST_LEAD_STATUS' },
    });

    const dv2ContactPatches = mock.calls.filter(
      c => c.url.startsWith('/crm/v3/objects/contacts/') && c.method === 'PATCH'
    );
    record('DV2.1 submit returns 200',
      dv2.status === 200,
      `status=${dv2.status} body=${dv2.text.slice(0, 120)}`);
    record('DV2.2 contacts PATCH called twice (429 + retry)',
      dv2ContactPatches.length === 2,
      `calls=${dv2ContactPatches.length} statuses=${dv2ContactPatches.map(c => c.status).join(',')}`);
    record('DV2.3 first contacts PATCH was 429',
      dv2ContactPatches[0]?.status === 429,
      `first status=${dv2ContactPatches[0]?.status}`);
    record('DV2.4 second contacts PATCH succeeded (200)',
      dv2ContactPatches[1]?.status === 200,
      `second status=${dv2ContactPatches[1]?.status}`);

    // ── (DV3) design-visit note permanent failure: POST /crm/v3/objects/notes always 500
    // dvHubspotRequestWithRetry exhausts all maxAttempts (4), then the outer
    // try/catch in runSubmitSideEffects swallows the error. The submission
    // endpoint must still return 200 and the DB row must reach `submitted`.
    console.log('\n  [DV3] design-visit note POST: permanent 500 → submission still succeeds');
    await resetVisit(pool, visitId);
    mock.resetHits();
    mock.calls.length = 0;

    mock.configEndpoint('/crm/v3/objects/contacts/', 'ok',
      { id: CONTACT_ID, properties: {} });
    mock.configEndpoint('/crm/v3/objects/notes', 'alwaysFail', null, 'POST');

    const dv3 = await client.post(`/api/design-visits/${visitId}/submit`, {});

    const dv3NoteCalls = mock.calls.filter(c => c.url.startsWith('/crm/v3/objects/notes'));
    const dv3Row = await pool.query(
      `SELECT status FROM design_visits WHERE id = $1`, [visitId]
    );

    record('DV3.1 submit returns 200 despite note failure',
      dv3.status === 200,
      `status=${dv3.status} body=${dv3.text.slice(0, 120)}`);
    record('DV3.2 DB row is submitted',
      dv3Row.rows[0]?.status === 'submitted',
      `db_status=${dv3Row.rows[0]?.status}`);
    record('DV3.3 notes endpoint exhausted all 4 attempts',
      dv3NoteCalls.length === 4,
      `calls=${dv3NoteCalls.length} statuses=${dv3NoteCalls.map(c => c.status).join(',')}`);
    record('DV3.4 all note attempts returned 500',
      dv3NoteCalls.every(c => c.status === 500),
      `statuses=${dv3NoteCalls.map(c => c.status).join(',')}`);

    // ── (DV4) design-visit lead-status permanent failure: PATCH /crm/v3/objects/contacts/:id always 500
    // dvHubspotRequestWithRetry exhausts all maxAttempts (4), then the outer
    // try/catch in runSubmitSideEffects swallows the error. The submission
    // endpoint must still return 200 and the DB row must reach `submitted`.
    console.log('\n  [DV4] design-visit lead status PATCH: permanent 500 → submission still succeeds');
    await resetVisit(pool, visitId);
    mock.resetHits();
    mock.calls.length = 0;

    mock.configEndpoint('/crm/v3/objects/contacts/', 'alwaysFail', null, 'PATCH');
    mock.configEndpoint('/crm/v3/objects/notes', 'ok',
      { id: 'note-mock-4', properties: {} });

    const dv4 = await manager.post(`/api/design-visits/${visitId}/submit`, {
      handlerConfig: { submittedLeadStatus: 'PRIVTEST_LEAD_STATUS' },
    });

    const dv4ContactPatches = mock.calls.filter(
      c => c.url.startsWith('/crm/v3/objects/contacts/') && c.method === 'PATCH'
    );
    const dv4Row = await pool.query(
      `SELECT status FROM design_visits WHERE id = $1`, [visitId]
    );

    record('DV4.1 submit returns 200 despite lead-status failure',
      dv4.status === 200,
      `status=${dv4.status} body=${dv4.text.slice(0, 120)}`);
    record('DV4.2 DB row is submitted',
      dv4Row.rows[0]?.status === 'submitted',
      `db_status=${dv4Row.rows[0]?.status}`);
    record('DV4.3 contacts PATCH exhausted all 4 attempts',
      dv4ContactPatches.length === 4,
      `calls=${dv4ContactPatches.length} statuses=${dv4ContactPatches.map(c => c.status).join(',')}`);
    record('DV4.4 all lead-status attempts returned 500',
      dv4ContactPatches.every(c => c.status === 500),
      `statuses=${dv4ContactPatches.map(c => c.status).join(',')}`);

    // ── (LD) localdata PATCH: PATCH /crm/v3/objects/contacts/:id → 429 retry
    // POST /api/contacts/:id/localdata first issues a GET (inside a try/catch
    // that swallows errors, so 200 is fine) then issues the rooms PATCH via
    // hubspotRequestWithRetry.  Method-specific rules let us configure each
    // independently so the 429 fires only on the PATCH.
    console.log('\n  [LD] localdata PATCH: 429 → retry → success');
    mock.resetHits();
    mock.calls.length = 0;

    mock.configEndpoint('/crm/v3/objects/contacts/', 'ok',
      { id: CONTACT_ID, properties: { measure_once_rooms: null } }, 'GET');
    mock.configEndpoint('/crm/v3/objects/contacts/', 'retryOnce',
      { id: CONTACT_ID, properties: {} }, 'PATCH');

    const ld = await client.post(`/api/contacts/${CONTACT_ID}/localdata`, {
      rooms:    [{ room: 'Main', stageKey: 'sales' }],
      notes:    '',
      stage:    '',
      substage: '',
    });

    const ldContactPatches = mock.calls.filter(
      c => c.url.startsWith('/crm/v3/objects/contacts/') && c.method === 'PATCH'
    );
    record('LD.1 localdata returns 200 (not 502)',
      ld.status === 200,
      `status=${ld.status} body=${ld.text.slice(0, 120)}`);
    record('LD.2 contacts PATCH called twice (429 + retry)',
      ldContactPatches.length === 2,
      `calls=${ldContactPatches.length} statuses=${ldContactPatches.map(c => c.status).join(',')}`);
    record('LD.3 first contacts PATCH was 429',
      ldContactPatches[0]?.status === 429,
      `first status=${ldContactPatches[0]?.status}`);
    record('LD.4 second contacts PATCH succeeded (200)',
      ldContactPatches[1]?.status === 200,
      `second status=${ldContactPatches[1]?.status}`);

    // ── (LD2) localdata PATCH permanent failure: PATCH /crm/v3/objects/contacts/:id always 500
    // hubspotRequestWithRetry exhausts all maxAttempts (4), then the inner
    // non-fatal try/catch in POST /api/contacts/:id/localdata swallows the
    // error. The endpoint must still return 200 and not surface the failure.
    console.log('\n  [LD2] localdata PATCH: permanent 500 → endpoint still returns 200');
    mock.resetHits();
    mock.calls.length = 0;

    mock.configEndpoint('/crm/v3/objects/contacts/', 'ok',
      { id: CONTACT_ID, properties: { measure_once_rooms: null } }, 'GET');
    mock.configEndpoint('/crm/v3/objects/contacts/', 'alwaysFail', null, 'PATCH');

    const ld2 = await client.post(`/api/contacts/${CONTACT_ID}/localdata`, {
      rooms:    [{ room: 'Main', stageKey: 'sales' }],
      notes:    '',
      stage:    '',
      substage: '',
    });

    const ld2ContactPatches = mock.calls.filter(
      c => c.url.startsWith('/crm/v3/objects/contacts/') && c.method === 'PATCH'
    );
    record('LD2.1 localdata returns 200 despite permanent PATCH failure',
      ld2.status === 200,
      `status=${ld2.status} body=${ld2.text.slice(0, 120)}`);
    record('LD2.2 contacts PATCH exhausted all 4 attempts',
      ld2ContactPatches.length === 4,
      `calls=${ld2ContactPatches.length} statuses=${ld2ContactPatches.map(c => c.status).join(',')}`);
    record('LD2.3 all PATCH attempts returned 500',
      ld2ContactPatches.every(c => c.status === 500),
      `statuses=${ld2ContactPatches.map(c => c.status).join(',')}`);

    // ── (RA1) room-assignments fitter PATCH retry: PATCH /crm/v3/objects/contacts/:id → 429 retry
    // PATCH /api/contacts/:id/rooms/:roomIdx/fitter issues a GET (plain axios) to
    // fetch current rooms, then uses hubspotRequestWithRetry for the PATCH.
    // Method-specific rules let us fire 429 only on PATCH while GET returns 200.
    console.log('\n  [RA1] room-assignments fitter PATCH: 429 → retry → success');
    mock.resetHits();
    mock.calls.length = 0;

    const RA_ROOMS = JSON.stringify([
      { room: 'Kitchen', stageKey: 'sales', assignedFitterId: null },
    ]);
    mock.configEndpoint('/crm/v3/objects/contacts/', 'ok',
      { id: CONTACT_ID, properties: { measure_once_rooms: RA_ROOMS } }, 'GET');
    mock.configEndpoint('/crm/v3/objects/contacts/', 'retryOnce',
      { id: CONTACT_ID, properties: {} }, 'PATCH');

    const ra1 = await manager.patch(
      `/api/contacts/${CONTACT_ID}/rooms/0/fitter`, { fitterId: null }
    );

    const ra1ContactPatches = mock.calls.filter(
      c => c.url.startsWith('/crm/v3/objects/contacts/') && c.method === 'PATCH'
    );
    record('RA1.1 fitter PATCH returns 200',
      ra1.status === 200,
      `status=${ra1.status} body=${ra1.text.slice(0, 120)}`);
    record('RA1.2 contacts PATCH called twice (429 + retry)',
      ra1ContactPatches.length === 2,
      `calls=${ra1ContactPatches.length} statuses=${ra1ContactPatches.map(c => c.status).join(',')}`);
    record('RA1.3 first contacts PATCH was 429',
      ra1ContactPatches[0]?.status === 429,
      `first status=${ra1ContactPatches[0]?.status}`);
    record('RA1.4 second contacts PATCH succeeded (200)',
      ra1ContactPatches[1]?.status === 200,
      `second status=${ra1ContactPatches[1]?.status}`);

    // ── (RA2) room-assignments fitter PATCH permanent failure: PATCH always 500
    // hubspotRequestWithRetry exhausts all maxAttempts (4), then the inner
    // non-fatal try/catch in the route handler swallows the error. The endpoint
    // must still return 200 and not surface the failure to the client.
    console.log('\n  [RA2] room-assignments fitter PATCH: permanent 500 → endpoint still returns 200');
    mock.resetHits();
    mock.calls.length = 0;

    mock.configEndpoint('/crm/v3/objects/contacts/', 'ok',
      { id: CONTACT_ID, properties: { measure_once_rooms: RA_ROOMS } }, 'GET');
    mock.configEndpoint('/crm/v3/objects/contacts/', 'alwaysFail', null, 'PATCH');

    const ra2 = await manager.patch(
      `/api/contacts/${CONTACT_ID}/rooms/0/fitter`, { fitterId: null }
    );

    const ra2ContactPatches = mock.calls.filter(
      c => c.url.startsWith('/crm/v3/objects/contacts/') && c.method === 'PATCH'
    );
    record('RA2.1 fitter PATCH returns 200 despite permanent failure',
      ra2.status === 200,
      `status=${ra2.status} body=${ra2.text.slice(0, 120)}`);
    record('RA2.2 contacts PATCH exhausted all 4 attempts',
      ra2ContactPatches.length === 4,
      `calls=${ra2ContactPatches.length} statuses=${ra2ContactPatches.map(c => c.status).join(',')}`);
    record('RA2.3 all PATCH attempts returned 500',
      ra2ContactPatches.every(c => c.status === 500),
      `statuses=${ra2ContactPatches.map(c => c.status).join(',')}`);
    record('RA2.4 response body includes syncFailed: true',
      ra2.json?.syncFailed === true,
      `syncFailed=${ra2.json?.syncFailed}`);

    // ── (RA3) room-assignments fitter PATCH happy path — syncFailed absent
    // When HubSpot PATCH succeeds, the response must NOT include syncFailed so
    // the UI shows the plain "Fitter assigned" toast without a warning.
    console.log('\n  [RA3] room-assignments fitter PATCH: HubSpot succeeds → no syncFailed in response');
    mock.resetHits();
    mock.calls.length = 0;

    mock.configEndpoint('/crm/v3/objects/contacts/', 'ok',
      { id: CONTACT_ID, properties: { measure_once_rooms: RA_ROOMS } }, 'GET');
    mock.configEndpoint('/crm/v3/objects/contacts/', 'ok',
      { id: CONTACT_ID, properties: {} }, 'PATCH');

    const ra3 = await manager.patch(
      `/api/contacts/${CONTACT_ID}/rooms/0/fitter`, { fitterId: null }
    );

    record('RA3.1 fitter PATCH returns 200',
      ra3.status === 200,
      `status=${ra3.status} body=${ra3.text.slice(0, 120)}`);
    record('RA3.2 response body has no syncFailed flag',
      ra3.json?.syncFailed == null,
      `syncFailed=${ra3.json?.syncFailed}`);
    record('RA3.3 response body has success: true',
      ra3.json?.success === true,
      `success=${ra3.json?.success}`);

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
    '# Design-Visit HubSpot 429 Retry Recovery — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:design-visit-hubspot-retry\``,
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
    '- **(DV1) design-visit note creation retry**: `POST /api/design-visits/:id/submit`',
    '  with `/crm/v3/objects/notes` returning 429 on the first attempt. The call',
    '  recovers via `dvHubspotRequestWithRetry` and the endpoint returns 200.',
    '- **(DV2) design-visit lead status retry**: `POST /api/design-visits/:id/submit`',
    '  with `handlerConfig.submittedLeadStatus` set. The `PATCH /crm/v3/objects/contacts/:id`',
    '  returns 429 on the first attempt, recovers via `dvHubspotRequestWithRetry`,',
    '  and the endpoint returns 200.',
    '- **(DV3) design-visit note permanent failure**: `POST /api/design-visits/:id/submit`',
    '  with `POST /crm/v3/objects/notes` always returning 500. All 4 retry attempts',
    '  are exhausted; the outer non-fatal `try/catch` in `runSubmitSideEffects` swallows',
    '  the error. The endpoint still returns 200, the DB row reaches `submitted` status,',
    '  and no uncaught exception surfaces to the client.',
    '- **(DV4) design-visit lead-status permanent failure**: `POST /api/design-visits/:id/submit`',
    '  with `handlerConfig.submittedLeadStatus` set and `PATCH /crm/v3/objects/contacts/:id`',
    '  always returning 500. All 4 retry attempts are exhausted; the outer non-fatal',
    '  `try/catch` in `runSubmitSideEffects` swallows the error. The endpoint still returns',
    '  200 and the DB row reaches `submitted` status.',
    '- **(LD) localdata PATCH retry**: `POST /api/contacts/:id/localdata` with the',
    '  `PATCH /crm/v3/objects/contacts/:id` returning 429 on the first attempt.',
    '  Recovers via `hubspotRequestWithRetry` and the endpoint returns 200 (not 502).',
    '- **(LD2) localdata PATCH permanent failure**: `POST /api/contacts/:id/localdata`',
    '  with `PATCH /crm/v3/objects/contacts/:id` always returning 500. All 4 retry',
    '  attempts are exhausted; the inner non-fatal `try/catch` in the route handler',
    '  swallows the error. The endpoint still returns 200 and does not surface the failure.',
    '- **(RA1) room-assignments fitter PATCH retry**: `PATCH /api/contacts/:id/rooms/:roomIdx/fitter`',
    '  with `PATCH /crm/v3/objects/contacts/:id` returning 429 on the first attempt.',
    '  Recovers via `hubspotRequestWithRetry` and the endpoint returns 200.',
    '- **(RA2) room-assignments fitter PATCH permanent failure**: `PATCH /api/contacts/:id/rooms/:roomIdx/fitter`',
    '  with `PATCH /crm/v3/objects/contacts/:id` always returning 500. All 4 retry',
    '  attempts are exhausted; the inner non-fatal `try/catch` in the route handler',
    '  swallows the error. The endpoint still returns 200 with `syncFailed: true` in',
    '  the body so the UI can show a non-blocking warning toast.',
    '- **(RA3) room-assignments fitter PATCH happy path**: `PATCH /api/contacts/:id/rooms/:roomIdx/fitter`',
    '  with `PATCH /crm/v3/objects/contacts/:id` succeeding immediately. The endpoint',
    '  returns 200 with `success: true` and no `syncFailed` field, confirming the UI',
    '  shows the plain "Fitter assigned" toast without a warning.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
