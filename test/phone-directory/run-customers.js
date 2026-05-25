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
// Seven contacts covering distinct mapping paths in the phone-directory handler:
//
//   HS_A — firstname + lastname + phone only       → 1 customers entry (phone)
//   HS_B — firstname only + phone + mobilephone    → 2 customers entries
//   HS_C — no name, email only + phone             → 1 entry, label = email
//   HS_D — firstname only, no phone fields at all  → 0 entries (should not appear)
//
// Malformed / defensive cases (C7–C9):
//   HS_E — properties: null                        → 0 entries (null props skipped)
//   HS_F — phone: null, mobilephone: null          → 0 entries (null phone skipped)
//   HS_G — id: null, valid phone                   → 0 entries (no-id skipped)

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

// Malformed contacts — the server must skip these without crashing.
const HS_E = {
  id: 'privtest-phonedir-hs-e',
  properties: null,                     // null properties object
};
const HS_F = {
  id: 'privtest-phonedir-hs-f',
  properties: {
    firstname:   'Null',
    lastname:    'Phones',
    email:       'nullphones@privtest.invalid',
    phone:       null,                  // null phone value (not an empty string)
    mobilephone: null,
  },
};
const HS_G = {
  id: null,                             // missing/null id
  properties: {
    firstname:   'NoId',
    lastname:    '',
    email:       'noid@privtest.invalid',
    phone:       '555-0200',
    mobilephone: '',
  },
};

const CONTACTS_SEARCH_SUCCESS = {
  results: [HS_A, HS_B, HS_C, HS_D, HS_E, HS_F, HS_G],
  paging: null,
};

// ── Mock HubSpot server ───────────────────────────────────────────────────────
// Handles POST /crm/v3/objects/contacts/search.  Crucially, the mock parses
// the `properties` list from the request body and filters each contact's
// properties object to only the fields that were actually requested.  This
// makes the test fail for real if `fetchAllContactsShared` omits a property
// from ALL_CONTACTS_PROPERTIES — the contact entry won't carry that field and
// the mapping assertions below will catch the gap.
//
// The mock exposes a `state.mode` string that controls which fixture body is
// returned for search requests:
//
//   'normal'         — full contacts fixture (default)
//   'empty-results'  — { results: [] }
//   'no-results-key' — {}  (results key absent)
//   'null-results'   — { results: null }

function startMockHubspot() {
  // { method, url, requestedProperties, at } — one entry per search call.
  const calls = [];
  const state  = { mode: 'normal' };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const url = req.url.split('?')[0];

      if (req.method === 'POST' && url === '/crm/v3/objects/contacts/search') {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch {}
        const requestedProps = Array.isArray(body.properties) ? body.properties : [];

        calls.push({ method: req.method, url, requestedProperties: requestedProps, at: Date.now() });
        res.writeHead(200, { 'Content-Type': 'application/json' });

        // ── Empty-response fixture variants ─────────────────────────────────
        if (state.mode === 'empty-results') {
          return res.end(JSON.stringify({ results: [] }));
        }
        if (state.mode === 'no-results-key') {
          return res.end(JSON.stringify({}));
        }
        if (state.mode === 'null-results') {
          return res.end(JSON.stringify({ results: null }));
        }

        // ── Normal fixture (default) ─────────────────────────────────────────
        // Filter each contact's properties to only the requested fields.
        // An empty requestedProps list means the server requested nothing, so
        // nothing is returned — which causes the field-presence assertions to
        // fail and surfaces the gap immediately.
        //
        // Malformed contacts (null properties, null id) are passed through as-is
        // so the server's defensive guards are exercised for real.
        const filteredResults = CONTACTS_SEARCH_SUCCESS.results.map(c => {
          if (c.properties === null) {
            // Pass null properties through unchanged — tests the server's
            // `c.properties || {}` guard.
            return { id: c.id, properties: null };
          }
          const props = c.properties || {};
          return {
            id: c.id,
            properties: requestedProps.length > 0
              ? Object.fromEntries(
                  requestedProps.map(p => [p, props[p] ?? '']),
                )
              : {},
          };
        });

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
      resolve({ server, port: server.address().port, calls, state });
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

  // ── (C7) HS_E — null properties → no entry, no crash ─────────────────────
  // The mock sends `properties: null` for this contact.  The server guard
  // `const p = c.properties || {}` must absorb it without throwing, and the
  // loop must continue so the valid contacts above still appear.

  const eEntries = customers.filter(e => e.contactId === HS_E.id);
  record(
    'C7: HS_E (null properties) produces zero entries',
    '0 entries',
    `${eEntries.length} entries`,
    eEntries.length === 0,
  );

  // ── (C8) HS_F — null phone values → no entry ─────────────────────────────
  // The mock transmits null phone/mobilephone values.  The server's falsy
  // check (`if (p.phone)`) must skip them without throwing.

  const fEntries = customers.filter(e => e.contactId === HS_F.id);
  record(
    'C8: HS_F (null phone values) produces zero entries',
    '0 entries',
    `${fEntries.length} entries`,
    fEntries.length === 0,
  );

  // ── (C9) HS_G — null id → no entry ───────────────────────────────────────
  // The mock sends `id: null`.  The server guard `if (!c || !c.id) continue`
  // must skip this contact entirely, so no entry with contactId=null appears.

  const nullIdEntries = customers.filter(e => e.contactId === null || e.contactId === undefined);
  record(
    'C9: HS_G (null id) produces zero entries (no contactId=null in output)',
    '0 entries',
    `${nullIdEntries.length} entries`,
    nullIdEntries.length === 0,
  );

  // ── (C10) Valid contacts still present despite malformed contacts in fixture ──
  // The malformed contacts (HS_E, HS_F, HS_G) must not corrupt the loop so
  // that contacts processed after them are silently dropped.

  const validIds = [HS_A.id, HS_B.id, HS_C.id];
  const validCount = customers.filter(e => validIds.includes(e.contactId)).length;
  const expectedValidCount = 4; // HS_A(1) + HS_B(2) + HS_C(1)
  record(
    'C10: valid contacts (HS_A/B/C) still present despite malformed contacts in fixture',
    `${expectedValidCount} valid entries`,
    `${validCount} valid entries`,
    validCount === expectedValidCount,
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

  // ── (C11–C13) Empty HubSpot response variants ────────────────────────────
  //
  // These three cases verify that `fetchAllContactsShared` does not throw when
  // HubSpot returns a body with no usable results, and that the phone-directory
  // endpoint responds 200 with an empty customers array in each case.
  //
  // We reuse the same Express server instance; the contacts cache is busted
  // between each variant so the next request triggers a fresh HubSpot search
  // against the reconfigured mock.
  //
  // Variants:
  //   C11 — { results: [] }   (empty array — no contacts at all)
  //   C12 — {}                (results key absent — `r.data.results` is undefined)
  //   C13 — { results: null } (explicit null — `r.data.results || []` guard)

  const emptyVariants = [
    { name: 'C11', label: '{ results: [] }',   mode: 'empty-results'  },
    { name: 'C12', label: '{}',                mode: 'no-results-key' },
    { name: 'C13', label: '{ results: null }', mode: 'null-results'   },
  ];

  for (const variant of emptyVariants) {
    console.log(`\n  [${variant.name}] HubSpot returns ${variant.label}`);

    mock.state.mode = variant.mode;

    const bust = await adminClient.post('/api/admin/test/bust-contacts-cache', {});
    record(
      `${variant.name}: bust-contacts-cache succeeds`,
      '200 ok=true',
      `status=${bust.status} ok=${bust.json?.ok}`,
      bust.status === 200 && bust.json?.ok === true,
    );

    const emptyResp = await adminClient.get('/api/admin/phone-directory');
    record(
      `${variant.name}: phone-directory returns 200 when HubSpot returns ${variant.label}`,
      '200',
      `${emptyResp.status}`,
      emptyResp.status === 200,
    );

    const emptyDir = emptyResp.json;
    const emptyCustomers = emptyDir?.customers;
    record(
      `${variant.name}: customers is an Array`,
      'Array',
      Array.isArray(emptyCustomers) ? `Array(${emptyCustomers.length})` : typeof emptyCustomers,
      Array.isArray(emptyCustomers),
    );
    record(
      `${variant.name}: customers array is empty`,
      'length=0',
      `length=${Array.isArray(emptyCustomers) ? emptyCustomers.length : 'n/a'}`,
      Array.isArray(emptyCustomers) && emptyCustomers.length === 0,
    );
  }

  // Restore mock to normal mode so any subsequent teardown calls do not fail.
  mock.state.mode = 'normal';

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  console.log(`\n  ${passed} passed, ${failed} failed`);

  await cleanupAndExit(failed > 0 ? 1 : 0);
}

main();
