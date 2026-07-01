'use strict';
// test/hubspot-429-retry/run.js
//
// Focused integration test confirming that the urgency endpoint recovers from
// a transient HubSpot 429 via hubspotRequestWithRetry, AND that
// dvHubspotRequestWithRetry in the design-visit pipeline correctly retries on
// transient errors and exhausts gracefully on persistent failures.
//
//   (U1) urgency assoc-batch retry — POST /api/contacts/urgency: first call to
//        /crm/v4/associations/contacts/tasks/batch/read returns 429 + Retry-
//        After, retry succeeds → endpoint returns a valid urgency map.
//
//   (U2) urgency task-batch retry — assoc-batch succeeds immediately, first
//        call to /crm/v3/objects/tasks/batch/read returns 429, retry succeeds
//        → endpoint still returns a valid urgency map.
//
//   (DV1) design-visit note 429 → retry → success — POST to submit a visit
//        when /crm/v3/objects/notes returns 429 on the first attempt and 200
//        on the second.  The submit endpoint must return 200 and the mock must
//        have received exactly two note-creation calls.
//
//   (DV2) design-visit note exhaustion → non-fatal — POST to submit a visit
//        when /crm/v3/objects/notes always returns 500.  After all 4 attempts
//        dvHubspotRequestWithRetry logs "all 4 attempts exhausted".  The submit
//        endpoint must still return 200 (non-fatal path) and that log line must
//        appear in the server output.
//
//   (DV3) design-visit lead-status PATCH: 429 → retry → success — POST to
//        submit a visit with handlerConfig.submittedLeadStatus set.  The mock
//        returns 429 on the first PATCH to /crm/v3/objects/contacts/:id and
//        200 on the second.  The submit endpoint must return 200 and the mock
//        must have received exactly 2 PATCH calls.
//
//   (DV4) design-visit lead-status PATCH exhaustion → non-fatal — same setup
//        but the mock always returns 500 for the contacts PATCH.  After all 4
//        attempts dvHubspotRequestWithRetry logs "all 4 attempts exhausted".
//        The submit endpoint must still return 200 (non-fatal catch path) and
//        the exhaustion log line must appear in the server output.
//
//   (DV5) revision-requested resubmit: note 429 → retry → success — seeds a
//        visit in revision_requested status (customer asked for changes) then
//        POST /api/design-visits/:id/submit.  The mock returns 429 on the
//        first note creation and 200 on the second.  dvHubspotRequestWithRetry
//        must retry automatically; submit must return 200 with exactly 2 note
//        calls observed.
//
//   (DV6) revision-requested resubmit: note exhaustion → non-fatal — same
//        revision_requested setup but the mock always returns 500 for note
//        creation.  After all 4 attempts the exhaustion log line is emitted;
//        submit must still return 200 (non-fatal catch path).
//
//   (DV7) sign-off re-open (PUT): note 429 → retry → success — seeds a visit
//        in submitted status (sent to customer awaiting sign-off) then re-opens
//        it via PUT /api/design-visits/:id (the designer-correction path).
//        runSubmitSideEffects re-runs; the mock returns 429 on the first note
//        creation and 200 on the second.  PUT must return 200 with exactly 2
//        note calls.
//
//   (DV8) sign-off re-open (PUT): note exhaustion → non-fatal — same submitted
//        setup but the mock always returns 500 for note creation.  After all 4
//        attempts the exhaustion log line is emitted; PUT must still return 200
//        (non-fatal try/catch wrapping runSubmitSideEffects on the PUT path).
//
//   (DV9) revision-requested resubmit: lead-status PATCH 429 → retry → success
//        — seeds a visit in revision_requested status and submits with
//        handlerConfig.submittedLeadStatus set.  The mock returns 429 on the
//        first PATCH to /crm/v3/objects/contacts/:id and 200 on the second.
//        Submit must return 200 with exactly 2 PATCH calls observed.
//
//   (DV10) revision-requested resubmit: lead-status PATCH exhaustion → non-fatal
//        — same revision_requested + submittedLeadStatus setup but the mock
//        always returns 500 for the contacts PATCH.  After all 4 attempts
//        dvHubspotRequestWithRetry logs "all 4 attempts exhausted".  Submit must
//        still return 200 (non-fatal catch path) and the exhaustion log line must
//        appear in the server output.
//
//   (DV11) sign-off re-open (PUT): lead-status PATCH 429 → retry → success
//        — seeds a visit in submitted status then re-opens it via
//        PUT /api/design-visits/:id with handlerConfig.submittedLeadStatus set.
//        runSubmitSideEffects re-runs and section 2 fires the contacts PATCH.
//        The mock returns 429 on the first PATCH and 200 on the second.  PUT
//        must return 200 with exactly 2 PATCH calls observed.
//
//   (DV12) sign-off re-open (PUT): lead-status PATCH exhaustion → non-fatal
//        — same submitted + submittedLeadStatus setup but the mock always
//        returns 500 for the contacts PATCH.  After all 4 attempts
//        dvHubspotRequestWithRetry logs "all 4 attempts exhausted".  PUT must
//        still return 200 (non-fatal try/catch wrapping runSubmitSideEffects on
//        the PUT path) and the exhaustion log line must appear in server output.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:hubspot-429-retry
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:hubspot-429-retry

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');
const { pollFn } = require('../helpers/poll');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'hubspot-429-retry.md');
const findings = [];

const DV_CONTACT_ID = 'privtest-dv-retry-contact';

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Shared response fixtures ──────────────────────────────────────────────────

// A task due ~36 hours from now → should land in the 'orange' urgency bucket
// (within 2 working days but not within 1).
const TASK_DUE_MS = Date.now() + 36 * 3600 * 1000;

const ASSOC_TASK_SUCCESS = {
  results: [{ from: { id: '111' }, to: [{ toObjectId: '999' }] }],
};
const TASK_BATCH_SUCCESS = {
  results: [{
    id: '999',
    properties: {
      hs_task_status: 'NOT_STARTED',
      hs_timestamp: String(TASK_DUE_MS),
    },
  }],
};

const NOTE_CREATE_SUCCESS    = { id: 'mock-note-id', properties: {} };
const CONTACT_PATCH_SUCCESS  = { id: DV_CONTACT_ID, properties: {} };

// ── Mock HubSpot server ───────────────────────────────────────────────────────
// Each endpoint rule has an independent hit counter.
//   'retryOnce'  — first hit returns 429 + Retry-After: 0; subsequent hits
//                  return successBody with 200.
//   'ok'         — always returns 200 with successBody.
//   'alwaysFail' — always returns 500 (used to exhaust dvHubspotRequestWithRetry).

function startMockHubspot() {
  // rules: url-prefix → { mode, hits, successBody }
  const rules = {};

  function configEndpoint(urlPrefix, mode, successBody) {
    rules[urlPrefix] = { mode, hits: 0, successBody };
  }

  function resetHits() {
    for (const r of Object.values(rules)) r.hits = 0;
  }

  const calls = []; // { url, status, at }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const url = req.url.split('?')[0];

      // Match the longest prefix rule that fits.
      let matched = null;
      for (const prefix of Object.keys(rules)) {
        if (url.startsWith(prefix)) {
          if (!matched || prefix.length > matched.length) matched = prefix;
        }
      }

      if (!matched) {
        calls.push({ url, status: 404, at: Date.now() });
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', message: `no mock for ${url}` }));
      }

      const rule = rules[matched];
      rule.hits++;

      if (rule.mode === 'alwaysFail') {
        calls.push({ url, status: 500, at: Date.now() });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', message: 'internal server error' }));
      }

      if (rule.mode === 'retryOnce' && rule.hits === 1) {
        calls.push({ url, status: 429, at: Date.now() });
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        return res.end(JSON.stringify({ status: 'error', message: 'rate limited' }));
      }

      calls.push({ url, status: 200, at: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rule.successBody));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, rules, calls, configEndpoint, resetHits });
    });
  });
}

// ── HTTP helper (PUT with JSON body) ─────────────────────────────────────────
function httpPut(base, urlPath, cookie, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const u = new URL(urlPath, base);
    const req = http.request({
      method: 'PUT',
      hostname: u.hostname,
      port:     u.port,
      path:     u.pathname + u.search,
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, body: raw, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ── HTTP helper (POST with JSON body) ────────────────────────────────────────
function httpPost(base, urlPath, cookie, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const u = new URL(urlPath, base);
    const req = http.request({
      method: 'POST',
      hostname: u.hostname,
      port:     u.port,
      path:     u.pathname + u.search,
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, body: raw, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function httpGet(base, urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const req = http.request({
      method: 'GET',
      hostname: u.hostname,
      port:     u.port,
      path:     u.pathname + u.search,
      headers: cookie ? { Cookie: cookie } : {},
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, body: raw, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Design-visit DB helpers ───────────────────────────────────────────────────

async function seedDesignVisit(pool, status = 'draft') {
  const r = await pool.query(
    `INSERT INTO design_visits
       (contact_id, contact_name, contact_email, created_by, visit_date,
        duration_min, location, notes, terms_accepted, status)
     VALUES ($1, 'PrivTest DV Retry Contact', 'privtest-dv-retry@privtest.local',
             'privtest-dv-retry-submitter@privtest.local',
             NOW(), 60, 'Retry test location', 'hubspot retry test', TRUE,
             $2)
     RETURNING id`,
    [DV_CONTACT_ID, status],
  );
  return r.rows[0].id;
}

async function cleanupDesignVisits(pool) {
  try {
    await pool.query(
      `DELETE FROM design_visits WHERE contact_id = $1`,
      [DV_CONTACT_ID],
    );
  } catch {}
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
  console.log(`\n  hubspot-429-retry  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL'}`);

  const pool = new Pool({ connectionString: connStr });
  const mock = await startMockHubspot();
  console.log(`  mock HubSpot listening on http://127.0.0.1:${mock.port}`);

  const dvMailFile = path.join(os.tmpdir(), `dv-retry-mail-${runId}.jsonl`);
  try { fs.unlinkSync(dvMailFile); } catch {}

  // Point both HubSpot API env vars at the mock so urgency
  // (HUBSPOT_API_URL in server.js) and design-visit calls
  // (HUBSPOT_API_BASE_OVERRIDE in design-visits.js) hit the same mock server.
  process.env.HUBSPOT_API_URL                   = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_API_BASE_OVERRIDE         = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_ACCESS_TOKEN              = 'privtest-dummy-token';
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';
  // Capture design-visit submit emails so the submit side-effects don't error
  // out on missing SMTP config (mail sections are non-fatal but this keeps
  // the test output clean).
  process.env.MAIL_TRANSPORT_FILE_OVERRIDE      = dvMailFile;
  process.env.PRIVTEST_USE_ADMIN_EMAILS         = '1';
  process.env.ADMIN_EMAILS                      = 'admin@privtest.local';

  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool, BASE, PASSWORD,
  } = require('../privileges/harness');
  setPool(pool);

  await cleanupTestData(pool);
  await cleanupDesignVisits(pool);
  const users = await seedUsers(pool, runId);

  const { child, logBuf } = spawnServer();
  let exitCode = 1;

  const cleanup = async () => {
    try { child.kill('SIGTERM'); } catch {}
    try { await cleanupDesignVisits(pool); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    try { mock.server.close(); } catch {}
    try { fs.unlinkSync(dvMailFile); } catch {}
  };
  process.on('SIGINT',  () => cleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => cleanup().then(() => process.exit(130)));

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  test server up at ${BASE}\n`);

    // Wait for design_visits schema columns added asynchronously on boot.
    await pollFn(async () => {
      const r = await pool.query(`
        SELECT 1 FROM information_schema.columns
          WHERE table_name = 'design_visits'
            AND column_name = 'superseded_signoff_token_hashes'
        LIMIT 1`);
      return r.rowCount || null;
    }, 15000, 200);

    const client  = await login(users.member.email,   PASSWORD);
    const cookie  = client.cookie;
    const manager = await login(users.manager.email,  PASSWORD);
    const managerCookie = manager.cookie;

    // ── (U1) urgency assoc-batch retry ────────────────────────────────────────
    // The assoc-batch call gets a 429 on its first attempt; the task-batch is
    // configured to return 200 immediately.  The endpoint must still return a
    // valid urgency map after the retry.
    console.log('  [U1] urgency: assoc-batch 429 → retry → success');
    mock.configEndpoint(
      '/crm/v4/associations/contacts/tasks/batch/read',
      'retryOnce',
      ASSOC_TASK_SUCCESS,
    );
    mock.configEndpoint(
      '/crm/v3/objects/tasks/batch/read',
      'ok',
      TASK_BATCH_SUCCESS,
    );
    mock.calls.length = 0;

    const u1 = await httpPost(BASE, '/api/contacts/urgency', cookie, { ids: ['111'] });

    const u1AssocCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v4/associations/contacts/tasks/batch/read'),
    );
    record('U1.1 endpoint returns 200',
      u1.status === 200,
      `status=${u1.status}`);
    record('U1.2 urgency map present in response',
      u1.json && typeof u1.json.urgency === 'object',
      `body=${u1.body.slice(0, 120)}`);
    record('U1.3 urgency entry for contact 111 exists',
      u1.json && '111' in u1.json.urgency,
      `urgency=${JSON.stringify(u1.json?.urgency)}`);
    record('U1.4 assoc-batch was called twice (429 + retry)',
      u1AssocCalls.length === 2,
      `assoc calls=${u1AssocCalls.length} statuses=${u1AssocCalls.map(c => c.status).join(',')}`);
    record('U1.5 first assoc-batch call was a 429',
      u1AssocCalls[0]?.status === 429,
      `first status=${u1AssocCalls[0]?.status}`);
    record('U1.6 second assoc-batch call succeeded (200)',
      u1AssocCalls[1]?.status === 200,
      `second status=${u1AssocCalls[1]?.status}`);

    // ── (U2) urgency task-batch retry ─────────────────────────────────────────
    // Assoc-batch returns 200 immediately; the task-batch chunk gets a 429 on
    // its first attempt.  The endpoint must still return a valid urgency map.
    console.log('\n  [U2] urgency: task-batch 429 → retry → success');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint(
      '/crm/v4/associations/contacts/tasks/batch/read',
      'ok',
      ASSOC_TASK_SUCCESS,
    );
    mock.configEndpoint(
      '/crm/v3/objects/tasks/batch/read',
      'retryOnce',
      TASK_BATCH_SUCCESS,
    );

    const u2 = await httpPost(BASE, '/api/contacts/urgency', cookie, { ids: ['111'] });

    const u2TaskCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/tasks/batch/read'),
    );
    record('U2.1 endpoint returns 200',
      u2.status === 200,
      `status=${u2.status}`);
    record('U2.2 urgency map present in response',
      u2.json && typeof u2.json.urgency === 'object',
      `body=${u2.body.slice(0, 120)}`);
    record('U2.3 urgency entry for contact 111 exists',
      u2.json && '111' in u2.json.urgency,
      `urgency=${JSON.stringify(u2.json?.urgency)}`);
    record('U2.4 task-batch was called twice (429 + retry)',
      u2TaskCalls.length === 2,
      `task calls=${u2TaskCalls.length} statuses=${u2TaskCalls.map(c => c.status).join(',')}`);
    record('U2.5 first task-batch call was a 429',
      u2TaskCalls[0]?.status === 429,
      `first status=${u2TaskCalls[0]?.status}`);
    record('U2.6 second task-batch call succeeded (200)',
      u2TaskCalls[1]?.status === 200,
      `second status=${u2TaskCalls[1]?.status}`);

    // ── (DV1) design-visit note: 429 → retry → success ───────────────────────
    // The mock returns 429 on the first POST to /crm/v3/objects/notes and 200
    // on the second.  dvHubspotRequestWithRetry must retry automatically and
    // the submit endpoint must return 200.
    console.log('\n  [DV1] design-visit note: 429 → retry → success');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint('/crm/v3/objects/notes', 'retryOnce', NOTE_CREATE_SUCCESS);

    const dv1Id = await seedDesignVisit(pool);
    const dv1 = await httpPost(BASE, `/api/design-visits/${dv1Id}/submit`, cookie, {});

    const dv1NoteCalls = mock.calls.filter(c => c.url === '/crm/v3/objects/notes');

    record('DV1.1 submit returns 200',
      dv1.status === 200,
      `status=${dv1.status} body=${dv1.body.slice(0, 200)}`);
    record('DV1.2 notes endpoint called twice (429 + retry)',
      dv1NoteCalls.length === 2,
      `note calls=${dv1NoteCalls.length} statuses=${dv1NoteCalls.map(c => c.status).join(',')}`);
    record('DV1.3 first note call returned 429',
      dv1NoteCalls[0]?.status === 429,
      `first status=${dv1NoteCalls[0]?.status}`);
    record('DV1.4 second note call returned 200',
      dv1NoteCalls[1]?.status === 200,
      `second status=${dv1NoteCalls[1]?.status}`);

    // ── (DV2) design-visit note: all attempts exhausted → non-fatal 200 ───────
    // The mock always returns 500 for the notes endpoint.  After maxAttempts=4
    // attempts dvHubspotRequestWithRetry logs the exhaustion line and throws;
    // the surrounding try/catch in runSubmitSideEffects treats the failure as
    // non-fatal, so the submit endpoint must still return 200.
    console.log('\n  [DV2] design-visit note: always 500 → exhaustion log + non-fatal 200');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint('/crm/v3/objects/notes', 'alwaysFail', null);

    const dv2Id = await seedDesignVisit(pool);
    const dv2 = await httpPost(BASE, `/api/design-visits/${dv2Id}/submit`, cookie, {});

    // Give the log a brief moment to flush after the HTTP response returns.
    // runSubmitSideEffects is awaited inside the submit handler, so the log
    // should already be present, but we poll defensively for up to 1 second.
    const exhaustionMarker = '[design-visits/hubspot-retry] all 4 attempts exhausted';
    await pollFn(() => logBuf.join('').includes(exhaustionMarker) ? true : null, 1000, 50);

    const dv2NoteCalls = mock.calls.filter(c => c.url === '/crm/v3/objects/notes');
    const logText      = logBuf.join('');

    record('DV2.1 submit still returns 200 (non-fatal)',
      dv2.status === 200,
      `status=${dv2.status} body=${dv2.body.slice(0, 200)}`);
    record('DV2.2 notes endpoint called 4 times (all attempts)',
      dv2NoteCalls.length === 4,
      `note calls=${dv2NoteCalls.length} statuses=${dv2NoteCalls.map(c => c.status).join(',')}`);
    record('DV2.3 all note calls returned 500',
      dv2NoteCalls.every(c => c.status === 500),
      `statuses=${dv2NoteCalls.map(c => c.status).join(',')}`);
    record('DV2.4 exhaustion log line emitted',
      logText.includes(exhaustionMarker),
      logText.includes(exhaustionMarker)
        ? `found "${exhaustionMarker}" in server log`
        : `exhaustion line not found; last 500 chars of log: ${logText.slice(-500)}`);

    // ── (DV3) design-visit lead-status PATCH: 429 → retry → success ──────────
    // Seeds a handler config with submittedLeadStatus and passes it in the
    // submit body so section 2 of runSubmitSideEffects fires the PATCH.
    // The mock returns 429 on the first PATCH to /crm/v3/objects/contacts/…
    // and 200 on the second.  The submit endpoint must return 200 and the mock
    // must have received exactly 2 PATCH calls.
    console.log('\n  [DV3] design-visit lead-status PATCH: 429 → retry → success');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint('/crm/v3/objects/contacts/', 'retryOnce', CONTACT_PATCH_SUCCESS);
    mock.configEndpoint('/crm/v3/objects/notes', 'ok', NOTE_CREATE_SUCCESS);

    const dv3Id = await seedDesignVisit(pool);
    const dv3 = await httpPost(
      BASE,
      `/api/design-visits/${dv3Id}/submit`,
      managerCookie,
      { handlerConfig: { submittedLeadStatus: 'PRIVTEST_LS_STATUS' } },
    );

    const dv3ContactCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/contacts/'),
    );

    record('DV3.1 submit returns 200',
      dv3.status === 200,
      `status=${dv3.status} body=${dv3.body.slice(0, 200)}`);
    record('DV3.2 contacts PATCH called twice (429 + retry)',
      dv3ContactCalls.length === 2,
      `contact calls=${dv3ContactCalls.length} statuses=${dv3ContactCalls.map(c => c.status).join(',')}`);
    record('DV3.3 first contacts PATCH returned 429',
      dv3ContactCalls[0]?.status === 429,
      `first status=${dv3ContactCalls[0]?.status}`);
    record('DV3.4 second contacts PATCH returned 200',
      dv3ContactCalls[1]?.status === 200,
      `second status=${dv3ContactCalls[1]?.status}`);

    // ── (DV4) design-visit lead-status PATCH: all attempts exhausted → non-fatal
    // The mock always returns 500 for the contacts PATCH.  After maxAttempts=4
    // attempts dvHubspotRequestWithRetry logs the exhaustion line; the
    // surrounding try/catch in runSubmitSideEffects treats it as non-fatal so
    // the submit endpoint must still return 200.
    console.log('\n  [DV4] design-visit lead-status PATCH: always 500 → exhaustion log + non-fatal 200');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint('/crm/v3/objects/contacts/', 'alwaysFail', null);
    mock.configEndpoint('/crm/v3/objects/notes', 'ok', NOTE_CREATE_SUCCESS);

    // Capture log position before DV4 so we can isolate the new exhaustion entry.
    const logBeforeDV4 = logBuf.join('');

    const dv4Id = await seedDesignVisit(pool);
    const dv4 = await httpPost(
      BASE,
      `/api/design-visits/${dv4Id}/submit`,
      managerCookie,
      { handlerConfig: { submittedLeadStatus: 'PRIVTEST_LS_STATUS' } },
    );

    // Poll briefly for the exhaustion log to flush after the HTTP response.
    await pollFn(() => logBuf.join('').slice(logBeforeDV4.length).includes(exhaustionMarker) ? true : null, 1000, 50);

    const dv4ContactCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/contacts/'),
    );
    const logAfterDV4 = logBuf.join('').slice(logBeforeDV4.length);

    record('DV4.1 submit still returns 200 (non-fatal)',
      dv4.status === 200,
      `status=${dv4.status} body=${dv4.body.slice(0, 200)}`);
    record('DV4.2 contacts PATCH called 4 times (all attempts)',
      dv4ContactCalls.length === 4,
      `contact calls=${dv4ContactCalls.length} statuses=${dv4ContactCalls.map(c => c.status).join(',')}`);
    record('DV4.3 all contacts PATCH calls returned 500',
      dv4ContactCalls.every(c => c.status === 500),
      `statuses=${dv4ContactCalls.map(c => c.status).join(',')}`);
    record('DV4.4 exhaustion log line emitted',
      logAfterDV4.includes(exhaustionMarker),
      logAfterDV4.includes(exhaustionMarker)
        ? `found "${exhaustionMarker}" in server log`
        : `exhaustion line not found; last 500 chars of new log: ${logAfterDV4.slice(-500)}`);

    // ── (DV5) revision-requested resubmit: note 429 → retry → success ──────────
    // Seeds a visit already in revision_requested status (simulating a visit the
    // customer asked to revise), then POSTs to the submit endpoint.
    // runSubmitSideEffects fires; the mock returns 429 on the first note creation
    // and 200 on the second.  Submit must return 200 with exactly 2 note calls.
    console.log('\n  [DV5] revision-requested resubmit: note 429 → retry → success');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint('/crm/v3/objects/notes', 'retryOnce', NOTE_CREATE_SUCCESS);

    const dv5Id = await seedDesignVisit(pool, 'revision_requested');
    const dv5 = await httpPost(BASE, `/api/design-visits/${dv5Id}/submit`, cookie, {});

    const dv5NoteCalls = mock.calls.filter(c => c.url === '/crm/v3/objects/notes');

    record('DV5.1 submit returns 200',
      dv5.status === 200,
      `status=${dv5.status} body=${dv5.body.slice(0, 200)}`);
    record('DV5.2 notes endpoint called twice (429 + retry)',
      dv5NoteCalls.length === 2,
      `note calls=${dv5NoteCalls.length} statuses=${dv5NoteCalls.map(c => c.status).join(',')}`);
    record('DV5.3 first note call returned 429',
      dv5NoteCalls[0]?.status === 429,
      `first status=${dv5NoteCalls[0]?.status}`);
    record('DV5.4 second note call returned 200',
      dv5NoteCalls[1]?.status === 200,
      `second status=${dv5NoteCalls[1]?.status}`);

    // ── (DV6) revision-requested resubmit: note always 500 → exhaustion + non-fatal
    // Same setup but the mock always returns 500 for note creation.  After all 4
    // attempts dvHubspotRequestWithRetry logs the exhaustion line; the surrounding
    // try/catch treats the failure as non-fatal, so submit still returns 200.
    console.log('\n  [DV6] revision-requested resubmit: note always 500 → exhaustion + non-fatal 200');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint('/crm/v3/objects/notes', 'alwaysFail', null);

    const logBeforeDV6 = logBuf.join('');

    const dv6Id = await seedDesignVisit(pool, 'revision_requested');
    const dv6 = await httpPost(BASE, `/api/design-visits/${dv6Id}/submit`, cookie, {});

    await pollFn(() => logBuf.join('').slice(logBeforeDV6.length).includes(exhaustionMarker) ? true : null, 1000, 50);

    const dv6NoteCalls = mock.calls.filter(c => c.url === '/crm/v3/objects/notes');
    const logAfterDV6  = logBuf.join('').slice(logBeforeDV6.length);

    record('DV6.1 submit still returns 200 (non-fatal)',
      dv6.status === 200,
      `status=${dv6.status} body=${dv6.body.slice(0, 200)}`);
    record('DV6.2 notes endpoint called 4 times (all attempts)',
      dv6NoteCalls.length === 4,
      `note calls=${dv6NoteCalls.length} statuses=${dv6NoteCalls.map(c => c.status).join(',')}`);
    record('DV6.3 all note calls returned 500',
      dv6NoteCalls.every(c => c.status === 500),
      `statuses=${dv6NoteCalls.map(c => c.status).join(',')}`);
    record('DV6.4 exhaustion log line emitted',
      logAfterDV6.includes(exhaustionMarker),
      logAfterDV6.includes(exhaustionMarker)
        ? `found "${exhaustionMarker}" in server log`
        : `exhaustion line not found; last 500 chars of new log: ${logAfterDV6.slice(-500)}`);

    // A minimal room payload reused by DV7 and DV8.  The PUT endpoint requires
    // at least one room and termsAccepted=true; no QB tokens are configured so
    // the QB block is skipped gracefully.
    const PUT_ROOMS = [{ roomName: 'Kitchen', unitCount: 1, unitPricePence: 0 }];
    const PUT_BODY = {
      contactName: 'PrivTest DV Retry Contact',
      contactEmail: 'privtest-dv-retry@privtest.local',
      termsAccepted: true,
      rooms: PUT_ROOMS,
    };

    // ── (DV7) sign-off re-open (PUT): note 429 → retry → success ─────────────
    // Seeds a visit in submitted status to simulate a visit already sent to the
    // customer.  The designer corrects it via PUT /api/design-visits/:id, which
    // re-runs runSubmitSideEffects.  The mock returns 429 on the first note
    // creation and 200 on the second.  PUT must return 200 with exactly 2 note calls.
    console.log('\n  [DV7] sign-off re-open (PUT): note 429 → retry → success');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint('/crm/v3/objects/notes', 'retryOnce', NOTE_CREATE_SUCCESS);

    const dv7Id = await seedDesignVisit(pool, 'submitted');
    const dv7 = await httpPut(BASE, `/api/design-visits/${dv7Id}`, cookie, PUT_BODY);

    const dv7NoteCalls = mock.calls.filter(c => c.url === '/crm/v3/objects/notes');

    record('DV7.1 PUT returns 200',
      dv7.status === 200,
      `status=${dv7.status} body=${dv7.body.slice(0, 200)}`);
    record('DV7.2 notes endpoint called twice (429 + retry)',
      dv7NoteCalls.length === 2,
      `note calls=${dv7NoteCalls.length} statuses=${dv7NoteCalls.map(c => c.status).join(',')}`);
    record('DV7.3 first note call returned 429',
      dv7NoteCalls[0]?.status === 429,
      `first status=${dv7NoteCalls[0]?.status}`);
    record('DV7.4 second note call returned 200',
      dv7NoteCalls[1]?.status === 200,
      `second status=${dv7NoteCalls[1]?.status}`);

    // ── (DV8) sign-off re-open (PUT): note always 500 → exhaustion + non-fatal ─
    // Same setup but notes always return 500.  The PUT endpoint wraps
    // runSubmitSideEffects in a try/catch so it still returns 200 even when
    // dvHubspotRequestWithRetry exhausts all 4 attempts.  The exhaustion log
    // line must appear in the server output.
    console.log('\n  [DV8] sign-off re-open (PUT): note always 500 → exhaustion + non-fatal 200');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint('/crm/v3/objects/notes', 'alwaysFail', null);

    const logBeforeDV8 = logBuf.join('');

    const dv8Id = await seedDesignVisit(pool, 'submitted');
    const dv8 = await httpPut(BASE, `/api/design-visits/${dv8Id}`, cookie, PUT_BODY);

    await pollFn(() => logBuf.join('').slice(logBeforeDV8.length).includes(exhaustionMarker) ? true : null, 1000, 50);

    const dv8NoteCalls = mock.calls.filter(c => c.url === '/crm/v3/objects/notes');
    const logAfterDV8  = logBuf.join('').slice(logBeforeDV8.length);

    record('DV8.1 PUT still returns 200 (non-fatal)',
      dv8.status === 200,
      `status=${dv8.status} body=${dv8.body.slice(0, 200)}`);
    record('DV8.2 notes endpoint called 4 times (all attempts)',
      dv8NoteCalls.length === 4,
      `note calls=${dv8NoteCalls.length} statuses=${dv8NoteCalls.map(c => c.status).join(',')}`);
    record('DV8.3 all note calls returned 500',
      dv8NoteCalls.every(c => c.status === 500),
      `statuses=${dv8NoteCalls.map(c => c.status).join(',')}`);
    record('DV8.4 exhaustion log line emitted',
      logAfterDV8.includes(exhaustionMarker),
      logAfterDV8.includes(exhaustionMarker)
        ? `found "${exhaustionMarker}" in server log`
        : `exhaustion line not found; last 500 chars of new log: ${logAfterDV8.slice(-500)}`);

    // ── (DV9) revision-requested resubmit: lead-status PATCH 429 → retry → success
    // Seeds a visit already in revision_requested status, then submits with
    // handlerConfig.submittedLeadStatus set so section 2 of runSubmitSideEffects
    // fires the contacts PATCH.  The mock returns 429 on the first PATCH and 200
    // on the second.  Submit must return 200 with exactly 2 PATCH calls.
    console.log('\n  [DV9] revision-requested resubmit: lead-status PATCH 429 → retry → success');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint('/crm/v3/objects/contacts/', 'retryOnce', CONTACT_PATCH_SUCCESS);
    mock.configEndpoint('/crm/v3/objects/notes', 'ok', NOTE_CREATE_SUCCESS);

    const dv9Id = await seedDesignVisit(pool, 'revision_requested');
    const dv9 = await httpPost(
      BASE,
      `/api/design-visits/${dv9Id}/submit`,
      cookie,
      { handlerConfig: { submittedLeadStatus: 'PRIVTEST_LS_STATUS' } },
    );

    const dv9ContactCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/contacts/'),
    );

    record('DV9.1 submit returns 200',
      dv9.status === 200,
      `status=${dv9.status} body=${dv9.body.slice(0, 200)}`);
    record('DV9.2 contacts PATCH called twice (429 + retry)',
      dv9ContactCalls.length === 2,
      `contact calls=${dv9ContactCalls.length} statuses=${dv9ContactCalls.map(c => c.status).join(',')}`);
    record('DV9.3 first contacts PATCH returned 429',
      dv9ContactCalls[0]?.status === 429,
      `first status=${dv9ContactCalls[0]?.status}`);
    record('DV9.4 second contacts PATCH returned 200',
      dv9ContactCalls[1]?.status === 200,
      `second status=${dv9ContactCalls[1]?.status}`);

    // ── (DV10) revision-requested resubmit: lead-status PATCH exhaustion → non-fatal
    // Same revision_requested + submittedLeadStatus setup but the mock always
    // returns 500 for the contacts PATCH.  After all 4 attempts
    // dvHubspotRequestWithRetry logs the exhaustion line; the surrounding
    // try/catch in runSubmitSideEffects treats it as non-fatal so submit still
    // returns 200.
    console.log('\n  [DV10] revision-requested resubmit: lead-status PATCH always 500 → exhaustion + non-fatal 200');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint('/crm/v3/objects/contacts/', 'alwaysFail', null);
    mock.configEndpoint('/crm/v3/objects/notes', 'ok', NOTE_CREATE_SUCCESS);

    const logBeforeDV10 = logBuf.join('');

    const dv10Id = await seedDesignVisit(pool, 'revision_requested');
    const dv10 = await httpPost(
      BASE,
      `/api/design-visits/${dv10Id}/submit`,
      cookie,
      { handlerConfig: { submittedLeadStatus: 'PRIVTEST_LS_STATUS' } },
    );

    await pollFn(() => logBuf.join('').slice(logBeforeDV10.length).includes(exhaustionMarker) ? true : null, 1000, 50);

    const dv10ContactCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/contacts/'),
    );
    const logAfterDV10 = logBuf.join('').slice(logBeforeDV10.length);

    record('DV10.1 submit still returns 200 (non-fatal)',
      dv10.status === 200,
      `status=${dv10.status} body=${dv10.body.slice(0, 200)}`);
    record('DV10.2 contacts PATCH called 4 times (all attempts)',
      dv10ContactCalls.length === 4,
      `contact calls=${dv10ContactCalls.length} statuses=${dv10ContactCalls.map(c => c.status).join(',')}`);
    record('DV10.3 all contacts PATCH calls returned 500',
      dv10ContactCalls.every(c => c.status === 500),
      `statuses=${dv10ContactCalls.map(c => c.status).join(',')}`);
    record('DV10.4 exhaustion log line emitted',
      logAfterDV10.includes(exhaustionMarker),
      logAfterDV10.includes(exhaustionMarker)
        ? `found "${exhaustionMarker}" in server log`
        : `exhaustion line not found; last 500 chars of new log: ${logAfterDV10.slice(-500)}`);

    // ── (DV11) sign-off re-open (PUT): lead-status PATCH 429 → retry → success ─
    // Seeds a visit in submitted status to simulate a visit already sent to the
    // customer.  The designer corrects it via PUT /api/design-visits/:id with
    // handlerConfig.submittedLeadStatus set, which re-runs runSubmitSideEffects
    // and fires section 2 (the contacts PATCH).  The mock returns 429 on the
    // first PATCH and 200 on the second.  PUT must return 200 with exactly 2
    // PATCH calls observed.
    console.log('\n  [DV11] sign-off re-open (PUT): lead-status PATCH 429 → retry → success');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint('/crm/v3/objects/contacts/', 'retryOnce', CONTACT_PATCH_SUCCESS);
    mock.configEndpoint('/crm/v3/objects/notes', 'ok', NOTE_CREATE_SUCCESS);

    const dv11Id = await seedDesignVisit(pool, 'submitted');
    const dv11 = await httpPut(
      BASE,
      `/api/design-visits/${dv11Id}`,
      cookie,
      { ...PUT_BODY, handlerConfig: { submittedLeadStatus: 'PRIVTEST_LS_STATUS' } },
    );

    const dv11ContactCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/contacts/'),
    );

    record('DV11.1 PUT returns 200',
      dv11.status === 200,
      `status=${dv11.status} body=${dv11.body.slice(0, 200)}`);
    record('DV11.2 contacts PATCH called twice (429 + retry)',
      dv11ContactCalls.length === 2,
      `contact calls=${dv11ContactCalls.length} statuses=${dv11ContactCalls.map(c => c.status).join(',')}`);
    record('DV11.3 first contacts PATCH returned 429',
      dv11ContactCalls[0]?.status === 429,
      `first status=${dv11ContactCalls[0]?.status}`);
    record('DV11.4 second contacts PATCH returned 200',
      dv11ContactCalls[1]?.status === 200,
      `second status=${dv11ContactCalls[1]?.status}`);

    // ── (DV12) sign-off re-open (PUT): lead-status PATCH exhaustion → non-fatal ─
    // Same submitted + submittedLeadStatus setup but the mock always returns 500
    // for the contacts PATCH.  After all 4 attempts dvHubspotRequestWithRetry
    // logs the exhaustion line; the try/catch wrapping runSubmitSideEffects on
    // the PUT path treats it as non-fatal so PUT still returns 200.
    console.log('\n  [DV12] sign-off re-open (PUT): lead-status PATCH always 500 → exhaustion + non-fatal 200');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint('/crm/v3/objects/contacts/', 'alwaysFail', null);
    mock.configEndpoint('/crm/v3/objects/notes', 'ok', NOTE_CREATE_SUCCESS);

    const logBeforeDV12 = logBuf.join('');

    const dv12Id = await seedDesignVisit(pool, 'submitted');
    const dv12 = await httpPut(
      BASE,
      `/api/design-visits/${dv12Id}`,
      cookie,
      { ...PUT_BODY, handlerConfig: { submittedLeadStatus: 'PRIVTEST_LS_STATUS' } },
    );

    await pollFn(() => logBuf.join('').slice(logBeforeDV12.length).includes(exhaustionMarker) ? true : null, 1000, 50);

    const dv12ContactCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/contacts/'),
    );
    const logAfterDV12 = logBuf.join('').slice(logBeforeDV12.length);

    record('DV12.1 PUT still returns 200 (non-fatal)',
      dv12.status === 200,
      `status=${dv12.status} body=${dv12.body.slice(0, 200)}`);
    record('DV12.2 contacts PATCH called 4 times (all attempts)',
      dv12ContactCalls.length === 4,
      `contact calls=${dv12ContactCalls.length} statuses=${dv12ContactCalls.map(c => c.status).join(',')}`);
    record('DV12.3 all contacts PATCH calls returned 500',
      dv12ContactCalls.every(c => c.status === 500),
      `statuses=${dv12ContactCalls.map(c => c.status).join(',')}`);
    record('DV12.4 exhaustion log line emitted',
      logAfterDV12.includes(exhaustionMarker),
      logAfterDV12.includes(exhaustionMarker)
        ? `found "${exhaustionMarker}" in server log`
        : `exhaustion line not found; last 500 chars of new log: ${logAfterDV12.slice(-500)}`);

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
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '# HubSpot 429 Retry Recovery — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:hubspot-429-retry\``,
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
    '- **(U1) urgency assoc-batch retry**: `POST /api/contacts/urgency` with the',
    '  `/crm/v4/associations/contacts/tasks/batch/read` call returning 429 on the',
    '  first attempt recovers via `hubspotRequestWithRetry` and returns a valid',
    '  urgency map.',
    '- **(U2) urgency task-batch retry**: `POST /api/contacts/urgency` with the',
    '  `/crm/v3/objects/tasks/batch/read` chunk call returning 429 on the first',
    '  attempt recovers and still produces a valid urgency map.',
    '- **(DV1) design-visit note 429 → retry → success**: `POST /api/design-visits/:id/submit`',
    '  with `/crm/v3/objects/notes` returning 429 on the first attempt and 200 on',
    '  the second.  `dvHubspotRequestWithRetry` retries automatically and the',
    '  submit endpoint returns 200 with exactly two note-creation calls observed.',
    '- **(DV2) design-visit note exhaustion → non-fatal**: `POST /api/design-visits/:id/submit`',
    '  with `/crm/v3/objects/notes` always returning 500.  After all 4 attempts the',
    '  `[design-visits/hubspot-retry] all 4 attempts exhausted` log line is emitted',
    '  and the submit endpoint still returns 200 (non-fatal catch path).',
    '- **(DV3) design-visit lead-status PATCH 429 → retry → success**: `POST /api/design-visits/:id/submit`',
    '  with a `handlerConfig.submittedLeadStatus` value triggers the PATCH to',
    '  `/crm/v3/objects/contacts/:id`.  The mock returns 429 on the first attempt',
    '  and 200 on the second.  `dvHubspotRequestWithRetry` retries automatically',
    '  and the submit endpoint returns 200 with exactly two PATCH calls observed.',
    '- **(DV4) design-visit lead-status PATCH exhaustion → non-fatal**: same setup',
    '  but the mock always returns 500.  After all 4 attempts the exhaustion log',
    '  line is emitted and the submit endpoint still returns 200 (non-fatal catch).',
    '- **(DV5) revision-requested resubmit: note 429 → retry → success**: seeds a',
    '  visit in `revision_requested` status then calls `POST /api/design-visits/:id/submit`.',
    '  The mock returns 429 on the first note creation and 200 on the second.',
    '  `dvHubspotRequestWithRetry` retries automatically and submit returns 200 with',
    '  exactly two note-creation calls observed.',
    '- **(DV6) revision-requested resubmit: note exhaustion → non-fatal**: same',
    '  `revision_requested` setup but the mock always returns 500 for note creation.',
    '  After all 4 attempts the exhaustion log line is emitted and submit still',
    '  returns 200 (non-fatal catch path).',
    '- **(DV7) sign-off re-open (PUT): note 429 → retry → success**: seeds a visit',
    '  in `submitted` status then re-opens it via `PUT /api/design-visits/:id`',
    '  (the designer-correction path).  `runSubmitSideEffects` re-runs; the mock',
    '  returns 429 on the first note creation and 200 on the second.  PUT returns',
    '  200 with exactly two note-creation calls observed.',
    '- **(DV8) sign-off re-open (PUT): note exhaustion → non-fatal**: same',
    '  `submitted` setup but the mock always returns 500 for note creation.  After',
    '  all 4 attempts the exhaustion log line is emitted and PUT still returns 200',
    '  (the `try/catch` wrapping `runSubmitSideEffects` on the PUT path).',
    '- **(DV9) revision-requested resubmit: lead-status PATCH 429 → retry → success**:',
    '  seeds a visit in `revision_requested` status and submits with',
    '  `handlerConfig.submittedLeadStatus` set.  The mock returns 429 on the first',
    '  PATCH to `/crm/v3/objects/contacts/:id` and 200 on the second.',
    '  `dvHubspotRequestWithRetry` retries automatically and submit returns 200 with',
    '  exactly two PATCH calls observed.',
    '- **(DV10) revision-requested resubmit: lead-status PATCH exhaustion → non-fatal**:',
    '  same `revision_requested` + `submittedLeadStatus` setup but the mock always',
    '  returns 500 for the contacts PATCH.  After all 4 attempts the exhaustion log',
    '  line is emitted and submit still returns 200 (non-fatal catch path).',
    '- **(DV11) sign-off re-open (PUT): lead-status PATCH 429 → retry → success**:',
    '  seeds a visit in `submitted` status then re-opens it via',
    '  `PUT /api/design-visits/:id` with `handlerConfig.submittedLeadStatus` set.',
    '  `runSubmitSideEffects` re-runs; the mock returns 429 on the first PATCH to',
    '  `/crm/v3/objects/contacts/:id` and 200 on the second.',
    '  `dvHubspotRequestWithRetry` retries automatically and PUT returns 200 with',
    '  exactly two PATCH calls observed.',
    '- **(DV12) sign-off re-open (PUT): lead-status PATCH exhaustion → non-fatal**:',
    '  same `submitted` + `submittedLeadStatus` setup but the mock always returns',
    '  500 for the contacts PATCH.  After all 4 attempts the exhaustion log line',
    '  is emitted and PUT still returns 200 (the `try/catch` wrapping',
    '  `runSubmitSideEffects` on the PUT path).',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
