'use strict';
// test/phone-directory/run-customers.js
//
// Supplementary integration test for GET /api/admin/phone-directory —
// customers section.
//
// The base phone-directory test (run.js) always sees an empty customers array
// because the privileges harness strips HUBSPOT_TOKEN.  This script starts a
// local mock HubSpot server seeded with two fake contacts and confirms that:
//
//   (C1) phone field maps to a customers entry with
//        { contactId, label, field: 'phone', phone }.
//   (C2) mobilephone field maps to a customers entry with field: 'mobilephone'.
//   (C3) A contact with both phone AND mobilephone produces two separate entries.
//   (C4) A contact with no name falls back to email or "Contact <id>" as label.
//   (C5) A contact with no phone fields produces no customers entries.
//   (C6) customers is a non-empty array when HUBSPOT_TOKEN is set and the mock
//        returns valid contacts.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:phone-directory-customers
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:phone-directory-customers

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

require('dotenv').config();

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'phone-directory-customers.md',
);

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

function writeReport(runId) {
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  const rows = findings.map(f =>
    `| ${f.ok ? '✅' : '❌'} | ${f.name} | ${f.expected} | ${f.observed} |`,
  ).join('\n');
  const md = [
    `# phone-directory-customers test report`,
    ``,
    `run: \`${runId}\`  date: ${new Date().toISOString()}`,
    ``,
    `**${passed} passed / ${failed} failed**`,
    ``,
    `| | Test | Expected | Observed |`,
    `|---|---|---|---|`,
    rows,
  ].join('\n');
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, md, 'utf8');
  console.log(`\n  Report written to ${REPORT_PATH}`);
}

// ── Mock HubSpot contacts fixture ─────────────────────────────────────────────
//
// Four contacts covering distinct mapping paths in the phone-directory handler:
//
//   HS_A — firstname + lastname + phone only       → 1 customers entry (phone)
//   HS_B — firstname only + phone + mobilephone    → 2 customers entries
//   HS_C — no name, email only + phone             → 1 entry, label = email
//   HS_D — firstname only, no phone fields at all  → 0 entries (should not appear)

const HS_A = {
  id: 'privtest-phonedir-hs-a',
  properties: {
    firstname:   'Alpha',
    lastname:    'Customer',
    email:       'alpha@privtest.invalid',
    phone:       '555-0101',
    mobilephone: '',
  },
};
const HS_B = {
  id: 'privtest-phonedir-hs-b',
  properties: {
    firstname:   'Beta',
    lastname:    '',
    email:       'beta@privtest.invalid',
    phone:       '555-0102',
    mobilephone: '555-0103',
  },
};
const HS_C = {
  id: 'privtest-phonedir-hs-c',
  properties: {
    firstname:   '',
    lastname:    '',
    email:       'gamma@privtest.invalid',
    phone:       '555-0104',
    mobilephone: '',
  },
};
const HS_D = {
  id: 'privtest-phonedir-hs-d',
  properties: {
    firstname:   'Delta',
    lastname:    'NoPhone',
    email:       'delta@privtest.invalid',
    phone:       '',
    mobilephone: '',
  },
};

const CONTACTS_SEARCH_SUCCESS = {
  results: [HS_A, HS_B, HS_C, HS_D],
  paging: null,
};

// ── Mock HubSpot server ───────────────────────────────────────────────────────
// Handles POST /crm/v3/objects/contacts/search.  Crucially, the mock parses
// the `properties` list from the request body and filters each contact's
// properties object to only the fields that were actually requested.  This
// makes the test fail for real if `fetchAllContactsShared` omits a property
// from ALL_CONTACTS_PROPERTIES — the contact entry won't carry that field and
// the mapping assertions below will catch the gap.

function startMockHubspot() {
  // { method, url, requestedProperties, at } — one entry per search call.
  const calls = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const url = req.url.split('?')[0];

      if (req.method === 'POST' && url === '/crm/v3/objects/contacts/search') {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch {}
        const requestedProps = Array.isArray(body.properties) ? body.properties : [];

        // Filter each contact's properties to only the requested fields.
        // An empty requestedProps list means the server requested nothing, so
        // nothing is returned — which causes the field-presence assertions to
        // fail and surfaces the gap immediately.
        const filteredResults = CONTACTS_SEARCH_SUCCESS.results.map(c => ({
          id: c.id,
          properties: requestedProps.length > 0
            ? Object.fromEntries(
                requestedProps.map(p => [p, c.properties[p] ?? '']),
              )
            : {},
        }));

        calls.push({ method: req.method, url, requestedProperties: requestedProps, at: Date.now() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ results: filteredResults, paging: null }));
      }

      // Catch-all: return a valid 200 for any other calls the server makes on
      // boot (e.g. account-info health check) so startup does not fail.
      calls.push({ method: req.method, url, requestedProperties: [], at: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, calls });
    });
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
  console.log(`\n  phone-directory-customers test  run=${runId}`);
  console.log(`  DB: ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });

  const {
    spawnServer,
    waitForServer,
    seedUsers,
    cleanupTestData,
    resetRateLimitStore,
    login,
    setPool,
    PASSWORD,
    BASE,
  } = require('../privileges/harness');
  setPool(pool);

  const mock = await startMockHubspot();
  console.log(`  Mock HubSpot listening on http://127.0.0.1:${mock.port}`);

  // Spawn the Express server with HubSpot env vars set so the customers
  // section of the phone-directory handler is active.  The mock intercepts
  // all HubSpot API calls so no real credentials are needed.
  const { child, logBuf } = spawnServer({
    extraEnv: {
      HUBSPOT_API_URL:      `http://127.0.0.1:${mock.port}`,
      HUBSPOT_ACCESS_TOKEN: 'privtest-mock-hs-token',
      HUBSPOT_TOKEN:        'privtest-mock-hs-token',
    },
  });
  let exited = false;
  child.on('exit', () => { exited = true; });

  await cleanupTestData(pool);
  const users = await seedUsers(pool, runId);
  console.log(`  Seeded users  admin=${users.admin.email}`);

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { mock.server.close(); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    writeReport(runId);
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

  const adminClient = await login(users.admin.email, PASSWORD);

  // Fetch the phone directory.  The contacts cache is cold on a fresh server,
  // so this call triggers a real (mocked) HubSpot search.
  const resp = await adminClient.get('/api/admin/phone-directory');
  record(
    'Setup: admin phone-directory returns 200',
    '200',
    `${resp.status}`,
    resp.status === 200,
  );

  if (resp.status !== 200 || !resp.json) {
    console.error('  No payload — cannot continue. Server logs:');
    console.error(logBuf.join('').slice(-3000));
    await cleanupAndExit(2);
    return;
  }

  const dir = resp.json;

  // ── (C6) customers is non-empty ───────────────────────────────────────────

  record(
    'C6: customers is an Array',
    'Array',
    Array.isArray(dir.customers) ? `Array(${dir.customers.length})` : typeof dir.customers,
    Array.isArray(dir.customers),
  );

  const customers = Array.isArray(dir.customers) ? dir.customers : [];

  record(
    'C6: customers array is non-empty (HUBSPOT_TOKEN set, mock returns contacts)',
    'length >= 1',
    `length=${customers.length}`,
    customers.length >= 1,
  );

  // ── (C1) HS_A — phone field only ─────────────────────────────────────────

  const aPhoneEntry = customers.find(
    e => e.contactId === HS_A.id && e.field === 'phone',
  );
  record(
    'C1: HS_A phone entry present',
    `contactId=${HS_A.id} field=phone phone=${HS_A.properties.phone}`,
    aPhoneEntry
      ? `contactId=${aPhoneEntry.contactId} field=${aPhoneEntry.field} phone=${aPhoneEntry.phone}`
      : 'not found',
    !!aPhoneEntry && aPhoneEntry.phone === HS_A.properties.phone,
  );

  if (aPhoneEntry) {
    const expectedLabel = `${HS_A.properties.firstname} ${HS_A.properties.lastname}`.trim();
    record(
      'C1: HS_A entry label is full name',
      expectedLabel,
      aPhoneEntry.label,
      aPhoneEntry.label === expectedLabel,
    );
    record(
      'C1: HS_A entry has contactId field',
      'truthy string',
      String(aPhoneEntry.contactId),
      !!aPhoneEntry.contactId,
    );
  }

  // HS_A should have no mobilephone entry (empty string)
  const aMobileEntry = customers.find(
    e => e.contactId === HS_A.id && e.field === 'mobilephone',
  );
  record(
    'C1: HS_A has no mobilephone entry (empty mobilephone field)',
    'not found',
    aMobileEntry ? `found phone=${aMobileEntry.phone}` : 'not found',
    !aMobileEntry,
  );

  // ── (C3) HS_B — phone + mobilephone both present ──────────────────────────

  const bPhoneEntry = customers.find(
    e => e.contactId === HS_B.id && e.field === 'phone',
  );
  record(
    'C3: HS_B phone entry present',
    `field=phone phone=${HS_B.properties.phone}`,
    bPhoneEntry
      ? `field=${bPhoneEntry.field} phone=${bPhoneEntry.phone}`
      : 'not found',
    !!bPhoneEntry && bPhoneEntry.phone === HS_B.properties.phone,
  );

  const bMobileEntry = customers.find(
    e => e.contactId === HS_B.id && e.field === 'mobilephone',
  );
  record(
    'C2+C3: HS_B mobilephone entry present',
    `field=mobilephone phone=${HS_B.properties.mobilephone}`,
    bMobileEntry
      ? `field=${bMobileEntry.field} phone=${bMobileEntry.phone}`
      : 'not found',
    !!bMobileEntry && bMobileEntry.phone === HS_B.properties.mobilephone,
  );

  if (bPhoneEntry && bMobileEntry) {
    record(
      'C3: HS_B produces two distinct entries (phone + mobilephone)',
      '2 entries',
      `found both`,
      true,
    );
  } else {
    record(
      'C3: HS_B produces two distinct entries (phone + mobilephone)',
      '2 entries',
      `phone=${!!bPhoneEntry} mobilephone=${!!bMobileEntry}`,
      false,
    );
  }

  // ── (C4) HS_C — no name, falls back to email ──────────────────────────────

  const cEntry = customers.find(e => e.contactId === HS_C.id && e.field === 'phone');
  record(
    'C4: HS_C phone entry present',
    `field=phone phone=${HS_C.properties.phone}`,
    cEntry
      ? `field=${cEntry.field} phone=${cEntry.phone}`
      : 'not found',
    !!cEntry && cEntry.phone === HS_C.properties.phone,
  );

  if (cEntry) {
    const labelOk =
      cEntry.label === HS_C.properties.email ||
      cEntry.label === `Contact ${HS_C.id}`;
    record(
      'C4: HS_C label falls back to email or "Contact <id>"',
      `"${HS_C.properties.email}" or "Contact ${HS_C.id}"`,
      `label=${JSON.stringify(cEntry.label)}`,
      labelOk,
    );
  }

  // ── (C5) HS_D — no phone fields → no entry ────────────────────────────────

  const dEntries = customers.filter(e => e.contactId === HS_D.id);
  record(
    'C5: HS_D (no phone fields) produces zero entries',
    '0 entries',
    `${dEntries.length} entries`,
    dEntries.length === 0,
  );

  // ── Shape check: each entry has all required fields ───────────────────────

  const shapeErrors = customers
    .filter(e => [HS_A.id, HS_B.id, HS_C.id].includes(e.contactId))
    .filter(e => !e.contactId || !e.label || !e.field || !e.phone);

  record(
    'Shape: all fixture entries have contactId, label, field, phone',
    '0 shape errors',
    `${shapeErrors.length} shape errors`,
    shapeErrors.length === 0,
    shapeErrors.length > 0
      ? `bad entries: ${JSON.stringify(shapeErrors)}`
      : '',
  );

  // ── Mock call verification ────────────────────────────────────────────────
  // Confirm the outgoing HubSpot search requests asked for both phone fields.
  // If ALL_CONTACTS_PROPERTIES omits a field the mock will not have returned
  // it (the mock filters by requested properties), so the mapping assertions
  // above already catch the gap — but these checks make the root cause explicit.

  const searchCalls = mock.calls.filter(c =>
    c.url === '/crm/v3/objects/contacts/search' && c.method === 'POST',
  );
  record(
    'Mock: /crm/v3/objects/contacts/search was called at least once',
    '>= 1 call',
    `${searchCalls.length} calls`,
    searchCalls.length >= 1,
  );

  if (searchCalls.length >= 1) {
    const firstReqProps = searchCalls[0].requestedProperties;
    record(
      'Mock: outgoing search request includes "phone" in properties list',
      'phone in requested properties',
      `requested=${JSON.stringify(firstReqProps)}`,
      firstReqProps.includes('phone'),
    );
    record(
      'Mock: outgoing search request includes "mobilephone" in properties list',
      'mobilephone in requested properties',
      `requested=${JSON.stringify(firstReqProps)}`,
      firstReqProps.includes('mobilephone'),
    );
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  console.log(`\n  ${passed} passed, ${failed} failed`);

  await cleanupAndExit(failed > 0 ? 1 : 0);
}

main();
