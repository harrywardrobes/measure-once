'use strict';
// test/hubspot-429-retry/run.js
//
// Focused integration test confirming that the urgency and workflow-stages
// endpoints recover from a transient HubSpot 429 via hubspotRequestWithRetry.
//
//   (U1) urgency assoc-batch retry — POST /api/contacts/urgency: first call to
//        /crm/v4/associations/contacts/tasks/batch/read returns 429 + Retry-
//        After, retry succeeds → endpoint returns a valid urgency map.
//
//   (U2) urgency task-batch retry — assoc-batch succeeds immediately, first
//        call to /crm/v3/objects/tasks/batch/read returns 429, retry succeeds
//        → endpoint still returns a valid urgency map.
//
//   (WS) workflow-stages double retry — GET /api/workflow-stages: both the
//        notes-search and the assoc-batch call return 429 on their first
//        attempt and succeed on retry, all within a single cold-cache
//        fetchWorkflowStagesFromHubspot invocation → endpoint returns the
//        expected stage data.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:hubspot-429-retry
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:hubspot-429-retry

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'hubspot-429-retry.md');
const findings = [];

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

// A WORKFLOW_DATA note linking note 'note101' → contact '42'.
const NOTE_BODY = 'WORKFLOW_DATA:[{"room":"Main","stageKey":"sales"}]';
const NOTES_SEARCH_SUCCESS = {
  results: [{ id: 'note101', properties: { hs_note_body: NOTE_BODY } }],
};
const ASSOC_NOTES_SUCCESS = {
  results: [{ from: { id: 'note101' }, to: [{ toObjectId: '42' }] }],
};

// ── Mock HubSpot server ───────────────────────────────────────────────────────
// Each endpoint rule has an independent hit counter.  In 'retryOnce' mode the
// first hit returns 429 + Retry-After: 0 (instant retry so tests stay fast);
// subsequent hits return successBody with 200.  'ok' mode always returns 200.

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

  // Point the spawned server at the mock; provide a dummy token so
  // requireHubspotToken passes.
  process.env.HUBSPOT_API_URL                   = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_ACCESS_TOKEN              = 'privtest-dummy-token';
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';

  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
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
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  test server up at ${BASE}\n`);

    const client = await login(users.member.email, PASSWORD);
    const cookie = client.cookie;

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

    // ── (WS) workflow-stages: notes-search + assoc-batch both retry ───────────
    // Both HubSpot calls inside fetchWorkflowStagesFromHubspot return 429 on
    // their first attempt; both succeed on the retry.  This is a cold-cache
    // request so the full fetch pipeline runs.  The endpoint must return the
    // expected contact-to-stages mapping.
    console.log('\n  [WS] workflow-stages: notes-search + assoc-batch 429 → retry → success');
    mock.resetHits();
    mock.calls.length = 0;
    mock.configEndpoint(
      '/crm/v3/objects/notes/search',
      'retryOnce',
      NOTES_SEARCH_SUCCESS,
    );
    mock.configEndpoint(
      '/crm/v4/associations/notes/contacts/batch/read',
      'retryOnce',
      ASSOC_NOTES_SUCCESS,
    );

    const ws = await httpGet(BASE, '/api/workflow-stages', cookie);

    const wsNotesCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v3/objects/notes/search'),
    );
    const wsAssocCalls = mock.calls.filter(c =>
      c.url.startsWith('/crm/v4/associations/notes/contacts/batch/read'),
    );

    record('WS.1 endpoint returns 200',
      ws.status === 200,
      `status=${ws.status}`);
    record('WS.2 response is an object',
      ws.json && typeof ws.json === 'object' && !Array.isArray(ws.json),
      `body=${ws.body.slice(0, 180)}`);
    record('WS.3 contact 42 present in result',
      ws.json && '42' in ws.json,
      `keys=${Object.keys(ws.json || {}).join(',')} body=${ws.body.slice(0, 180)}`);
    record('WS.4 notes-search called twice (429 + retry)',
      wsNotesCalls.length === 2,
      `notes calls=${wsNotesCalls.length} statuses=${wsNotesCalls.map(c => c.status).join(',')}`);
    record('WS.5 first notes-search was a 429',
      wsNotesCalls[0]?.status === 429,
      `first status=${wsNotesCalls[0]?.status}`);
    record('WS.6 second notes-search succeeded (200)',
      wsNotesCalls[1]?.status === 200,
      `second status=${wsNotesCalls[1]?.status}`);
    record('WS.7 assoc-batch called twice (429 + retry)',
      wsAssocCalls.length === 2,
      `assoc calls=${wsAssocCalls.length} statuses=${wsAssocCalls.map(c => c.status).join(',')}`);
    record('WS.8 first assoc-batch was a 429',
      wsAssocCalls[0]?.status === 429,
      `first status=${wsAssocCalls[0]?.status}`);
    record('WS.9 second assoc-batch succeeded (200)',
      wsAssocCalls[1]?.status === 200,
      `second status=${wsAssocCalls[1]?.status}`);

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
    '- **(WS) workflow-stages double retry**: `GET /api/workflow-stages` with both',
    '  the notes-search and the assoc-batch inside `fetchWorkflowStagesFromHubspot`',
    '  returning 429 on their first attempt.  Both calls retry successfully and the',
    '  endpoint returns the expected contact-to-stages mapping.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
