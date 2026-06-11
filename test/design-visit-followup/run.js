'use strict';
// test/design-visit-followup/run.js
//
// End-to-end backend test for the design_visit_followup card-action handler routes.
// Boots a disposable Express server with a fake HubSpot stub so route logic
// can be exercised without real HubSpot credentials.
//
// Covers:
//   (auth.1)  Unauthenticated POST /api/card-actions/design-visit-followup → 401
//   (auth.2)  Unauthenticated POST /api/card-actions/design-visit-followup/outcome → 401
//   (auth.3)  Viewer POST /api/card-actions/design-visit-followup → 403
//   (auth.4)  Viewer POST /api/card-actions/design-visit-followup/outcome → 403
//   (A.1)     Valid contactId → returns contact fields
//   (A.bad)   Non-numeric contactId → 400
//   (B.1)     outcome=confirmed → hs_lead_status=DESIGN_SCHEDULED
//   (B.2)     outcome=invite_resent → hs_lead_status=DESIGN_INVITED
//   (B.3)     outcome=not_proceeding → hs_lead_status=NOT_SUITABLE
//   (B.bad)   Unknown outcome → 400
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:design-visit-followup
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:design-visit-followup

const fs   = require('fs');
const path = require('path');
const http = require('http');

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

// ── Fake HubSpot stub ─────────────────────────────────────────────────────────

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
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: contactId,
            properties: {
              hs_lead_status: 'DESIGN_INVITED',
              firstname:      'Jane',
              lastname:       'Smith',
              email:          'jane@example.com',
              phone:          '07700 900123',
              mobilephone:    '',
              address:        '14 Oak Street',
              city:           'London',
              zip:            'SW1A 1AA',
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

  // Start fake HubSpot
  const { server: fakeHs, port: fakeHsPort } = await startFakeHubspot();
  const fakeHsUrl = `http://127.0.0.1:${fakeHsPort}`;
  console.log(`  Fake HubSpot stub on ${fakeHsUrl}`);

  process.env.HUBSPOT_API_URL  = fakeHsUrl;
  process.env.HUBSPOT_API_KEY  = 'fake-key-for-test';
  process.env.DATABASE_URL     = connStr;

  // Boot the Express server
  const { server: appServer, pool } = await spawnServer();
  setPool(pool);
  await waitForServer(BASE);

  // Seed test users
  await seedUsers(pool);
  resetRateLimitStore();

  const findings = [];
  const runId    = `dvf-${Date.now()}`;

  function record(name, expected, observed, ok, note = '') {
    findings.push({ name, expected, observed, ok, skipped: false });
    const icon = ok ? '✔' : '✘';
    const line = `  ${icon} ${name}${note ? `\n      note: ${note}` : ''}`;
    console.log(line);
  }

  // ── Clients ────────────────────────────────────────────────────────────────

  const anonClient   = makeClient(null);
  let memberSession  = null;
  let viewerSession  = null;
  let memberClient;
  let viewerClient;

  {
    memberSession = await login('member@test.local', PASSWORD);
    memberClient  = makeClient(memberSession);
  }
  {
    viewerSession = await login('viewer@test.local', PASSWORD);
    viewerClient  = makeClient(viewerSession);
  }

  // ── (auth) Auth gate tests ─────────────────────────────────────────────────
  console.log('\n  — auth gates —');

  {
    const r = await anonClient.post('/api/card-actions/design-visit-followup', { contactId: '111111' });
    record('(auth.1) Unauthenticated → 401', '401', String(r.status), r.status === 401);
  }
  {
    const r = await anonClient.post('/api/card-actions/design-visit-followup/outcome', { contactId: '111111', outcome: 'confirmed' });
    record('(auth.2) Unauthenticated outcome → 401', '401', String(r.status), r.status === 401);
  }
  {
    const r = await viewerClient.post('/api/card-actions/design-visit-followup', { contactId: '111111' });
    record('(auth.3) Viewer init → 403', '403', String(r.status), r.status === 403);
  }
  {
    const r = await viewerClient.post('/api/card-actions/design-visit-followup/outcome', { contactId: '111111', outcome: 'confirmed' });
    record('(auth.4) Viewer outcome → 403', '403', String(r.status), r.status === 403);
  }

  // ── (A) Init route ─────────────────────────────────────────────────────────
  console.log('\n  — init route (A) —');

  {
    const r = await memberClient.post('/api/card-actions/design-visit-followup', { contactId: '111111' });
    const ok = r.status === 200
      && typeof r.json?.contactName  === 'string'
      && typeof r.json?.contactEmail === 'string';
    record(
      '(A.1) Valid contactId → contact info returned',
      '200 contactName+contactEmail present',
      `HTTP ${r.status} contactName=${r.json?.contactName} contactEmail=${r.json?.contactEmail}`,
      ok,
      r.status !== 200 ? r.text : '',
    );
  }
  {
    const r = await memberClient.post('/api/card-actions/design-visit-followup', { contactId: 'not-an-id' });
    record('(A.bad) Non-numeric contactId → 400', '400', String(r.status), r.status === 400);
  }

  // ── (B) Outcome route ──────────────────────────────────────────────────────
  console.log('\n  — outcome route (B) —');

  const OUTCOME_CASES = [
    { outcome: 'confirmed',      expectedLeadStatus: 'DESIGN_SCHEDULED' },
    { outcome: 'invite_resent',  expectedLeadStatus: 'DESIGN_INVITED' },
    { outcome: 'not_proceeding', expectedLeadStatus: 'NOT_SUITABLE' },
  ];

  for (const { outcome, expectedLeadStatus } of OUTCOME_CASES) {
    lastPatch = null;
    const r = await memberClient.post('/api/card-actions/design-visit-followup/outcome', {
      contactId: '111111',
      outcome,
    });
    const responseLeadStatus = r.json?.hs_lead_status;
    const patchedLeadStatus  = lastPatch?.body?.properties?.hs_lead_status;
    const ok = r.status === 200
      && r.json?.ok === true
      && responseLeadStatus === expectedLeadStatus
      && patchedLeadStatus  === expectedLeadStatus;
    record(
      `(B) outcome=${outcome} → hs_lead_status=${expectedLeadStatus}`,
      `200 ok=true hs_lead_status=${expectedLeadStatus} patched=${expectedLeadStatus}`,
      `HTTP ${r.status} hs_lead_status=${responseLeadStatus} patched=${patchedLeadStatus}`,
      ok,
      r.status !== 200 ? r.text : '',
    );
  }

  {
    const r = await memberClient.post('/api/card-actions/design-visit-followup/outcome', {
      contactId: '111111',
      outcome: 'invalid_outcome',
    });
    record('(B.bad) Unknown outcome → 400', '400', String(r.status), r.status === 400);
  }

  // ── Summary + cleanup ──────────────────────────────────────────────────────
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  console.log(`\n  ${passed} passed, ${failed} failed`);

  await writeReport(runId, findings);

  await cleanupTestData(pool);
  fakeHs.close();
  appServer.close();
  pool.end();

  process.exit(failed > 0 ? 1 : 0);
}

// ── Report ─────────────────────────────────────────────────────────────────────

async function writeReport(runId, findings) {
  const dir = path.resolve(__dirname, '..', '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const total   = findings.filter(f => !f.skipped).length;
  const nPassed = findings.filter(f => f.ok).length;
  const nFailed = findings.filter(f => !f.ok && !f.skipped).length;
  const lines = [
    '# design_visit_followup — E2E Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:design-visit-followup\``,
    '',
    '## Summary',
    '',
    `- Passed: ${nPassed} / ${total}`,
    `- Failed: ${nFailed} / ${total}`,
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
    '- **(auth.1-2)** Unauthenticated → 401.',
    '- **(auth.3-4)** Viewer → 403 (requirePrivilege("member") gate).',
    '- **(A.1)** Valid contactId returns contact fields from HubSpot stub.',
    '- **(A.bad)** Non-numeric contactId → 400 input validation.',
    '- **(B.1-3)** All three valid outcomes map to the correct hs_lead_status;',
    '  both the response body and the HubSpot PATCH payload are verified.',
    '- **(B.bad)** Unknown outcome → 400.',
  ];
  const outPath = path.join(dir, 'design-visit-followup.md');
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`  Report written to ${outPath}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(2);
});
