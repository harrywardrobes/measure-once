'use strict';
// test/arrange-visit/run.js
//
// End-to-end backend test for the arrange_visit card-action handler routes.
// Boots a disposable Express server with a fake HubSpot stub (HUBSPOT_API_URL
// override) so route logic can be exercised without real HubSpot credentials.
//
// Covers:
//   (auth.1)  Unauthenticated POST /api/card-actions/arrange-visit → 401
//   (auth.2)  Unauthenticated POST /api/card-actions/arrange-visit/outcome → 401
//   (auth.3)  Viewer POST /api/card-actions/arrange-visit → 403
//             (requirePrivilege('member') gate — insufficient privilege)
//   (auth.4)  Viewer POST /api/card-actions/arrange-visit/outcome → 403
//   (A.1)     hs_lead_status='awaiting_deposit' → visitType='survey'
//   (A.2)     hs_lead_status='OPEN_DEAL' (other value) → visitType='design'
//   (A.3)     hs_lead_status='' (absent) → visitType='design'
//   (A.bad)   Non-numeric contactId → 400
//   (B.1-6)   All 6 valid outcome × visitType combinations map to the correct
//             HubSpot hs_lead_status and hw_lead_substatus keys:
//             SURVEY_SCHEDULED__SRSC_AGREED, DESIGN_SCHEDULED__DSSC_AGREED,
//             SURVEY_SCHEDULED__SRSC_SUGGESTED, DESIGN_SCHEDULED__DSSC_SUGGESTED,
//             not_suitable (×2, empty substatus)
//   (B.bad)   Invalid outcome → 400
//   (F.1)     GET /api/events?contactId returns future events when Google is
//             connected — exercises the duplicate-visit guard server path
//   (F.2)     POST /api/events passes location + description from body through
//             to Google Calendar unchanged — verifies the booking-path event
//             payload (address + notes) reaches the calendar API
//   (G.1-3)   Static source assertions: the offline cancellation toast string
//             ("Existing visit cancelled — new booking saved offline and will
//             sync when you reconnect") and the plain offline booking toast are
//             both present in ArrangeVisitModal.tsx, and the cancellation toast
//             is inside a res.queued branch in doBook()
//   (G.4)     Static source assertion: the "not proceeding" offline toast string
//             ("Saved offline — status will update when you reconnect") is present
//             in ArrangeVisitModal.tsx
//   (G.5)     The "not proceeding" offline toast string sits inside a res.queued
//             branch (same technique as G.3 — checks the ~300 chars before it)
//   (G.6)     The plain offline booking toast string sits inside a res.queued
//             branch (same technique as G.3 and G.5)
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:arrange-visit
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:arrange-visit

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const {
  spawnServer,
  waitForServer,
  seedUsers,
  cleanupTestData,
  resetRateLimitStore,
  login,
  makeClient,
  setPool,
  PASSWORD,
  BASE,
} = require('../privileges/harness');

require('dotenv').config();

// ── Fake HubSpot contact stubs ────────────────────────────────────────────────
// contactId → hs_lead_status value returned by the stub GET endpoint.
const CONTACT_STUBS = {
  '111111': 'awaiting_deposit',
  '222222': 'OPEN_DEAL',
  '333333': '',
  '444444': 'DESIGN_INVITED',
};

// Captures the last PATCH sent to the fake HubSpot server so probes can
// assert the correct hs_lead_status was written.
let lastPatch = null;

function startFakeHubspot() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let rawBody = '';
      req.on('data', chunk => { rawBody += chunk; });
      req.on('end', () => {
        const contactMatch = req.url.match(/\/crm\/v3\/objects\/contacts\/(\d+)/);
        if (!contactMatch) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'not found' }));
          return;
        }
        const contactId = contactMatch[1];

        if (req.method === 'GET') {
          const leadStatus = Object.prototype.hasOwnProperty.call(CONTACT_STUBS, contactId)
            ? CONTACT_STUBS[contactId]
            : 'SOME_OTHER_STATUS';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: contactId,
            properties: {
              hs_lead_status: leadStatus,
              firstname: 'Test',
              lastname: 'Contact',
              phone: '01234567890',
              email: 'test@example.com',
              address: '1 Test St',
              city: 'Testville',
              zip: 'TE1 1ST',
            },
          }));
          return;
        }

        if (req.method === 'PATCH') {
          let parsed = null;
          try { parsed = JSON.parse(rawBody); } catch {}
          lastPatch = { contactId, body: parsed };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: contactId, properties: {} }));
          return;
        }

        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'method not allowed' }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
    server.on('error', reject);
  });
}

// ── Fake Google Calendar stub ─────────────────────────────────────────────────
// Handles the googleapis Calendar v3 endpoints so the test can exercise
// GET /api/events (duplicate-guard) and POST /api/events (booking-path) with
// a real request/response cycle but without real Google credentials.
//
// The server captures the last event-insert body so tests can assert that
// fields like `location` and `description` reach the calendar API unchanged.
//
// Server.js activates this stub when:
//   GOOGLE_APIS_BASE_URL  = http://127.0.0.1:<port>/
//   GOOGLE_TEST_TOKENS    = {"access_token":"...", "expiry_date": <far future>}
//   GOOGLE_CLIENT_ID      = test-client-id
//   GOOGLE_CLIENT_SECRET  = test-client-secret
//   GOOGLE_SHARED_CALENDAR_ID = test-calendar-id
function startFakeGoogleCalendar() {
  return new Promise((resolve, reject) => {
    let lastEventInsert = null;

    // A single fixed future event returned for every list request.
    // contactId=444444 is the DESIGN_INVITED stub used in C/D/F tests.
    const FUTURE_EVENT = {
      id: 'gcal-fake-event-1',
      summary: 'Design Visit — Existing Booking',
      status: 'confirmed',
      start: { dateTime: new Date(Date.now() + 86400000).toISOString() },
      end:   { dateTime: new Date(Date.now() + 90000000).toISOString() },
      extendedProperties: {
        private: { moContactId: '444444', moSource: 'measure-once' },
      },
    };

    const server = http.createServer((req, res) => {
      let rawBody = '';
      req.on('data', c => { rawBody += c; });
      req.on('end', () => {
        const url = req.url.split('?')[0];
        const isCalendarPath = url.includes('/calendar/v3/calendars/');

        if (isCalendarPath && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ kind: 'calendar#events', items: [FUTURE_EVENT] }));
          return;
        }

        if (isCalendarPath && req.method === 'POST') {
          let body = null;
          try { body = JSON.parse(rawBody); } catch {}
          lastEventInsert = body;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'gcal-new-fake-event-id',
            htmlLink: 'https://calendar.google.com/fake',
            status: 'confirmed',
            ...(body || {}),
          }));
          return;
        }

        // Catch-all: any other googleapis call (discovery, token info, etc.)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        getLastInsert: () => lastEventInsert,
        clearLastInsert: () => { lastEventInsert = null; },
      });
    });
    server.on('error', reject);
  });
}

// ── Minimal fetch client for a custom base URL ────────────────────────────────
// Used by the Google-auth test section (F) to target the second test server
// (port 5055) while reusing the member session cookie from the first server.
function makeClientAt(base, cookie) {
  async function req(method, urlPath, body) {
    const opts = {
      method,
      headers: {
        Accept: 'application/json',
        'X-Forwarded-Proto': 'https',
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual',
    };
    const res = await fetch(`${base}${urlPath}`, opts);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, text, json };
  }
  return {
    get:  (p)       => req('GET',  p),
    post: (p, body) => req('POST', p, body),
  };
}

// Wait for an Express server to be ready on an arbitrary port.
async function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/turnstile-config`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Server on port ${port} did not start within ${timeoutMs}ms`);
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
  console.log(`\n  arrange-visit E2E  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);

  await cleanupTestData(pool);

  // Start both fake stubs before spawning any Express server so their URLs
  // are known when child processes boot.
  const { server: fakeHs, port: fakeHsPort } = await startFakeHubspot();
  const fakeHsUrl = `http://127.0.0.1:${fakeHsPort}`;
  console.log(`  Fake HubSpot stub on ${fakeHsUrl}`);

  const fakeGcal = await startFakeGoogleCalendar();
  const fakeGcalUrl = `http://127.0.0.1:${fakeGcal.port}/`;
  console.log(`  Fake Google Calendar stub on ${fakeGcalUrl}`);

  const users = await seedUsers(pool, runId);
  console.log(
    `  Seeded users  admin=${users.admin.email}  member=${users.member.email}  viewer=${users.viewer.email}`,
  );

  // ── Server 1: primary (A-E tests, no Google auth) ──────────────────────────
  const { child, logBuf } = spawnServer({
    extraEnv: {
      HUBSPOT_API_URL:      fakeHsUrl,
      HUBSPOT_ACCESS_TOKEN: 'privtest-fake-hs-token',
    },
  });
  let exited  = false;
  let child2  = null;
  let exited2 = false;
  let logBuf2 = [];
  child.on('exit', () => { exited = true; });

  const GCAL_TEST_PORT = 5055;
  const gcalBase = `http://127.0.0.1:${GCAL_TEST_PORT}`;

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

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited)  child.kill('SIGTERM');  } catch {}
    try { if (child2 && !exited2) child2.kill('SIGTERM'); } catch {}
    try { fakeHs.close(); } catch {}
    try { fakeGcal.server.close(); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  };

  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:', e);  cleanupAndExit(2); });
  process.on('unhandledRejection', (e) => { console.error('Unhandled:', e); cleanupAndExit(2); });

  // ── Boot test server 1 (A-E tests) ────────────────────────────────────────
  // Wait for server 1 to be fully up (migrations applied) before spawning
  // server 2, so the two servers don't race on the node-pg-migrate lock.
  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  Server 1 up at ${BASE}`);
  } catch (e) {
    console.error('Server 1 boot failed:', e.message);
    console.error(logBuf.join('').slice(-2000));
    await cleanupAndExit(2);
    return;
  }

  // ── Spawn + boot server 2 (F tests — Google-enabled) ─────────────────────
  // Spawned AFTER server 1 is up so migrations don't race.
  const fakeGoogleTokens = JSON.stringify({
    access_token: 'fake-gcal-test-token',
    token_type: 'Bearer',
    expiry_date: 9999999999000,
  });
  { const s2 = spawnServer({
    extraEnv: {
      PORT:                      String(GCAL_TEST_PORT),
      APP_URL:                   gcalBase,
      HUBSPOT_API_URL:           fakeHsUrl,
      HUBSPOT_ACCESS_TOKEN:      'privtest-fake-hs-token',
      GOOGLE_APIS_BASE_URL:      fakeGcalUrl,
      GOOGLE_TEST_TOKENS:        fakeGoogleTokens,
      GOOGLE_SHARED_CALENDAR_ID: 'test-calendar-id',
      GOOGLE_CLIENT_ID:          'test-client-id',
      GOOGLE_CLIENT_SECRET:      'test-client-secret',
    },
  });
  child2  = s2.child;
  logBuf2 = s2.logBuf;
  child2.on('exit', () => { exited2 = true; }); }

  try {
    await waitForPort(GCAL_TEST_PORT, 25000);
    console.log(`  Server 2 up at ${gcalBase}`);
  } catch (e) {
    console.error('Server 2 boot failed:', e.message);
    console.error(logBuf2.join('').slice(-2000));
    await cleanupAndExit(2);
    return;
  }

  const anonClient   = makeClient(null);
  const viewerClient = await login(users.viewer.email, PASSWORD);
  const memberClient = await login(users.member.email, PASSWORD);

  // ── (auth) Gate checks ─────────────────────────────────────────────────────
  console.log('\n  — auth gate checks —');

  {
    const r = await anonClient.post('/api/card-actions/arrange-visit', { contactId: '111111' });
    record(
      '(auth.1) Unauthenticated POST /api/card-actions/arrange-visit → 401',
      '401', String(r.status), r.status === 401,
    );
  }
  {
    const r = await anonClient.post('/api/card-actions/arrange-visit/outcome',
      { contactId: '111111', outcome: 'booked', visitType: 'design' });
    record(
      '(auth.2) Unauthenticated POST /api/card-actions/arrange-visit/outcome → 401',
      '401', String(r.status), r.status === 401,
    );
  }
  {
    const r = await viewerClient.post('/api/card-actions/arrange-visit', { contactId: '111111' });
    record(
      '(auth.3) Viewer POST /api/card-actions/arrange-visit → 403',
      '403', String(r.status), r.status === 403,
    );
  }
  {
    const r = await viewerClient.post('/api/card-actions/arrange-visit/outcome',
      { contactId: '111111', outcome: 'booked', visitType: 'design' });
    record(
      '(auth.4) Viewer POST /api/card-actions/arrange-visit/outcome → 403',
      '403', String(r.status), r.status === 403,
    );
  }

  // ── (A) visitType determination ────────────────────────────────────────────
  console.log('\n  — visitType determination (A) —');

  {
    const r = await memberClient.post('/api/card-actions/arrange-visit', { contactId: '111111' });
    const visitType = r.json?.visitType;
    record(
      '(A.1) hs_lead_status=awaiting_deposit → visitType=survey',
      'survey', String(visitType),
      r.status === 200 && visitType === 'survey',
      r.status !== 200 ? `HTTP ${r.status}: ${r.text}` : '',
    );
  }
  {
    const r = await memberClient.post('/api/card-actions/arrange-visit', { contactId: '222222' });
    const visitType = r.json?.visitType;
    record(
      '(A.2) hs_lead_status=OPEN_DEAL → visitType=design',
      'design', String(visitType),
      r.status === 200 && visitType === 'design',
      r.status !== 200 ? `HTTP ${r.status}: ${r.text}` : '',
    );
  }
  {
    const r = await memberClient.post('/api/card-actions/arrange-visit', { contactId: '333333' });
    const visitType = r.json?.visitType;
    record(
      '(A.3) hs_lead_status=empty → visitType=design',
      'design', String(visitType),
      r.status === 200 && visitType === 'design',
      r.status !== 200 ? `HTTP ${r.status}: ${r.text}` : '',
    );
  }
  {
    const r = await memberClient.post('/api/card-actions/arrange-visit', { contactId: 'not-an-id' });
    record(
      '(A.bad) Non-numeric contactId → 400',
      '400', String(r.status), r.status === 400,
    );
  }

  // ── (B) Outcome → HubSpot status mapping ──────────────────────────────────
  console.log('\n  — outcome → HubSpot status mapping (B) —');

  // Note: hw_lead_substatus helpers were removed from server.js.
  // These tests verify only hs_lead_status (the parent field).
  const OUTCOME_CASES = [
    { outcome: 'booked',         visitType: 'survey', expectedLeadStatus: 'SURVEY_SCHEDULED' },
    { outcome: 'booked',         visitType: 'design', expectedLeadStatus: 'DESIGN_SCHEDULED' },
    { outcome: 'email_sent',     visitType: 'survey', expectedLeadStatus: 'SURVEY_SCHEDULED' },
    { outcome: 'email_sent',     visitType: 'design', expectedLeadStatus: 'DESIGN_INVITED'   },
    { outcome: 'not_proceeding', visitType: 'survey', expectedLeadStatus: 'NOT_SUITABLE'      },
    { outcome: 'not_proceeding', visitType: 'design', expectedLeadStatus: 'NOT_SUITABLE'      },
  ];

  for (const { outcome, visitType, expectedLeadStatus } of OUTCOME_CASES) {
    lastPatch = null;
    const r = await memberClient.post('/api/card-actions/arrange-visit/outcome', {
      contactId: '111111',
      outcome,
      visitType,
    });
    // The route responds with { ok: true, hs_lead_status } and also PATCHes HubSpot.
    // Verify both the response body and the values sent to the fake stub.
    const responseLeadStatus = r.json?.hs_lead_status;
    const patchedLeadStatus  = lastPatch?.body?.properties?.hs_lead_status;
    const ok = r.status === 200
      && r.json?.ok === true
      && responseLeadStatus === expectedLeadStatus
      && patchedLeadStatus  === expectedLeadStatus;
    record(
      `(B) outcome=${outcome} visitType=${visitType} → hs_lead_status=${expectedLeadStatus}`,
      `200 ok=true hs_lead_status=${expectedLeadStatus} patched_lead=${expectedLeadStatus}`,
      `HTTP ${r.status} hs_lead_status=${responseLeadStatus} patched_lead=${patchedLeadStatus}`,
      ok,
      r.status !== 200 ? r.text : '',
    );
  }

  {
    const r = await memberClient.post('/api/card-actions/arrange-visit/outcome', {
      contactId: '111111',
      outcome: 'invalid_outcome',
      visitType: 'design',
    });
    record(
      '(B.bad) outcome=invalid_outcome → 400',
      '400', String(r.status), r.status === 400,
    );
  }

  // ── (C) leadStatus field in arrange-visit response ─────────────────────────
  console.log('\n  — leadStatus in arrange-visit response (C) —');

  {
    const r = await memberClient.post('/api/card-actions/arrange-visit', { contactId: '444444' });
    const leadStatus = r.json?.leadStatus;
    record(
      '(C.1) DESIGN_INVITED contact → leadStatus=DESIGN_INVITED returned',
      'DESIGN_INVITED', String(leadStatus),
      r.status === 200 && leadStatus === 'DESIGN_INVITED',
      r.status !== 200 ? `HTTP ${r.status}: ${r.text}` : '',
    );
  }
  {
    const r = await memberClient.post('/api/card-actions/arrange-visit', { contactId: '333333' });
    const leadStatus = r.json?.leadStatus;
    record(
      '(C.2) Empty lead status contact → leadStatus="" returned',
      '', String(leadStatus ?? ''),
      r.status === 200 && (leadStatus === '' || leadStatus === null || leadStatus === undefined),
      r.status !== 200 ? `HTTP ${r.status}: ${r.text}` : '',
    );
  }

  // ── (D) Calendar event endpoints gate correctly without Google auth ─────────
  console.log('\n  — calendar event endpoints without Google auth (D) —');

  {
    const r = await memberClient.get('/api/events?contactId=444444');
    record(
      '(D.1) GET /api/events?contactId without Google auth → 401 GOOGLE_AUTH',
      '401', String(r.status),
      r.status === 401 && r.json?.code === 'GOOGLE_AUTH',
      r.status !== 401 ? `HTTP ${r.status}: ${r.text}` : '',
    );
  }
  {
    const r = await memberClient.post('/api/events', {
      summary: 'Design visit — Test Contact',
      description: 'Some notes',
      location: '1 Test St, Testville',
      start: { dateTime: new Date(Date.now() + 3600000).toISOString() },
      end:   { dateTime: new Date(Date.now() + 7200000).toISOString() },
    });
    record(
      '(D.2) POST /api/events without Google auth → 401 GOOGLE_AUTH',
      '401', String(r.status),
      r.status === 401 && r.json?.code === 'GOOGLE_AUTH',
      r.status !== 401 ? `HTTP ${r.status}: ${r.text}` : '',
    );
  }
  {
    const r = await anonClient.post('/api/events', {
      summary: 'Design visit — Test Contact',
      start: { dateTime: new Date(Date.now() + 3600000).toISOString() },
      end:   { dateTime: new Date(Date.now() + 7200000).toISOString() },
    });
    record(
      '(D.3) POST /api/events unauthenticated → 401',
      '401', String(r.status),
      r.status === 401,
    );
  }

  // ── (E) DESIGN_INVITED outcome=booked → DESIGN_SCHEDULED, no substatus ─────
  console.log('\n  — DESIGN_INVITED confirm-appointment path (E) —');

  {
    lastPatch = null;
    const r = await memberClient.post('/api/card-actions/arrange-visit/outcome', {
      contactId: '444444',
      outcome: 'booked',
      visitType: 'design',
    });
    const responseLeadStatus  = r.json?.hs_lead_status;
    const patchedLeadStatus   = lastPatch?.body?.properties?.hs_lead_status;
    const patchedSubStatus    = lastPatch?.body?.properties?.hw_lead_substatus;
    const ok = r.status === 200
      && r.json?.ok === true
      && responseLeadStatus === 'DESIGN_SCHEDULED'
      && patchedLeadStatus  === 'DESIGN_SCHEDULED'
      && patchedSubStatus   === undefined;
    record(
      '(E.1) outcome=booked visitType=design → DESIGN_SCHEDULED, no substatus in HubSpot patch',
      '200 ok=true hs_lead_status=DESIGN_SCHEDULED patched=DESIGN_SCHEDULED substatus=undefined',
      `HTTP ${r.status} ok=${r.json?.ok} hs_lead_status=${responseLeadStatus} patched=${patchedLeadStatus} substatus=${patchedSubStatus}`,
      ok,
      r.status !== 200 ? r.text : '',
    );
  }

  // ── (F) Google Calendar integration — duplicate guard + event payload ────────
  // Uses server 2 (Google-enabled) with a fake Google Calendar stub so the full
  // server-side path is exercised end-to-end without real credentials.
  //
  // The session cookie from the member's server-1 login is reused — both servers
  // share the same DB and SESSION_SECRET.
  console.log('\n  — Google Calendar with fake stub (F) —');

  const gcalMemberClient = makeClientAt(gcalBase, memberClient.cookie);

  // (F.1) GET /api/events?contactId returns future events
  // This is the server path the React modal's duplicate-visit guard calls. When
  // Google is connected it must return an events list so the modal can decide
  // whether to show the duplicate-confirm dialog.
  {
    const r = await gcalMemberClient.get('/api/events?contactId=444444');
    const items = r.json?.items;
    const hasItem = Array.isArray(items) && items.length > 0;
    record(
      '(F.1) GET /api/events?contactId with Google connected → 200 with items array',
      '200 items.length>=1',
      `HTTP ${r.status} items=${JSON.stringify(items?.length ?? r.text)}`,
      r.status === 200 && hasItem,
      r.status !== 200 ? `HTTP ${r.status}: ${r.text}` : '',
    );
  }

  // (F.2) POST /api/events passes location + description to Google Calendar
  // This is the server path called by ArrangeVisitModal.doBook() after a
  // successful booking. It verifies the event body (address → location,
  // visit notes → description) passes through to the calendar API unchanged.
  {
    fakeGcal.clearLastInsert();
    const eventStart = new Date(Date.now() + 3600000).toISOString();
    const eventEnd   = new Date(Date.now() + 7200000).toISOString();
    const r = await gcalMemberClient.post('/api/events', {
      summary:     'Design Visit — Test Contact',
      description: 'Notes from the booking form',
      location:    '1 Test St, Testville, TE1 1ST',
      start:       { dateTime: eventStart },
      end:         { dateTime: eventEnd },
      moContactId: '444444',
      moVisitType: 'design',
    });
    const inserted = fakeGcal.getLastInsert();
    const locationOk     = inserted?.location    === '1 Test St, Testville, TE1 1ST';
    const descriptionOk  = inserted?.description === 'Notes from the booking form';
    const extPropOk      = inserted?.extendedProperties?.private?.moContactId === '444444';
    const ok = r.status === 200 && locationOk && descriptionOk && extPropOk;
    record(
      '(F.2) POST /api/events passes location + description to Google Calendar body',
      '200 location="1 Test St…" description="Notes…" moContactId=444444',
      `HTTP ${r.status} location=${inserted?.location} description=${inserted?.description} moContactId=${inserted?.extendedProperties?.private?.moContactId}`,
      ok,
      r.status !== 200 ? `HTTP ${r.status}: ${r.text}` : (ok ? '' : `inserted=${JSON.stringify(inserted)}`),
    );
  }

  // ── (G) Static source assertions — offline-booking toast strings ────────────
  // The offline cancellation toast is a purely frontend concern: ArrangeVisitModal
  // calls showToast() inside the `if (res.queued)` branch of doBook().  No server
  // or browser is needed to guard it — a source-text assertion is the right tool.
  //
  // (G.1) When doBook() is called with a cancelledEvent while the queue is active
  //       the toast must read the combined cancellation+offline message.
  // (G.2) When doBook() is called without a cancelledEvent while queued, the
  //       plain offline booking toast must be present (sibling branch guard).
  console.log('\n  — offline-booking toast strings (G, static) —');

  {
    const modalSrc = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'react', 'components', 'modals', 'ArrangeVisitModal.tsx'),
      'utf8',
    );

    const CANCELLED_TOAST =
      'Existing visit cancelled \u2014 new booking saved offline and will sync when you reconnect';
    const PLAIN_OFFLINE_TOAST = 'Booking saved offline \u2014 it will sync when you reconnect';

    const hasCancelledToast = modalSrc.includes(CANCELLED_TOAST);
    record(
      '(G.1) doBook queued+cancelledEvent → offline-cancellation toast string present in source',
      `"${CANCELLED_TOAST}"`,
      hasCancelledToast ? 'found' : 'NOT FOUND',
      hasCancelledToast,
    );

    const hasPlainToast = modalSrc.includes(PLAIN_OFFLINE_TOAST);
    record(
      '(G.2) doBook queued+no-cancelledEvent → plain offline-booking toast string present in source',
      `"${PLAIN_OFFLINE_TOAST}"`,
      hasPlainToast ? 'found' : 'NOT FOUND',
      hasPlainToast,
    );

    // Confirm both strings sit inside the same if (res.queued) block in doBook.
    // We look for the controlling branch text in the ~300 chars before the
    // cancellation-toast string so a copy-paste to a different branch is caught.
    const cancelledIdx  = modalSrc.indexOf(CANCELLED_TOAST);
    const contextBefore = cancelledIdx >= 0 ? modalSrc.slice(Math.max(0, cancelledIdx - 300), cancelledIdx) : '';
    const inQueuedBranch = contextBefore.includes('res.queued');
    record(
      '(G.3) offline-cancellation toast is inside a res.queued branch in doBook',
      'res.queued in preceding context',
      inQueuedBranch ? 'res.queued found' : 'res.queued NOT found in context',
      inQueuedBranch,
    );

    const NOT_PROCEEDING_TOAST = 'Saved offline \u2014 status will update when you reconnect';
    const hasNotProceedingToast = modalSrc.includes(NOT_PROCEEDING_TOAST);
    record(
      '(G.4) not-proceeding queued path → offline toast string present in source',
      `"${NOT_PROCEEDING_TOAST}"`,
      hasNotProceedingToast ? 'found' : 'NOT FOUND',
      hasNotProceedingToast,
    );

    const notProceedingIdx     = modalSrc.indexOf(NOT_PROCEEDING_TOAST);
    const npContextBefore      = notProceedingIdx >= 0 ? modalSrc.slice(Math.max(0, notProceedingIdx - 300), notProceedingIdx) : '';
    const npInQueuedBranch     = npContextBefore.includes('res.queued');
    record(
      '(G.5) not-proceeding offline toast is inside a res.queued branch',
      'res.queued in preceding context',
      npInQueuedBranch ? 'res.queued found' : 'res.queued NOT found in context',
      npInQueuedBranch,
    );

    const plainIdx         = modalSrc.indexOf(PLAIN_OFFLINE_TOAST);
    const plainCtxBefore   = plainIdx >= 0 ? modalSrc.slice(Math.max(0, plainIdx - 300), plainIdx) : '';
    const plainInQueuedBranch = plainCtxBefore.includes('res.queued');
    record(
      '(G.6) plain offline booking toast is inside a res.queued branch',
      'res.queued in preceding context',
      plainInQueuedBranch ? 'res.queued found' : 'res.queued NOT found in context',
      plainInQueuedBranch,
    );
  }

  // ── Summary + report ───────────────────────────────────────────────────────
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  console.log(`\n  ${passed} passed, ${failed} failed`);

  await writeReport(runId, findings);
  await cleanupAndExit(failed > 0 ? 1 : 0);
}

// ── Report writer ─────────────────────────────────────────────────────────────
async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const total   = findings.filter(f => !f.skipped).length;
  const nPassed = findings.filter(f => f.ok).length;
  const nFailed = findings.filter(f => !f.ok && !f.skipped).length;
  const lines = [
    '# arrange_visit — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:arrange-visit\``,
    '',
    '## Summary',
    '',
    `- Passed: ${nPassed} / ${total}`,
    `- Failed: ${nFailed} / ${total}`,
    `- Skipped: ${findings.filter(f => f.skipped).length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`,
    ),
    '',
    '## Coverage',
    '',
    '- **(auth.1-2)** Unauthenticated POST to both arrange-visit routes → 401.',
    '  Guards the global `isAuthenticated` gate.',
    '- **(auth.3-4)** Viewer POST to both routes → 403.',
    '  Guards `requirePrivilege("member")` — viewer is below the member threshold.',
    '- **(A.1)** `hs_lead_status="awaiting_deposit"` → `visitType="survey"`.',
    '  Exercises the exact branch condition in the route handler.',
    '- **(A.2-3)** Any other or empty `hs_lead_status` → `visitType="design"`.',
    '  Guards the else branch and the empty-string edge case.',
    '- **(A.bad)** Non-numeric `contactId` → 400.',
    '  Guards the `!/^\\d+$/.test(contactId)` input validation.',
    '- **(B.1-6)** All six valid outcome × visitType combinations map to the',
    '  correct HubSpot `hs_lead_status` value. Both the JSON response body and the',
    '  PATCH sent to HubSpot are verified. (Note: `hw_lead_substatus` helpers were',
    '  removed from server.js; only the parent `hs_lead_status` field is tested.)',
    '- **(B.bad)** Unknown `outcome` value → 400.',
    '  Guards the `OUTCOME_STATUS[outcome]` lookup validation.',
    '- **(C.1)** `DESIGN_INVITED` contact → `leadStatus="DESIGN_INVITED"` in response.',
    '  Guards the new `leadStatus` field added to the arrange-visit execute response.',
    '- **(C.2)** Empty lead status → `leadStatus=""` in response (raw property forwarded).',
    '- **(D.1)** `GET /api/events?contactId` without Google auth → 401 GOOGLE_AUTH.',
    '  Used by the duplicate-visit guard in the React modal to check for existing events.',
    '- **(D.2)** `POST /api/events` without Google auth → 401 GOOGLE_AUTH.',
    '  Guards the calendar-event creation that runs after a successful booking.',
    '- **(D.3)** `POST /api/events` unauthenticated → 401.',
    '  Guards the `isAuthenticated` middleware on the events route.',
    '- **(E.1)** outcome=booked visitType=design → `DESIGN_SCHEDULED` with no `hw_lead_substatus` in PATCH.',
    '  Confirms the confirm-appointment path sets only the parent lead status, no substatus side-effect.',
    '- **(F.1)** `GET /api/events?contactId` with Google connected → 200 with items array.',
    '  Exercises the full server path used by the React modal duplicate-visit guard. When Google is',
    '  connected, the route returns a list of future calendar events so the modal can detect conflicts.',
    '  Uses a fake Google Calendar stub (GOOGLE_APIS_BASE_URL + GOOGLE_TEST_TOKENS) on a second',
    '  Express instance (port 5055) so no real Google credentials are needed.',
    '- **(F.2)** `POST /api/events` with location + description → Google Calendar receives those fields.',
    '  Exercises the booking-path calendar event creation called by `ArrangeVisitModal.doBook()`.',
    '  Verifies that the formatted address (→ `location`) and visit notes (→ `description`) from the',
    '  React form are forwarded unchanged through the server route to the calendar API.',
    '  Also confirms `moContactId` is set as an extendedProperty (enables contactId-based event lookup).',
    '- **(G.1)** Static source assertion: the offline cancellation toast string',
    '  (`"Existing visit cancelled — new booking saved offline and will sync when you reconnect"`)',
    '  is present in `ArrangeVisitModal.tsx`. Guards against accidental edits to the toast copy.',
    '- **(G.2)** Static source assertion: the plain offline booking toast',
    '  (`"Booking saved offline — it will sync when you reconnect"`) is present in',
    '  `ArrangeVisitModal.tsx`. Guards the sibling `!cancelledEvent` branch of the queued path.',
    '- **(G.3)** The offline cancellation toast string sits inside a `res.queued` branch in `doBook()`.',
    '  Guards against the string being moved to an unrelated branch by a refactor.',
    '- **(G.4)** Static source assertion: the "not proceeding" offline toast string',
    '  (`"Saved offline — status will update when you reconnect"`) is present in',
    '  `ArrangeVisitModal.tsx`. Guards against accidental edits to the toast copy in the',
    '  queued path of the "not proceeding" outcome handler.',
    '- **(G.5)** The "not proceeding" offline toast string sits inside a `res.queued` branch.',
    '  Guards against the string being moved outside the queued branch by a refactor',
    '  (same technique as G.3 — checks ~300 chars of preceding source context).',
    '- **(G.6)** The plain offline booking toast string sits inside a `res.queued` branch.',
    '  Guards against the string being moved outside the queued branch by a refactor',
    '  (same technique as G.3 and G.5 — checks ~300 chars of preceding source context).',
  ];
  const outPath = path.join(dir, 'arrange-visit.md');
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`  Report written to ${outPath}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(2);
});
