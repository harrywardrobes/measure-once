'use strict';
// test/qb-payment-history/run.js
//
// Integration tests for GET /api/quickbooks/contacts/:contactId/payments.
// Spins up a mock QuickBooks server and an Express app server.
//
// Probes:
//   (AUTH1) Unauthenticated → 401
//   (AUTH2) Member (non-manager/admin) → 403
//   (AUTH3) Invalid contactId (non-numeric) → 400
//   (A) QB not connected → { qbConnected: false }
//   (B) QB connected, no payments/invoices → empty arrays + zero summary
//   (C) Fully paid invoice → status='paid', invoicePaidAmt=totalAmt, invoiceBalance=0
//   (D) Partially paid invoice → status='partial', paidAmt + balance correctly derived
//   (E) Unpaid invoice → status='unpaid', invoicePaidAmt=0
//   (F) Deposit label — invoice matching design_visits.deposit_invoice_id gets label 'Deposit'
//   (G) Ownership guard — Payment with wrong CustomerRef is excluded
//   (H) Summary totals are correct across mixed invoices
//   (I) 60-second in-memory cache: second request within TTL does not issue a new QB query
//   (J) Manager can also call the endpoint (requireManagerOrAdmin, not requireAdmin)
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:qb-payment-history
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:qb-payment-history

/* eslint-disable no-unused-vars */

const fs   = require('fs');
const http = require('http');
const path = require('path');
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

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'qb-payment-history.md');

const CONTACT_ID       = '7701001';
const CONTACT_ID_OTHER = '7701002';
const INVOICE_PAID     = '550101';
const INVOICE_PARTIAL  = '550102';
const INVOICE_UNPAID   = '550103';
const INVOICE_OTHER    = '550199';  // belongs to a different contact
const PAYMENT_APPLIED  = '660001';
const PAYMENT_OTHER    = '660002';  // wrong CustomerRef
const REALM_ID         = 'PRIVTEST_REALM_QBPH';

const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}

// ── Local test client helper ──────────────────────────────────────────────────
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

// ── Mock QuickBooks server ────────────────────────────────────────────────────
function startMockQb() {
  const state = {
    queryCalls: [],
    rejectQueries: false,
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const p = u.pathname;

      // GET /v3/company/:realm/query
      const queryM = p.match(/^\/v3\/company\/[^/]+\/query$/);
      if (queryM && req.method === 'GET') {
        const q = u.searchParams.get('query') || '';
        state.queryCalls.push(q);

        if (state.rejectQueries) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Fault: { Error: [{ Message: 'QB error' }] } }));
          return;
        }

        // Payment query
        if (q.includes('FROM Payment') && q.includes(`CustomerRef = '${CONTACT_ID}'`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            QueryResponse: {
              Payment: [
                {
                  Id: PAYMENT_APPLIED,
                  TxnDate: '2026-03-15',
                  TotalAmt: '450.00',
                  UnappliedAmt: '0.00',
                  CustomerRef: { value: CONTACT_ID },
                  PaymentMethodRef: { name: 'Bank Transfer' },
                  Line: [
                    {
                      Amount: '450.00',
                      LinkedTxn: [{ TxnId: INVOICE_PARTIAL, TxnType: 'Invoice' }],
                    },
                  ],
                },
                // Payment with wrong CustomerRef — should be filtered out
                {
                  Id: PAYMENT_OTHER,
                  TxnDate: '2026-03-01',
                  TotalAmt: '999.00',
                  UnappliedAmt: '0.00',
                  CustomerRef: { value: CONTACT_ID_OTHER },
                  Line: [],
                },
              ],
            },
          }));
          return;
        }

        // Invoice query
        if (q.includes('FROM Invoice') && q.includes(`CustomerRef = '${CONTACT_ID}'`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            QueryResponse: {
              Invoice: [
                {
                  Id: INVOICE_PAID,
                  DocNumber: '3001',
                  TxnDate: '2026-01-10',
                  TotalAmt: '900.00',
                  Balance:  '0.00',
                  CustomerRef: { value: CONTACT_ID },
                },
                {
                  Id: INVOICE_PARTIAL,
                  DocNumber: '3002',
                  TxnDate: '2026-02-01',
                  TotalAmt: '900.00',
                  Balance:  '450.00',
                  CustomerRef: { value: CONTACT_ID },
                },
                {
                  Id: INVOICE_UNPAID,
                  DocNumber: '3003',
                  TxnDate: '2026-02-20',
                  TotalAmt: '500.00',
                  Balance:  '500.00',
                  CustomerRef: { value: CONTACT_ID },
                },
              ],
            },
          }));
          return;
        }

        // Empty response for other contacts
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ QueryResponse: {} }));
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

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== qb-payment-history integration tests ===\n');

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

  const qb = await startMockQb();
  console.log(`  Mock QB on ${qb.url}`);

  // Seed QB tokens
  try {
    await pool.query('DELETE FROM qb_tokens WHERE realm_id = $1', [REALM_ID]);
    await pool.query(
      `INSERT INTO qb_tokens (realm_id, access_token, refresh_token, expires_at)
       VALUES ($1, 'fake-access-tok', 'fake-refresh-tok',
               (EXTRACT(EPOCH FROM NOW() + INTERVAL '1 hour') * 1000)::bigint)`,
      [REALM_ID]
    );
  } catch (e) {
    console.warn('  Could not seed QB tokens:', e.message);
  }

  // Seed a design_visit row so INVOICE_PAID gets the 'Deposit' label
  let designVisitId = null;
  try {
    const dvRes = await pool.query(
      `INSERT INTO design_visits (contact_id, status, created_by, deposit_invoice_id, deposit_invoice_doc_num)
       VALUES ($1, 'accepted', 1, $2, '3001')
       RETURNING id`,
      [CONTACT_ID, INVOICE_PAID]
    );
    designVisitId = dvRes.rows[0]?.id ?? null;
  } catch (e) {
    console.warn('  Could not seed design_visit row:', e.message);
  }

  await resetRateLimitStore(pool);
  await cleanupTestData(pool);
  const RUN_ID = `qbph-${Date.now()}`;
  const users = await seedUsers(pool, RUN_ID);

  const env = {
    QB_API_BASE_OVERRIDE: qb.url,
    NODE_ENV:             'development',
  };

  let serverHandle;
  try {
    serverHandle = spawnServer({ extraEnv: env });
    await waitForServer();
    console.log(`  Server up at ${BASE}\n`);

    const endpointUrl = `${BASE}/api/quickbooks/contacts/${CONTACT_ID}/payments`;

    // ── AUTH1 — unauthenticated → 401 ────────────────────────────────────────
    {
      const r = await fetch(endpointUrl);
      record('AUTH1', r.status === 401, `unauth → ${r.status}`);
    }

    const memberClient  = await makeTestClient(users.member.email);
    const managerClient = await makeTestClient(users.manager.email);
    const adminClient   = await makeTestClient(users.admin.email);

    // ── AUTH2 — member → 403 ─────────────────────────────────────────────────
    {
      const r = await memberClient(endpointUrl, 'GET');
      record('AUTH2', r.status === 403, `member → ${r.status} (need manager/admin)`);
    }

    // ── AUTH3 — invalid contactId → 400 ──────────────────────────────────────
    {
      const r = await adminClient(`${BASE}/api/quickbooks/contacts/not-a-number/payments`, 'GET');
      record('AUTH3', r.status === 400, `invalid contactId → ${r.status}`);
    }

    // ── (A) QB not connected ──────────────────────────────────────────────────
    // Delete tokens so QB appears disconnected
    {
      await pool.query('DELETE FROM qb_tokens WHERE realm_id = $1', [REALM_ID]);
      const r = await adminClient(endpointUrl, 'GET');
      const body = await r.json().catch(() => ({}));
      record('A',
        r.status === 200 && body.qbConnected === false,
        `QB not connected → status=${r.status} qbConnected=${body.qbConnected}`
      );
      // Restore tokens
      await pool.query(
        `INSERT INTO qb_tokens (realm_id, access_token, refresh_token, expires_at)
         VALUES ($1, 'fake-access-tok', 'fake-refresh-tok',
                 (EXTRACT(EPOCH FROM NOW() + INTERVAL '1 hour') * 1000)::bigint)`,
        [REALM_ID]
      );
    }

    // ── (B) QB connected, empty contact → empty arrays ───────────────────────
    {
      const r = await adminClient(`${BASE}/api/quickbooks/contacts/${CONTACT_ID_OTHER}/payments`, 'GET');
      const body = await r.json().catch(() => ({}));
      record('B',
        r.status === 200 &&
        body.qbConnected === true &&
        Array.isArray(body.payments) && body.payments.length === 0 &&
        Array.isArray(body.invoices) && body.invoices.length === 0 &&
        body.summary?.totalInvoiced === 0,
        `empty contact → status=${r.status} payments=${body.payments?.length} invoices=${body.invoices?.length}`
      );
    }

    // ── (C/D/E) Fetch payment history for main contact ────────────────────────
    // Reset cache before this probe by making the first real fetch
    qb.state.queryCalls.length = 0;
    const r = await adminClient(endpointUrl, 'GET');
    const body = await r.json().catch(() => ({}));
    const ok = r.status === 200 && body.qbConnected === true;

    const invPaid    = body.invoices?.find(i => i.invoiceId === INVOICE_PAID);
    const invPartial = body.invoices?.find(i => i.invoiceId === INVOICE_PARTIAL);
    const invUnpaid  = body.invoices?.find(i => i.invoiceId === INVOICE_UNPAID);

    // (C) Paid invoice
    record('C',
      ok && invPaid?.status === 'paid' &&
      invPaid?.invoicePaidAmt === 900 && invPaid?.invoiceBalance === 0,
      `paid invoice → status=${invPaid?.status} paidAmt=${invPaid?.invoicePaidAmt} balance=${invPaid?.invoiceBalance}`
    );

    // (D) Partial invoice
    record('D',
      ok && invPartial?.status === 'partial' &&
      invPartial?.invoicePaidAmt === 450 && invPartial?.invoiceBalance === 450,
      `partial invoice → status=${invPartial?.status} paidAmt=${invPartial?.invoicePaidAmt} balance=${invPartial?.invoiceBalance}`
    );

    // (E) Unpaid invoice
    record('E',
      ok && invUnpaid?.status === 'unpaid' &&
      invUnpaid?.invoicePaidAmt === 0 && invUnpaid?.invoiceBalance === 500,
      `unpaid invoice → status=${invUnpaid?.status} paidAmt=${invUnpaid?.invoicePaidAmt} balance=${invUnpaid?.invoiceBalance}`
    );

    // (F) Deposit label from design_visits
    record('F',
      ok && invPaid?.invoiceLabel === 'Deposit',
      `deposit label → invoiceLabel=${invPaid?.invoiceLabel}`
    );

    // (G) Ownership guard — PAYMENT_OTHER (wrong CustomerRef) must not appear
    {
      const paymentOther = body.payments?.find(p => p.id === PAYMENT_OTHER);
      record('G',
        ok && paymentOther == null,
        `ownership guard → PAYMENT_OTHER present=${paymentOther != null} (expected absent)`
      );
    }

    // (H) Summary totals
    {
      const expectedInvoiced    = 900 + 900 + 500;  // 2300
      const expectedPaid        = 900 + 450;         // 1350
      const expectedOutstanding = 450 + 500;         // 950
      record('H',
        ok &&
        body.summary?.totalInvoiced    === expectedInvoiced    &&
        body.summary?.totalPaid        === expectedPaid        &&
        body.summary?.totalOutstanding === expectedOutstanding,
        `summary → invoiced=${body.summary?.totalInvoiced} paid=${body.summary?.totalPaid} outstanding=${body.summary?.totalOutstanding}`
      );
    }

    // (I) Cache: second request uses cache, no extra QB query calls
    {
      const callsBefore = qb.state.queryCalls.length;
      await adminClient(endpointUrl, 'GET');
      const callsAfter = qb.state.queryCalls.length;
      record('I',
        callsAfter === callsBefore,
        `cache: QB calls before=${callsBefore} after=${callsAfter} (expected unchanged)`
      );
    }

    // (J) Manager can also call the endpoint
    {
      const r2 = await managerClient(endpointUrl, 'GET');
      const b2 = await r2.json().catch(() => ({}));
      record('J',
        r2.status === 200 && b2.qbConnected === true,
        `manager access → status=${r2.status} qbConnected=${b2.qbConnected}`
      );
    }

  } finally {
    if (serverHandle?.child) { try { serverHandle.child.kill('SIGTERM'); } catch {} }
    qb.server.close();

    try { await pool.query('DELETE FROM qb_tokens WHERE realm_id = $1', [REALM_ID]); } catch {}
    if (designVisitId) {
      try { await pool.query('DELETE FROM design_visits WHERE id = $1', [designVisitId]); } catch {}
    }
    await cleanupTestData(pool);
    await pool.end();
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok).length;
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const lines = [
    '# qb-payment-history test results',
    '',
    `Run: ${new Date().toISOString()}`,
    '',
    '| Probe | Result | Detail |',
    '|-------|--------|--------|',
    ...findings.map(f => `| ${f.id} | ${f.ok ? '✅ PASS' : '❌ FAIL'} | ${f.detail} |`),
    '',
    `**${passed} passed, ${failed} failed**`,
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));

  if (failed > 0) process.exit(1);
}

const PROBE_LABELS = [
  '(AUTH1) unauthenticated → 401',
  '(AUTH2) member → 403',
  '(AUTH3) invalid contactId → 400',
  '(A) QB not connected',
  '(B) QB connected, no payments/invoices → empty arrays + zero summary',
  '(C) fully paid invoice → status=paid',
  '(D) partially paid invoice → status=partial',
  '(E) unpaid invoice → status=unpaid',
  '(F) deposit label — invoice matching design_visits.deposit_invoice_id labelled Deposit',
  '(G) ownership guard — payment with wrong CustomerRef excluded',
  '(H) summary totals correct across mixed invoices',
  '(I) 60-second in-memory cache — second request hits no QB query',
  '(J) manager can call the endpoint (requireManagerOrAdmin)',
];
void PROBE_LABELS;

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
