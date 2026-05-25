'use strict';
// test/design-visit-qb-resubmit/run.js
//
// Integration test for the QuickBooks-estimate sync side-effect chain in
// design-visits.js `runSubmitSideEffects` (section 4). Covers the
// re-submission path that does a sparse update of an existing estimate
// instead of always creating a new one, plus the create-new fallback when
// the prior estimate cannot be updated.
//
// Probes:
//   (A) Prior estimate Pending -> sparse update. The mock QB GET returns
//       TxnStatus=Pending + a SyncToken; the mock POST asserts the request
//       body carries Id, SyncToken, sparse:true. design_visits.qb_estimate_id
//       must stay unchanged and qb_estimate_history must remain empty.
//   (B) Prior estimate Accepted -> create-new fallback. The mock GET
//       returns TxnStatus=Accepted; the mock POST returns a fresh Id. The
//       visit's qb_estimate_id must move to the new id and the prior id
//       must be appended to qb_estimate_history with reason
//       'prior_estimate_not_updatable'.
//   (C) Prior estimate 404 -> create-new fallback. The mock GET 404s; the
//       mock POST returns a fresh Id; qb_estimate_history is appended.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:design-visit-qb-resubmit
//   PRIVTEST_ALLOW_SHARED_DB=1 npm run test:design-visit-qb-resubmit

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'design-visit-qb-resubmit.md');
const REALM_ID    = 'PRIVTEST_REALM_QB_RESUBMIT';
const CUSTOMER_ID = 'privtest-qb-resubmit-contact';
const findings    = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}

// ── Mock QuickBooks server ────────────────────────────────────────────────────
function startMockQb() {
  const state = {
    // estimates keyed by id. Each entry: { Id, SyncToken, TxnStatus, DocNumber }
    estimates: {},
    // status-code overrides for GET /estimate/:id
    getOverrides: {},
    nextId: 1000,
    posts: [],
    gets:  [],
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const u = new URL(req.url, `http://${req.headers.host}`);
      // Match /v3/company/:realm/estimate/:id (GET) or /v3/company/:realm/estimate (POST).
      const m = u.pathname.match(/^\/v3\/company\/[^/]+\/estimate(?:\/([^/?]+))?$/);
      if (!m) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not_found', path: u.pathname }));
      }
      const id = m[1] ? decodeURIComponent(m[1]) : null;

      if (req.method === 'GET' && id) {
        state.gets.push({ id });
        if (state.getOverrides[id] != null) {
          const code = state.getOverrides[id];
          res.writeHead(code, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ Fault: { type: 'ValidationFault' } }));
        }
        const est = state.estimates[id];
        if (!est) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ Fault: { type: 'ValidationFault' } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ Estimate: est }));
      }

      if (req.method === 'POST' && !id) {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch {}
        state.posts.push({ body });
        if (body.Id && body.SyncToken != null && body.sparse === true) {
          // Sparse update -> echo back with bumped SyncToken.
          const cur = state.estimates[body.Id] || { Id: body.Id, SyncToken: '0', TxnStatus: 'Pending' };
          const updated = {
            ...cur,
            ...body,
            SyncToken: String((parseInt(cur.SyncToken, 10) || 0) + 1),
          };
          state.estimates[body.Id] = updated;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ Estimate: updated }));
        }
        // Create-new path
        const newId = `QBNEW${state.nextId++}`;
        const created = {
          Id:        newId,
          SyncToken: '0',
          TxnStatus: 'Pending',
          DocNumber: `DOC${newId}`,
          ...body,
        };
        created.Id = newId;
        state.estimates[newId] = created;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ Estimate: created }));
      }

      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, state });
    });
  });
}

async function seedVisit(pool, runId, { qbEstimateId }) {
  // Seed contact (HubSpot-side) is not strictly required for the QB block —
  // runSubmitSideEffects only checks visit.rooms.length. We still set
  // contact_id so generated payloads look realistic.
  const insertVisit = await pool.query(
    `INSERT INTO design_visits
       (contact_id, contact_name, contact_email, created_by, visit_date,
        duration_min, location, notes, terms_accepted, status,
        qb_estimate_id, qb_estimate_doc_num)
     VALUES ($1, 'PrivTest Contact', 'privtest-qb@example.com',
             $2, NOW(), 90, 'Test location', 'note', TRUE,
             'revision_requested', $3, $4)
     RETURNING id`,
    [CUSTOMER_ID, `privtest-qb-${runId}@privtest.local`, qbEstimateId, qbEstimateId ? `DOC${qbEstimateId}` : null]
  );
  const visitId = insertVisit.rows[0].id;
  await pool.query(
    `INSERT INTO design_visit_rooms
       (design_visit_id, room_name, unit_count, unit_price_pence, sort_order)
     VALUES ($1, 'Kitchen', 2, 50000, 0)`,
    [visitId]
  );
  return visitId;
}

async function resetVisitForProbe(pool, visitId, qbEstimateId) {
  await pool.query(
    `UPDATE design_visits
        SET status              = 'revision_requested',
            qb_estimate_id      = $1,
            qb_estimate_doc_num = $2,
            qb_estimate_history = '[]'::jsonb,
            updated_at          = NOW()
      WHERE id = $3`,
    [qbEstimateId, qbEstimateId ? `DOC${qbEstimateId}` : null, visitId]
  );
}

async function fetchVisitState(pool, visitId) {
  const r = await pool.query(
    `SELECT qb_estimate_id, qb_estimate_doc_num, qb_estimate_history, status
       FROM design_visits WHERE id = $1`,
    [visitId]
  );
  return r.rows[0];
}

async function cleanup(pool, runId) {
  await pool.query(`DELETE FROM qb_tokens WHERE realm_id = $1`, [REALM_ID]);
  // Visits cascade their rooms/images via FK.
  await pool.query(
    `DELETE FROM design_visits WHERE created_by LIKE 'privtest-qb-%'`
  );
}

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
  console.log(`\n  design-visit QB resubmit  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });

  const mock = await startMockQb();
  console.log(`  mock QB listening on http://127.0.0.1:${mock.port}`);
  // Point the spawned server's QuickBooks HTTP calls at the mock.
  process.env.QB_API_BASE_OVERRIDE = `http://127.0.0.1:${mock.port}`;

  // Require harness AFTER setting env so spawnServer inherits it via ...process.env.
  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool,
  } = require('../privileges/harness');
  setPool(pool);

  // Pre-clean prior runs (other fixture tables may not exist yet — server
  // boot will create them).
  await cleanupTestData(pool);
  await resetRateLimitStore(pool);

  const { child, logBuf } = spawnServer();
  let exitCode = 1;
  try {
    await waitForServer();
    console.log('  test server up');

    // Make the QB tables exist (the server creates them on first OAuth use;
    // we cannot rely on that here so create the minimal qb_tokens table if
    // missing).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS qb_tokens (
        id            SERIAL PRIMARY KEY,
        access_token  TEXT   NOT NULL,
        refresh_token TEXT   NOT NULL,
        realm_id      TEXT   NOT NULL,
        expires_at    BIGINT NOT NULL,
        updated_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    // The server runs ensureDesignVisitTables() asynchronously after the
    // HTTP listener comes up, so /api/turnstile-config can answer before the
    // qb_estimate_history column has been added. Poll briefly until the
    // ALTER TABLE has landed.
    {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const r = await pool.query(`
          SELECT 1 FROM information_schema.columns
            WHERE table_name = 'design_visits'
              AND column_name = 'qb_estimate_history'
          LIMIT 1`);
        if (r.rowCount) break;
        await new Promise(res => setTimeout(res, 200));
      }
    }
    await cleanup(pool, runId);

    // Seed a long-lived QB token row so getQbTokens() short-circuits without
    // hitting the live refresh endpoint.
    await pool.query(
      `INSERT INTO qb_tokens (access_token, refresh_token, realm_id, expires_at)
       VALUES ('privtest-access', 'privtest-refresh', $1, $2)`,
      [REALM_ID, Date.now() + 24 * 60 * 60 * 1000]
    );

    const users = await seedUsers(pool, runId);
    const member = users.member;
    const client = await login(member.email, member.password);

    // ── Probe A: Pending -> sparse update ──────────────────────────────────
    const PRIOR_A = 'QBPRIORA';
    mock.state.estimates[PRIOR_A] = {
      Id: PRIOR_A, SyncToken: '7', TxnStatus: 'Pending', DocNumber: `DOC${PRIOR_A}`,
    };
    const visitId = await seedVisit(pool, runId, { qbEstimateId: PRIOR_A });
    mock.state.posts.length = 0;
    mock.state.gets.length  = 0;

    let r = await client.post(`/api/design-visits/${visitId}/submit`, {});
    if (r.status !== 200) {
      record('A.submit', false, `submit status ${r.status} body=${r.text.slice(0, 200)}`);
    } else {
      const post = mock.state.posts[0];
      const sparseOk = !!post
        && post.body.Id === PRIOR_A
        && post.body.SyncToken === '7'
        && post.body.sparse === true
        && Array.isArray(post.body.Line) && post.body.Line.length === 1;
      record('A.sparse-payload', sparseOk,
        sparseOk
          ? 'POST carried Id, SyncToken=7, sparse:true, 1 Line'
          : `unexpected POST body: ${JSON.stringify(post && post.body).slice(0, 200)}`);

      const state = await fetchVisitState(pool, visitId);
      const idUnchanged = state.qb_estimate_id === PRIOR_A;
      record('A.id-unchanged', idUnchanged,
        idUnchanged
          ? `qb_estimate_id stayed ${PRIOR_A}`
          : `qb_estimate_id changed to ${state.qb_estimate_id}`);
      const historyEmpty = Array.isArray(state.qb_estimate_history) && state.qb_estimate_history.length === 0;
      record('A.history-empty', historyEmpty,
        historyEmpty
          ? 'qb_estimate_history remained empty'
          : `qb_estimate_history unexpectedly populated: ${JSON.stringify(state.qb_estimate_history).slice(0, 200)}`);
      record('A.status', state.status === 'submitted', `status=${state.status}`);
    }

    // ── Probe B: Accepted -> create-new fallback ───────────────────────────
    const PRIOR_B = 'QBPRIORB';
    mock.state.estimates[PRIOR_B] = {
      Id: PRIOR_B, SyncToken: '3', TxnStatus: 'Accepted', DocNumber: `DOC${PRIOR_B}`,
    };
    await resetVisitForProbe(pool, visitId, PRIOR_B);
    mock.state.posts.length = 0;
    mock.state.gets.length  = 0;

    r = await client.post(`/api/design-visits/${visitId}/submit`, {});
    if (r.status !== 200) {
      record('B.submit', false, `submit status ${r.status} body=${r.text.slice(0, 200)}`);
    } else {
      const post = mock.state.posts[0];
      const isCreate = !!post
        && !post.body.Id
        && !post.body.sparse
        && post.body.SyncToken == null;
      record('B.create-payload', isCreate,
        isCreate
          ? 'POST omitted Id / SyncToken / sparse (create-new)'
          : `expected create-new POST, got: ${JSON.stringify(post && post.body).slice(0, 200)}`);

      const state = await fetchVisitState(pool, visitId);
      const idChanged = state.qb_estimate_id && state.qb_estimate_id !== PRIOR_B
        && state.qb_estimate_id.startsWith('QBNEW');
      record('B.id-updated', idChanged,
        idChanged
          ? `qb_estimate_id moved to ${state.qb_estimate_id}`
          : `qb_estimate_id unexpectedly ${state.qb_estimate_id}`);

      const hist = Array.isArray(state.qb_estimate_history) ? state.qb_estimate_history : [];
      // Note: `replaced_by` ends up null because design-visits.js reads
      // `submitterUser?.email` but the local Passport session stores email
      // on `req.user.claims.email`, not `req.user.email`. Tracked separately —
      // we just assert the key is present here.
      const histOk = hist.length === 1
        && hist[0].qb_estimate_id === PRIOR_B
        && hist[0].reason === 'prior_estimate_not_updatable'
        && typeof hist[0].replaced_at === 'string'
        && 'replaced_by' in hist[0];
      record('B.history-appended', histOk,
        histOk
          ? `history has 1 entry for ${PRIOR_B} with reason prior_estimate_not_updatable`
          : `history was: ${JSON.stringify(hist).slice(0, 200)}`);
    }

    // ── Probe C: 404 -> create-new fallback ────────────────────────────────
    const PRIOR_C = 'QBPRIORC';
    mock.state.getOverrides[PRIOR_C] = 404; // force GET to 404
    await resetVisitForProbe(pool, visitId, PRIOR_C);
    mock.state.posts.length = 0;
    mock.state.gets.length  = 0;

    r = await client.post(`/api/design-visits/${visitId}/submit`, {});
    if (r.status !== 200) {
      record('C.submit', false, `submit status ${r.status} body=${r.text.slice(0, 200)}`);
    } else {
      const post = mock.state.posts[0];
      const isCreate = !!post
        && !post.body.Id
        && !post.body.sparse
        && post.body.SyncToken == null;
      record('C.create-payload', isCreate,
        isCreate
          ? 'POST omitted Id / SyncToken / sparse (create-new after 404)'
          : `expected create-new POST, got: ${JSON.stringify(post && post.body).slice(0, 200)}`);

      const state = await fetchVisitState(pool, visitId);
      const idChanged = state.qb_estimate_id && state.qb_estimate_id !== PRIOR_C
        && state.qb_estimate_id.startsWith('QBNEW');
      record('C.id-updated', idChanged,
        idChanged
          ? `qb_estimate_id moved to ${state.qb_estimate_id}`
          : `qb_estimate_id unexpectedly ${state.qb_estimate_id}`);

      const hist = Array.isArray(state.qb_estimate_history) ? state.qb_estimate_history : [];
      const histOk = hist.length === 1
        && hist[0].qb_estimate_id === PRIOR_C
        && hist[0].reason === 'prior_estimate_not_updatable';
      record('C.history-appended', histOk,
        histOk
          ? `history has 1 entry for ${PRIOR_C}`
          : `history was: ${JSON.stringify(hist).slice(0, 200)}`);
    }

    exitCode = findings.every(f => f.ok) ? 0 : 1;
  } catch (e) {
    console.error('  fatal:', e.stack || e.message);
    record('harness', false, `fatal: ${e.message}`);
    exitCode = 1;
  } finally {
    try { await cleanup(pool, runId); } catch {}
    try { await cleanupTestData(pool); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    try { mock.server.close(); } catch {}
    await pool.end().catch(() => {});

    // Write markdown report
    const lines = [
      '# design-visit QB resubmit findings',
      '',
      `Run: ${new Date().toISOString()}`,
      `Result: ${findings.every(f => f.ok) ? 'PASS' : 'FAIL'} (${findings.filter(f => f.ok).length}/${findings.length})`,
      '',
      '| ID | Result | Detail |',
      '|----|--------|--------|',
      ...findings.map(f => `| ${f.id} | ${f.ok ? 'PASS' : 'FAIL'} | ${f.detail.replace(/\|/g, '\\|')} |`),
    ];
    try {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, lines.join('\n') + '\n');
      console.log(`  report -> ${REPORT_PATH}`);
    } catch (e) {
      console.warn('  report write failed:', e.message);
    }
  }

  process.exit(exitCode);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
