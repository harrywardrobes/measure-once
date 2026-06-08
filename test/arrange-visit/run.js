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

  // Start the fake HubSpot stub before spawning the Express server so the
  // HUBSPOT_API_URL env var is already known when the child boots.
  const { server: fakeHs, port: fakeHsPort } = await startFakeHubspot();
  const fakeHsUrl = `http://127.0.0.1:${fakeHsPort}`;
  console.log(`  Fake HubSpot stub on ${fakeHsUrl}`);

  const users = await seedUsers(pool, runId);
  console.log(
    `  Seeded users  admin=${users.admin.email}  member=${users.member.email}  viewer=${users.viewer.email}`,
  );

  const { child, logBuf } = spawnServer({
    extraEnv: {
      HUBSPOT_API_URL:      fakeHsUrl,
      HUBSPOT_ACCESS_TOKEN: 'privtest-fake-hs-token',
    },
  });
  let exited = false;
  child.on('exit', () => { exited = true; });

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
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { fakeHs.close(); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    process.exit(code);
  };

  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  (e) => { console.error('Uncaught:', e);  cleanupAndExit(2); });
  process.on('unhandledRejection', (e) => { console.error('Unhandled:', e); cleanupAndExit(2); });

  // ── Boot test server ───────────────────────────────────────────────────────
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

  const OUTCOME_CASES = [
    { outcome: 'booked',         visitType: 'survey', expectedLeadStatus: 'SURVEY_SCHEDULED', expectedSubStatus: 'SURVEY_SCHEDULED__SRSC_AGREED' },
    { outcome: 'booked',         visitType: 'design', expectedLeadStatus: 'DESIGN_SCHEDULED', expectedSubStatus: 'DESIGN_SCHEDULED__DSSC_AGREED' },
    { outcome: 'email_sent',     visitType: 'survey', expectedLeadStatus: 'SURVEY_SCHEDULED', expectedSubStatus: 'SURVEY_SCHEDULED__SRSC_SUGGESTED' },
    { outcome: 'email_sent',     visitType: 'design', expectedLeadStatus: 'DESIGN_SCHEDULED', expectedSubStatus: 'DESIGN_SCHEDULED__DSSC_SUGGESTED' },
    { outcome: 'not_proceeding', visitType: 'survey', expectedLeadStatus: 'NOT_SUITABLE',      expectedSubStatus: '' },
    { outcome: 'not_proceeding', visitType: 'design', expectedLeadStatus: 'NOT_SUITABLE',      expectedSubStatus: '' },
  ];

  for (const { outcome, visitType, expectedLeadStatus, expectedSubStatus } of OUTCOME_CASES) {
    lastPatch = null;
    const r = await memberClient.post('/api/card-actions/arrange-visit/outcome', {
      contactId: '111111',
      outcome,
      visitType,
    });
    // The route responds with { ok: true, hs_lead_status, hw_lead_substatus } and also PATCHes HubSpot.
    // Verify both the response body and the values sent to the fake stub.
    const responseLeadStatus = r.json?.hs_lead_status;
    const responseSubStatus  = r.json?.hw_lead_substatus;
    const patchedLeadStatus  = lastPatch?.body?.properties?.hs_lead_status;
    const patchedSubStatus   = lastPatch?.body?.properties?.hw_lead_substatus;
    const ok = r.status === 200
      && r.json?.ok === true
      && responseLeadStatus === expectedLeadStatus
      && responseSubStatus  === expectedSubStatus
      && patchedLeadStatus  === expectedLeadStatus
      && patchedSubStatus   === expectedSubStatus;
    record(
      `(B) outcome=${outcome} visitType=${visitType} → hs_lead_status=${expectedLeadStatus} hw_lead_substatus=${expectedSubStatus}`,
      `200 ok=true hs_lead_status=${expectedLeadStatus} hw_lead_substatus=${expectedSubStatus} patched_lead=${expectedLeadStatus} patched_sub=${expectedSubStatus}`,
      `HTTP ${r.status} hs_lead_status=${responseLeadStatus} hw_lead_substatus=${responseSubStatus} patched_lead=${patchedLeadStatus} patched_sub=${patchedSubStatus}`,
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
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
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
    '  correct HubSpot `hs_lead_status` (parent) and `hw_lead_substatus` (sub-status)',
    '  values. Both the JSON response and the values actually sent in the PATCH body',
    '  to HubSpot are verified for both properties.',
    '- **(B.bad)** Unknown `outcome` value → 400.',
    '  Guards the `OUTCOME_STATUS[outcome]` lookup validation.',
  ];
  const outPath = path.join(dir, 'arrange-visit.md');
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`  Report written to ${outPath}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(2);
});
