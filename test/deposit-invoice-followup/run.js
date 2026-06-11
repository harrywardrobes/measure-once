'use strict';
// test/deposit-invoice-followup/run.js
//
// Integration tests for the deposit_invoice_followup card-action handler routes.
// Spins up a mock QuickBooks server and a mock HubSpot server; captures
// outgoing emails via MAIL_TRANSPORT_FILE_OVERRIDE.
//
// Probes:
//   (auth.1)  Unauth POST /api/card-actions/deposit-invoice → 401
//   (auth.2)  Unauth POST /api/card-actions/deposit-invoice/resend → 401
//   (auth.3)  Unauth POST /api/card-actions/deposit-invoice/not-proceeding → 401
//   (auth.4)  Member POST /api/card-actions/deposit-invoice/resend → 403
//             (requireManagerOrAdmin gate)
//   (auth.5)  Member POST /api/card-actions/deposit-invoice/not-proceeding → 403
//   (A) Loader: invoice fully paid → paymentState='paid'
//   (B) Loader: invoice unpaid   → paymentState='unpaid'
//   (C) Loader: QB not connected → qbConnected=false, paymentState='unknown'
//   (D) Loader: stored invoiceId on design_visit used (no QB search needed)
//   (E) Resend: valid → QB send called, 200 ok
//   (F) Resend: rate limit hit → 429
//   (G) Resend: invoice belongs to different contact → 403
//   (H) Not-proceeding: sets DECLINED_DEAL; no thank-you email when skipped
//   (I) Not-proceeding: sends thank-you email when requested
//   (J) Template: deposit_invoice_payment_reminder renders expected variables
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:deposit-invoice-followup
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:deposit-invoice-followup

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

require('dotenv').config();

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

// Local helper: logs in via the harness (which auto-tracks session cookies)
// and returns an async client(url, method, body) compatible with the test's
// calling convention.  json() returns a Promise so .catch() works.
async function makeTestClient(email) {
  const client = await login(email, PASSWORD);
  return async (url, method, body) => {
    const urlPath = url.replace(BASE, '');
    const raw = await client.req(method, urlPath, body !== undefined ? { body } : {});
    return {
      status: raw.status,
      ok:     raw.ok,
      headers: raw.headers,
      json:   () => Promise.resolve(raw.json),
    };
  };
}

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'deposit-invoice-followup.md');

const CONTACT_ID       = '9988001';
const CONTACT_ID_OTHER = '9988002';
const INVOICE_ID       = '220101';  // belongs to CONTACT_ID
const INVOICE_ID_OTHER = '220102';  // belongs to CONTACT_ID_OTHER
const REALM_ID         = 'PRIVTEST_REALM_DIV';
const CONTACT_EMAIL    = 'privtest-div@example.com';
const CONTACT_FIRST    = 'PrivTest';
const CONTACT_LAST     = 'DepositInvoice';

const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}

function js(v) { return JSON.stringify(v ?? null) ?? 'null'; }

// ── Mock QuickBooks HTTP server ───────────────────────────────────────────────
function startMockQb() {
  const state = {
    paidInvoice:   false,
    partialInvoice: false,
    sendFail:      false,
    sendCalls:     [],
    rateLimitHit:  false,
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      let body = {};
      try { if (raw) body = JSON.parse(raw); } catch {}

      const u = new URL(req.url, `http://${req.headers.host}`);
      const p = u.pathname;

      // GET /v3/company/:realm/invoice/:id
      const invGetM = p.match(/^\/v3\/company\/[^/]+\/invoice\/(\d+)$/);
      if (invGetM && req.method === 'GET') {
        const id = invGetM[1];
        let inv;
        if (id === INVOICE_ID) {
          const balance = state.paidInvoice ? '0.00' : state.partialInvoice ? '450.00' : '900.00';
          inv = {
            Invoice: {
              Id: INVOICE_ID,
              DocNumber: '2201',
              TxnDate: '2026-01-10',
              TotalAmt: '900.00',
              Balance:  balance,
              SyncToken: '5',
              CustomerRef: { value: CONTACT_ID },
              InvoiceLink: 'https://qbo.example.com/pay/inv/2201',
            },
          };
        } else if (id === INVOICE_ID_OTHER) {
          inv = {
            Invoice: {
              Id: INVOICE_ID_OTHER,
              DocNumber: '2202',
              TotalAmt: '500.00',
              Balance:  '500.00',
              SyncToken: '1',
              CustomerRef: { value: CONTACT_ID_OTHER },
            },
          };
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Fault: { Error: [{ Message: 'Object Not Found' }] } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(inv));
        return;
      }

      // GET /v3/company/:realm/query   (CustomerRef search)
      const queryM = p.match(/^\/v3\/company\/[^/]+\/query$/);
      if (queryM && req.method === 'GET') {
        const q = u.searchParams.get('query') || '';
        let rows = [];
        if (q.includes(`CustomerRef = '${CONTACT_ID}'`)) {
          rows = [{
            Id: INVOICE_ID,
            DocNumber: '2201',
            TotalAmt: '900.00',
            Balance: state.paidInvoice ? '0.00' : '900.00',
            CustomerRef: { value: CONTACT_ID },
          }];
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ QueryResponse: { Invoice: rows } }));
        return;
      }

      // POST /v3/company/:realm/invoice/:id/send
      const sendM = p.match(/^\/v3\/company\/[^/]+\/invoice\/([^/]+)\/send$/);
      if (sendM && req.method === 'POST') {
        if (state.rateLimitHit) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Fault: { Error: [{ code: '3200', Message: 'Throttle exceeded' }] } }));
          return;
        }
        state.sendCalls.push({ id: sendM[1] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Invoice: { Id: sendM[1] } }));
        return;
      }

      // POST /v3/company/:realm/invoice (sparse update for void)
      const invPostM = p.match(/^\/v3\/company\/[^/]+\/invoice$/);
      if (invPostM && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Invoice: { Id: body.Id } }));
        return;
      }

      // GET /v3/company/:realm/estimate/:id
      const estGetM = p.match(/^\/v3\/company\/[^/]+\/estimate\/(\d+)$/);
      if (estGetM && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Estimate: { Id: estGetM[1], SyncToken: '1', TxnStatus: 'Pending', CustomerRef: { value: CONTACT_ID } } }));
        return;
      }

      // POST /v3/company/:realm/estimate (sparse update for reject)
      const estPostM = p.match(/^\/v3\/company\/[^/]+\/estimate$/);
      if (estPostM && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Estimate: { Id: body.Id, TxnStatus: body.TxnStatus || 'Rejected' } }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Fault: { Error: [{ Message: 'Not found' }] } }));
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, state, url: `http://127.0.0.1:${port}` });
    });
    server.on('error', reject);
  });
}

// ── Mock HubSpot server ───────────────────────────────────────────────────────
function startMockHubSpot() {
  let lastPatch = null;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      let body = {};
      try { if (raw) body = JSON.parse(raw); } catch {}

      const m = req.url.match(/\/crm\/v3\/objects\/contacts\/(\d+)/);
      if (!m) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'not found' }));
        return;
      }
      const cid = m[1];

      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: cid,
          properties: {
            firstname:        CONTACT_FIRST,
            lastname:         CONTACT_LAST,
            email:            CONTACT_EMAIL,
            phone:            '',
            mobilephone:      '',
            address:          '',
            city:             '',
            zip:              '',
            hs_lead_status:   'DEPOSIT_INVOICE',
          },
        }));
        return;
      }

      if (req.method === 'PATCH') {
        lastPatch = { contactId: cid, properties: body.properties };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: cid, properties: body.properties }));
        return;
      }

      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'method not allowed' }));
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        getLastPatch: () => lastPatch,
        resetPatch: () => { lastPatch = null; },
      });
    });
    server.on('error', reject);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== deposit-invoice-followup integration tests ===\n');

  const DB_URL = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;
  if (!DB_URL) {
    console.error('No DATABASE_URL_TEST or DATABASE_URL set — aborting.');
    process.exit(1);
  }
  const allowShared = process.env.PRIVTEST_ALLOW_SHARED_DB === '1';
  if (!allowShared && !process.env.DATABASE_URL_TEST) {
    console.error('Set DATABASE_URL_TEST=<isolated-db> or PRIVTEST_ALLOW_SHARED_DB=1 to run.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: DB_URL });
  setPool(pool);

  const emailFile = path.join(os.tmpdir(), `div-test-emails-${Date.now()}.json`);

  const [qb, hs] = await Promise.all([startMockQb(), startMockHubSpot()]);
  console.log(`  Mock QB on ${qb.url}`);
  console.log(`  Mock HS on ${hs.url}`);

  // Seed QB tokens into DB so routes see a connected QB
  // qb_tokens has no unique constraint on realm_id so use delete+insert.
  try {
    await pool.query(`DELETE FROM qb_tokens WHERE realm_id = $1`, [REALM_ID]);
    await pool.query(
      `INSERT INTO qb_tokens (realm_id, access_token, refresh_token, expires_at)
       VALUES ($1, 'fake-access-tok', 'fake-refresh-tok', (EXTRACT(EPOCH FROM NOW() + INTERVAL '1 hour') * 1000)::bigint)`,
      [REALM_ID]
    );
  } catch (e) {
    console.warn('  Could not seed QB tokens (may not matter if QB not involved):', e.message);
  }

  // Seed a design_visit row with a stored deposit_invoice_id for probe D
  let designVisitId = null;
  try {
    await pool.query(`
      INSERT INTO design_visits
        (contact_id, status, created_by, deposit_invoice_id, deposit_invoice_doc_num)
      VALUES ($1, 'accepted', 1, $2, '2201')
      ON CONFLICT DO NOTHING
    `, [CONTACT_ID, INVOICE_ID]);
    const dvR = await pool.query(
      `SELECT id FROM design_visits WHERE contact_id = $1 AND deposit_invoice_id = $2`,
      [CONTACT_ID, INVOICE_ID]
    );
    designVisitId = dvR.rows[0]?.id ?? null;
  } catch (e) {
    console.warn('  Could not seed design_visit row:', e.message);
  }

  await resetRateLimitStore(pool);
  await cleanupTestData(pool);
  const RUN_ID = `div-${Date.now()}`;
  const users = await seedUsers(pool, RUN_ID);

  const env = {
    HUBSPOT_ACCESS_TOKEN:        'fake-hs-token',
    HUBSPOT_API_URL:             hs.url,
    QB_API_BASE_OVERRIDE:        qb.url,
    MAIL_TRANSPORT_FILE_OVERRIDE: emailFile,
    NODE_ENV:                    'development',
  };

  let serverHandle;
  try {
    serverHandle = spawnServer({ extraEnv: env });
    await waitForServer();
    console.log(`  Server up at ${BASE}\n`);

    // ── auth.1 — loader requires auth ────────────────────────────────────────
    {
      const r = await fetch(`${BASE}/api/card-actions/deposit-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: CONTACT_ID }),
      });
      record('auth.1', r.status === 401, `unauth loader → ${r.status}`);
    }

    // ── auth.2 — resend requires auth ────────────────────────────────────────
    {
      const r = await fetch(`${BASE}/api/card-actions/deposit-invoice/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: CONTACT_ID, invoiceId: INVOICE_ID }),
      });
      record('auth.2', r.status === 401, `unauth resend → ${r.status}`);
    }

    // ── auth.3 — not-proceeding requires auth ────────────────────────────────
    {
      const r = await fetch(`${BASE}/api/card-actions/deposit-invoice/not-proceeding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: CONTACT_ID }),
      });
      record('auth.3', r.status === 401, `unauth not-proceeding → ${r.status}`);
    }

    const memberClient  = await makeTestClient(users.member.email);
    const managerClient = await makeTestClient(users.manager.email);
    const adminClient   = await makeTestClient(users.admin.email);

    // ── auth.4 — resend requires manager/admin ───────────────────────────────
    {
      const r = await memberClient(`${BASE}/api/card-actions/deposit-invoice/resend`, 'POST', {
        contactId: CONTACT_ID,
        invoiceId: INVOICE_ID,
      });
      record('auth.4', r.status === 403, `member resend → ${r.status} (need manager/admin)`);
    }

    // ── auth.5 — not-proceeding requires manager/admin ───────────────────────
    {
      const r = await memberClient(`${BASE}/api/card-actions/deposit-invoice/not-proceeding`, 'POST', {
        contactId: CONTACT_ID,
      });
      record('auth.5', r.status === 403, `member not-proceeding → ${r.status} (need manager/admin)`);
    }

    // ── (A) Loader: paid invoice ──────────────────────────────────────────────
    {
      qb.state.paidInvoice = true;
      const r = await memberClient(`${BASE}/api/card-actions/deposit-invoice`, 'POST', {
        contactId: CONTACT_ID,
      });
      const body = await r.json().catch(() => ({}));
      record('A',
        r.status === 200 && body.paymentState === 'paid' && body.qbConnected === true,
        `paid invoice → status=${r.status} paymentState=${body.paymentState} qbConnected=${body.qbConnected}`
      );
      qb.state.paidInvoice = false;
    }

    // ── (B) Loader: unpaid invoice ────────────────────────────────────────────
    {
      qb.state.paidInvoice   = false;
      qb.state.partialInvoice = false;
      const r = await memberClient(`${BASE}/api/card-actions/deposit-invoice`, 'POST', {
        contactId: CONTACT_ID,
      });
      const body = await r.json().catch(() => ({}));
      record('B',
        r.status === 200 && body.paymentState === 'unpaid' && body.qbConnected === true,
        `unpaid invoice → status=${r.status} paymentState=${body.paymentState}`
      );
    }

    // ── (B2) Loader: partial payment → paymentState='partial' ────────────────
    {
      qb.state.paidInvoice    = false;
      qb.state.partialInvoice = true;
      const r = await memberClient(`${BASE}/api/card-actions/deposit-invoice`, 'POST', {
        contactId: CONTACT_ID,
      });
      const body = await r.json().catch(() => ({}));
      record('B2',
        r.status === 200
          && body.paymentState === 'partial'
          && body.qbConnected === true
          && body.invoicePaidAmt > 0
          && body.invoiceBalance > 0,
        `partial payment → status=${r.status} paymentState=${body.paymentState} paid=${body.invoicePaidAmt} balance=${body.invoiceBalance}`
      );
      qb.state.partialInvoice = false;
    }

    // ── (C) Loader: QB not connected → qbConnected=false ─────────────────────
    {
      // Temporarily clear QB tokens so the route sees QB as disconnected
      await pool.query(`DELETE FROM qb_tokens WHERE realm_id = $1`, [REALM_ID]);
      const r = await memberClient(`${BASE}/api/card-actions/deposit-invoice`, 'POST', {
        contactId: CONTACT_ID,
      });
      const body = await r.json().catch(() => ({}));
      record('C',
        r.status === 200 && body.qbConnected === false && body.paymentState === 'unknown',
        `QB disconnected → status=${r.status} qbConnected=${body.qbConnected} paymentState=${body.paymentState}`
      );
      // Re-seed QB tokens (delete+insert since qb_tokens has no unique on realm_id)
      await pool.query(`DELETE FROM qb_tokens WHERE realm_id = $1`, [REALM_ID]);
      await pool.query(
        `INSERT INTO qb_tokens (realm_id, access_token, refresh_token, expires_at)
         VALUES ($1, 'fake-access-tok', 'fake-refresh-tok', (EXTRACT(EPOCH FROM NOW() + INTERVAL '1 hour') * 1000)::bigint)`,
        [REALM_ID]
      );
    }

    // ── (D) Loader: stored design_visit invoiceId is returned ────────────────
    {
      const r = await memberClient(`${BASE}/api/card-actions/deposit-invoice`, 'POST', {
        contactId: CONTACT_ID,
      });
      const body = await r.json().catch(() => ({}));
      record('D',
        r.status === 200 && body.invoiceId === INVOICE_ID && body.invoiceDocNum === '2201',
        `stored invoiceId returned → invoiceId=${body.invoiceId} docNum=${body.invoiceDocNum}`
      );
    }

    // ── (E) Resend: success ───────────────────────────────────────────────────
    {
      qb.state.sendCalls = [];
      const r = await managerClient(`${BASE}/api/card-actions/deposit-invoice/resend`, 'POST', {
        contactId: CONTACT_ID,
        invoiceId: INVOICE_ID,
        recipientEmail: CONTACT_EMAIL,
      });
      const body = await r.json().catch(() => ({}));
      const sentInvoice = qb.state.sendCalls.find(c => c.id === INVOICE_ID);
      record('E',
        r.status === 200 && body.ok === true && !!sentInvoice,
        `resend → status=${r.status} ok=${body.ok} QB send called=${!!sentInvoice}`
      );
    }

    // ── (F) Resend: rate limit ────────────────────────────────────────────────
    // Force-exhaust the per-user send rate limit by bumping the DB counter
    {
      try {
        // Exhaust the SEND_LIMIT (10) by clearing existing log rows for this
        // user and inserting exactly 10 within the rolling 1-hour window.
        await pool.query(`DELETE FROM qb_send_log WHERE user_id = $1`, [users.manager.id]);
        for (let i = 0; i < 10; i++) {
          await pool.query(`INSERT INTO qb_send_log (user_id) VALUES ($1)`, [users.manager.id]);
        }
      } catch {
        console.warn('  Could not seed send rate limit — probe F may skip');
      }
      const r = await managerClient(`${BASE}/api/card-actions/deposit-invoice/resend`, 'POST', {
        contactId: CONTACT_ID,
        invoiceId: INVOICE_ID,
        recipientEmail: CONTACT_EMAIL,
      });
      record('F',
        r.status === 429,
        `rate-limited resend → ${r.status}`
      );
      try {
        await pool.query(`DELETE FROM qb_send_log WHERE user_id = $1`, [users.manager.id]);
      } catch {}
    }

    // ── (G) Resend: invoice belongs to different contact → 403 ───────────────
    {
      const r = await adminClient(`${BASE}/api/card-actions/deposit-invoice/resend`, 'POST', {
        contactId: CONTACT_ID,
        invoiceId: INVOICE_ID_OTHER,
        recipientEmail: CONTACT_EMAIL,
      });
      const body = await r.json().catch(() => ({}));
      record('G',
        r.status === 403 && body.code === 'INVOICE_OWNER_MISMATCH',
        `invoice owner mismatch → ${r.status} code=${body.code}`
      );
    }

    // ── (H) Not-proceeding: DECLINED_DEAL, no thank-you ──────────────────────
    {
      hs.resetPatch();
      const r = await adminClient(`${BASE}/api/card-actions/deposit-invoice/not-proceeding`, 'POST', {
        contactId: CONTACT_ID,
        sendThankYou: false,
        contactEmail: CONTACT_EMAIL,
        contactName: `${CONTACT_FIRST} ${CONTACT_LAST}`,
      });
      const body = await r.json().catch(() => ({}));
      const patch = hs.getLastPatch();
      record('H',
        r.status === 200
          && body.ok === true
          && body.hs_lead_status === 'DECLINED_DEAL'
          && patch?.properties?.hs_lead_status === 'DECLINED_DEAL',
        `not-proceeding (no email) → status=${r.status} leadStatus=${patch?.properties?.hs_lead_status}`
      );
    }

    // ── (I) Not-proceeding: sends thank-you email ────────────────────────────
    {
      hs.resetPatch();
      const countEmailFile = () => fs.existsSync(emailFile)
        ? fs.readFileSync(emailFile, 'utf8').split('\n').filter(l => l.trim()).length
        : 0;
      const emailsBefore = countEmailFile();
      const r = await adminClient(`${BASE}/api/card-actions/deposit-invoice/not-proceeding`, 'POST', {
        contactId: CONTACT_ID,
        sendThankYou: true,
        contactEmail: CONTACT_EMAIL,
        contactName: `${CONTACT_FIRST} ${CONTACT_LAST}`,
      });
      const body = await r.json().catch(() => ({}));
      const emailsAfter = countEmailFile();
      record('I',
        r.status === 200 && body.ok === true && emailsAfter > emailsBefore,
        `not-proceeding (with email) → status=${r.status} emailsSent=${emailsAfter - emailsBefore}`
      );
    }

    // ── (J) Template: deposit_invoice_payment_reminder renders vars ──────────
    {
      const r = await adminClient(`${BASE}/api/email-templates/render`, 'POST', {
        key: 'deposit_invoice_payment_reminder',
        vars: {
          firstName:     'Jane',
          invoiceDocNum: ' #1023',
          depositAmount: '£900.00',
          balanceAmount: '£900.00',
          invoiceLink:   'https://pay.example.com/inv/1023',
        },
      });
      const body = await r.json().catch(() => ({}));
      record('J',
        r.status === 200
          && typeof body.subject === 'string'
          && typeof body.body_text === 'string'
          && body.body_text.includes('Jane')
          && body.body_text.includes('£900.00'),
        `template render → status=${r.status} includes-name=${body.body_text?.includes('Jane')} includes-amount=${body.body_text?.includes('£900.00')}`
      );
    }

    // ── (K) Not-proceeding: void paid invoice → 400 ──────────────────────────
    {
      qb.state.paidInvoice = true;
      const r = await adminClient(`${BASE}/api/card-actions/deposit-invoice/not-proceeding`, 'POST', {
        contactId: CONTACT_ID,
        invoiceId: INVOICE_ID,
        voidInvoice: true,
        sendThankYou: false,
        contactEmail: CONTACT_EMAIL,
        contactName: `${CONTACT_FIRST} ${CONTACT_LAST}`,
      });
      const body = await r.json().catch(() => ({}));
      qb.state.paidInvoice = false;
      record('K',
        r.status === 400 && body.code === 'INVOICE_ALREADY_PAID',
        `void paid invoice → ${r.status} code=${body.code}`
      );
    }

  } finally {
    // Cleanup
    if (serverHandle?.child) { try { serverHandle.child.kill('SIGTERM'); } catch {} }
    qb.server.close();
    hs.server.close();

    try { await pool.query(`DELETE FROM qb_tokens WHERE realm_id = $1`, [REALM_ID]); } catch {}
    if (designVisitId) {
      try { await pool.query(`DELETE FROM design_visits WHERE id = $1`, [designVisitId]); } catch {}
    }
    await cleanupTestData(pool);
    await pool.end();
    if (fs.existsSync(emailFile)) try { fs.unlinkSync(emailFile); } catch {}
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const lines = [
    '# deposit-invoice-followup test results',
    '',
    `Run: ${new Date().toISOString()}`,
    '',
    `| Probe | Result | Detail |`,
    `|-------|--------|--------|`,
    ...findings.map(f => `| ${f.id} | ${f.ok ? '✅ PASS' : '❌ FAIL'} | ${f.detail} |`),
    '',
    `**${passed} passed, ${failed} failed**`,
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
