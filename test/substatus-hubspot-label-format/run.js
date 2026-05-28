'use strict';
// test/substatus-hubspot-label-format/run.js
//
// Focused integration test verifying the label format emitted by
// syncLeadSubstatusesToHubSpot() in server.js.
//
// Task #1748 fixed the function to emit "{Lead Status label} → {Sub-status label}"
// labels so HubSpot doesn't reject the PATCH with a "labels must be unique" error.
// This suite guards that fix against future regressions.
//
// Probes:
//   (S1) Normal rows: options for substatuses linked to a real lead status carry
//        the label "{ls_label} → {sub_label}" (arrow-prefixed).
//
//   (S2) __NULL__ sentinel rows: options for substatuses with status_key='__NULL__'
//        emit just the sub-status label — no "null →" or "__NULL__ →" prefix.
//
//   (S3) Distinct labels when same sub-status name appears under two lead statuses:
//        e.g. "Status Alpha → Quick Win" and "Status Beta → Quick Win" are
//        different strings even though both sub-status rows have label='Quick Win'.
//
//   (S4) The value field for normal rows is "{STATUS_KEY}__{SUBSTATUS_KEY}";
//        for __NULL__ sentinel rows the value is just the substatus_key.
//
//   (S5) Trigger via API: POST /api/admin/lead-substatuses fires a fresh sync.
//        The captured PATCH reflects the newly-added substatus label.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:substatus-hubspot-label-format
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:substatus-hubspot-label-format

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

require('dotenv').config();

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'substatus-hubspot-label-format.md',
);

const LS_KEY_A   = 'PRIVTEST_LSSFA';
const LS_KEY_B   = 'PRIVTEST_LSSFB';
const SUB_KEY_Q  = 'QUICKSUB';
const SUB_KEY_N  = 'NULLSUB';
const SUB_KEY_S5 = 'APITRIGGERED';

const findings = [];
function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Mock HubSpot server ───────────────────────────────────────────────────────
//
// Records every PATCH to /crm/v3/properties/contacts/hw_lead_substatus so
// tests can inspect the options array.  All other HubSpot requests are
// accepted silently.

function startMockHubspot() {
  const state = {
    propertyPatches: [],  // bodies sent to PATCH .../hw_lead_substatus
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const method = req.method.toUpperCase();
      const url    = req.url.split('?')[0];
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch {}

      if (
        method === 'PATCH' &&
        url === '/crm/v3/properties/contacts/hw_lead_substatus'
      ) {
        state.propertyPatches.push({ body, at: Date.now() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ name: 'hw_lead_substatus' }));
      }

      // Accept all other HubSpot calls silently.
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

async function pollUntil(predicate, timeoutMs = 6000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
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
  console.log(`\n  substatus-hubspot-label-format  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL'}`);

  const pool = new Pool({ connectionString: connStr });
  const mock = await startMockHubspot();
  console.log(`  mock HubSpot listening on http://127.0.0.1:${mock.port}`);

  // server.js uses HUBSPOT_API_URL for the HS constant; HUBSPOT_API_BASE_OVERRIDE
  // is only used in design-visits.js.  Set both so the mock intercepts all calls.
  // These must be set before requiring the harness so that ...process.env in
  // spawnServer() picks them up, matching the pattern in other hub-retry suites.
  process.env.HUBSPOT_API_URL                   = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_API_BASE_OVERRIDE         = `http://127.0.0.1:${mock.port}`;
  process.env.HUBSPOT_ACCESS_TOKEN              = 'privtest-dummy-token';
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';

  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool, BASE,
  } = require('../privileges/harness');
  setPool(pool);

  const cleanup = async () => {
    try { child.kill('SIGTERM'); } catch {}
    try {
      await pool.query(
        `DELETE FROM lead_substatuses
           WHERE status_key = ANY($1::text[]) OR substatus_key = ANY($2::text[])`,
        [
          [LS_KEY_A, LS_KEY_B, '__NULL__'],
          [SUB_KEY_Q, SUB_KEY_N, SUB_KEY_S5],
        ],
      );
    } catch {}
    try {
      await pool.query(
        `DELETE FROM lead_status_config WHERE key = ANY($1::text[])`,
        [[LS_KEY_A, LS_KEY_B]],
      );
    } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    try { mock.server.close(); } catch {}
  };
  process.on('SIGINT',  () => cleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => cleanup().then(() => process.exit(130)));

  // ── Seed: clean leftover rows from prior runs ─────────────────────────────
  await cleanupTestData(pool);
  await pool.query(
    `DELETE FROM lead_substatuses
       WHERE status_key = ANY($1::text[]) OR substatus_key = ANY($2::text[])`,
    [
      [LS_KEY_A, LS_KEY_B, '__NULL__'],
      [SUB_KEY_Q, SUB_KEY_N, SUB_KEY_S5],
    ],
  ).catch(() => {});
  await pool.query(
    `DELETE FROM lead_status_config WHERE key = ANY($1::text[])`,
    [[LS_KEY_A, LS_KEY_B]],
  ).catch(() => {});

  // ── Seed: two lead-status rows and three substatuses ─────────────────────
  // A + B share the same sub-status label ("Quick Win") under different parents.
  // __NULL__ sentinel has its own sub-status (no lead-status parent).
  await pool.query(
    `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
       VALUES ($1, 'Status Alpha', 980, false), ($2, 'Status Beta', 981, false)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label`,
    [LS_KEY_A, LS_KEY_B],
  );
  // Ensure the __NULL__ sentinel row exists in lead_status_config if the schema requires it.
  // (The function does a LEFT JOIN, so missing parent is tolerated — ls_label will be null
  //  and the code falls back to just the sub_label.)
  await pool.query(
    `INSERT INTO lead_substatuses (status_key, substatus_key, label, sort_order)
       VALUES
         ($1, $3, 'Quick Win',      0),
         ($2, $3, 'Quick Win',      0),
         ('__NULL__', $4, 'No Status Sub', 0)
       ON CONFLICT DO NOTHING`,
    [LS_KEY_A, LS_KEY_B, SUB_KEY_Q, SUB_KEY_N],
  );

  const users = await seedUsers(pool, runId);
  const { child, logBuf } = spawnServer({
    extraEnv: {
      HUBSPOT_API_BASE_OVERRIDE: `http://127.0.0.1:${mock.port}`,
    },
  });
  let exitCode = 1;

  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  test server up at ${BASE}\n`);

    const admin = await login(users.admin.email, users.admin.password);

    // ── Wait for the startup sync PATCH ──────────────────────────────────────
    // syncLeadSubstatusesToHubSpot() is called at server startup; wait for the
    // first PATCH to appear in our mock.
    console.log('  Waiting for startup sync PATCH…');
    const startupArrived = await pollUntil(
      () => mock.state.propertyPatches.length > 0,
      10000,
    );
    record('S0 startup sync PATCH received',
      startupArrived,
      `arrived=${startupArrived} patches=${mock.state.propertyPatches.length}`);

    const startupPatch = mock.state.propertyPatches[0];
    const startupOpts  = startupPatch?.body?.options ?? [];

    // ── (S1) Normal rows carry "{ls_label} → {sub_label}" ────────────────────
    const optA = startupOpts.find(o => o.value === `${LS_KEY_A}__${SUB_KEY_Q}`);
    const optB = startupOpts.find(o => o.value === `${LS_KEY_B}__${SUB_KEY_Q}`);

    record('S1a value for Status Alpha row uses "KEY__SUBKEY" format',
      !!optA,
      `found=${!!optA} value=${optA?.value}`);

    const expectedLabelA = 'Status Alpha \u2192 Quick Win';
    record('S1b label for Status Alpha row is "{ls_label} → {sub_label}"',
      optA?.label === expectedLabelA,
      `got=${JSON.stringify(optA?.label)} expected=${JSON.stringify(expectedLabelA)}`);

    const expectedLabelB = 'Status Beta \u2192 Quick Win';
    record('S1c label for Status Beta row is "{ls_label} → {sub_label}"',
      optB?.label === expectedLabelB,
      `got=${JSON.stringify(optB?.label)} expected=${JSON.stringify(expectedLabelB)}`);

    // ── (S2) __NULL__ sentinel rows emit just the sub-status label ────────────
    // The value for a __NULL__ row is just the substatus_key (no "__NULL____" prefix).
    const optNull = startupOpts.find(o => o.value === SUB_KEY_N);
    record('S2a value for __NULL__ row is plain substatus_key (no prefix)',
      !!optNull,
      `found=${!!optNull} value=${optNull?.value}`);

    const expectedLabelN = 'No Status Sub';
    record('S2b label for __NULL__ row is just the sub-status label (no "null →" prefix)',
      optNull?.label === expectedLabelN,
      `got=${JSON.stringify(optNull?.label)} expected=${JSON.stringify(expectedLabelN)}`);

    // Guard that the label does NOT start with any form of the null key.
    const nullPrefixGuard = optNull
      ? !optNull.label.toLowerCase().startsWith('null')
        && !optNull.label.includes('__NULL__')
      : false;
    record('S2c __NULL__ label contains no null-prefix artefact',
      nullPrefixGuard,
      `label=${JSON.stringify(optNull?.label)}`);

    // ── (S3) Same sub-status name, different parents → distinct labels ────────
    const labelsDistinct =
      !!optA && !!optB && optA.label !== optB.label;
    record('S3 same sub-status name under two lead statuses produces distinct labels',
      labelsDistinct,
      `labelA=${JSON.stringify(optA?.label)} labelB=${JSON.stringify(optB?.label)}`);

    // ── (S4) value field format ───────────────────────────────────────────────
    const valueFormatA = optA?.value === `${LS_KEY_A}__${SUB_KEY_Q}`;
    const valueFormatN = optNull?.value === SUB_KEY_N;
    record('S4a normal row value is "{STATUS_KEY}__{SUBSTATUS_KEY}"',
      valueFormatA,
      `value=${JSON.stringify(optA?.value)}`);
    record('S4b __NULL__ row value is plain substatus_key',
      valueFormatN,
      `value=${JSON.stringify(optNull?.value)}`);

    // ── (S5) API-triggered sync: POST /api/admin/lead-substatuses ─────────────
    // Adding a new substatus via the API must trigger a fresh sync PATCH.
    const patchCountBefore = mock.state.propertyPatches.length;
    console.log(`\n  [S5] API-triggered sync — POST /api/admin/lead-substatuses`);

    const createRes = await admin.post('/api/admin/lead-substatuses', {
      status_key:    LS_KEY_A,
      substatus_key: SUB_KEY_S5,
      label:         'API Triggered',
      sort_order:    99,
    });
    record('S5a POST /api/admin/lead-substatuses returns 201',
      createRes.status === 201,
      `status=${createRes.status} body=${(createRes.text || '').slice(0, 120)}`);

    // Wait for the new PATCH to arrive.
    const apiSyncArrived = await pollUntil(
      () => mock.state.propertyPatches.length > patchCountBefore,
      6000,
    );
    record('S5b API creation triggers a fresh HubSpot sync PATCH',
      apiSyncArrived,
      `patchesBefore=${patchCountBefore} patchesNow=${mock.state.propertyPatches.length}`);

    const apiPatch = mock.state.propertyPatches[mock.state.propertyPatches.length - 1];
    const apiOpts  = apiPatch?.body?.options ?? [];
    const optS5    = apiOpts.find(o => o.value === `${LS_KEY_A}__${SUB_KEY_S5}`);
    const expectedLabelS5 = 'Status Alpha \u2192 API Triggered';
    record('S5c newly-created substatus option has correct label in sync PATCH',
      optS5?.label === expectedLabelS5,
      `got=${JSON.stringify(optS5?.label)} expected=${JSON.stringify(expectedLabelS5)}`);

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
    '# Sub-status HubSpot Sync — Label Format Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:substatus-hubspot-label-format\``,
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
    '- **(S0)** Startup sync: asserts `syncLeadSubstatusesToHubSpot()` issues a',
    '  `PATCH /crm/v3/properties/contacts/hw_lead_substatus` on boot.',
    '- **(S1)** Normal rows: option labels use the form `"{ls_label} → {sub_label}"`',
    '  (arrow separator, lead status label as prefix).',
    '- **(S2)** `__NULL__` sentinel rows: the label is just the sub-status label',
    '  — no `"null →"` or `"__NULL__ →"` prefix, and the value is the plain',
    '  `substatus_key` without a `"__NULL__"` prefix.',
    '- **(S3)** Distinct labels: two sub-statuses with the same `label` under',
    '  different parent lead statuses produce different HubSpot option labels.',
    '- **(S4)** Value field format: normal rows use `"{STATUS_KEY}__{SUBSTATUS_KEY}"`;',
    '  `__NULL__` sentinel rows use the plain `substatus_key`.',
    '- **(S5)** API-triggered sync: `POST /api/admin/lead-substatuses` fires a fresh',
    '  `syncLeadSubstatusesToHubSpot()` call; the resulting PATCH contains the',
    '  newly-created option with the correct arrow-prefixed label.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
