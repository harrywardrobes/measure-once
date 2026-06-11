'use strict';
// test/open-deal/run.js
//
// Integration tests for the OpenDealActionModal backend flows in quickbooks.js.
// Spins up a mock QuickBooks HTTP server (QB_API_BASE_OVERRIDE) and a mock
// HubSpot server (HUBSPOT_API_URL), captures outgoing emails via
// MAIL_TRANSPORT_FILE_OVERRIDE, and exercises the accept-deal / decline-deal
// routes against an isolated test DB.
//
// Probes:
//   (A) Default 10% deposit: invoice Amount = 10% of estimate TotalAmt
//   (B) Custom depositPercent from qb_settings is applied on accept-deal
//   (C) BillEmailBcc/BillEmailCc set on every QB send when copy_me_email configured
//   (D) qb_settings round-trip: GET returns defaults, PUT takes effect, accept-deal uses updated values
//   (E) Accept-deal full flow: estimate Accepted, other estimates Rejected, deposit invoice created/sent, app email sent, lead status → DEPOSIT_INVOICE
//   (F) Decline flow: estimates Rejected, thank-you email sent (or skipped), lead status → DECLINED_DEAL
//   (G) Failed invoice send does not advance lead status
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:open-deal
//   PRIVTEST_ALLOW_SHARED_DB=1      npm run test:open-deal

const PROBE_LABELS = [
  '(A) default 10% deposit calculated from estimate TotalAmt',
  '(B) custom depositPercent from qb_settings applied on accept-deal',
  '(C) BillEmailBcc/BillEmailCc set on QB send when copy_me_email configured',
  '(D) qb_settings round-trip: GET defaults, PUT updates, accept-deal uses new values',
  '(E) accept-deal full flow: estimate Accepted, others Rejected, invoice created/sent, app email, lead status DEPOSIT_INVOICE',
  '(F) decline flow: estimates Rejected, thank-you sent or skipped, lead status DECLINED_DEAL',
  '(G) failed invoice send does not advance lead status and contact stays OPEN_DEAL',
  '(H) amendments path: data-load endpoint is non-mutating, lead status stays OPEN_DEAL',
  '(I) idempotency: second accept-deal call for same estimate returns existing invoice, no duplicate created',
  '(J) concurrent idempotency: two simultaneous accept-deal calls for the same estimate produce exactly one QB invoice',
  '(K) concurrent-retry send guard: two simultaneous retries (invoice already exists) produce exactly one QB send; losing caller gets sendSkipped=true',
  '(L) concurrent-decline guard: two simultaneous decline-deal calls produce exactly one thank-you email',
];

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'open-deal.md');

// All estimate / invoice IDs must pass /^\d+$/ in the route validators.
// Using numeric-only IDs avoids the 400 "must be numeric QB ID" guard.
const EST_A           = '110001';
const EST_B           = '110002';
const EST_C           = '110003';
const EST_D           = '110004';
const EST_E1          = '110005'; // chosen estimate for accept-deal
const EST_E2          = '110006'; // extra estimate to be declined
const EST_F1          = '110007';
const EST_F2          = '110008';
const EST_F3          = '110009';
const EST_G           = '110010';
const EST_I           = '110011'; // idempotency probe
const EST_J           = '110012'; // concurrent idempotency probe
const EST_K           = '110013'; // concurrent-retry send guard probe
const EST_L           = '110014'; // concurrent-decline guard probe
const INV_STANDALONE  = '119900'; // for standalone /invoice/:id/send probe in C
const INV_K           = '119902'; // pre-seeded invoice for probe K

// Fake numeric HubSpot contact IDs (must pass /^\d+$/ checks in routes)
const CONTACT_ID       = '7654321';
const CONTACT_ID_EXTRA = '7654322'; // used for the no-thank-you branch of probe F
const CONTACT_ID_L     = '7654330'; // used for concurrent-decline guard probe L
const REALM_ID         = 'PRIVTEST_REALM_OPEN_DEAL';
const CONTACT_EMAIL    = 'privtest-open-deal@example.com';
const CONTACT_NAME     = 'PrivTest OpenDeal';

const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}

// Safe stringify that never returns `undefined` (JSON.stringify(undefined/fn) = undefined).
function js(v) { return JSON.stringify(v ?? null) ?? 'null'; }

// ── Mock QuickBooks HTTP server ───────────────────────────────────────────────
function startMockQb() {
  const state = {
    estimates: {},   // { [id]: EstimateObj }
    invoices:  {},   // { [id]: InvoiceObj }
    nextId:    200001,
    calls:     [],   // { method, path, body }
    sendFail:  false,
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      let body = {};
      try { if (raw) body = JSON.parse(raw); } catch {}

      const u = new URL(req.url, `http://${req.headers.host}`);
      const p = u.pathname;
      state.calls.push({ method: req.method, path: p, body });

      // POST /v3/company/:realm/invoice/:id/send
      const sendM = p.match(/^\/v3\/company\/[^/]+\/invoice\/([^/]+)\/send$/);
      if (sendM && req.method === 'POST') {
        if (state.sendFail) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ Fault: { Error: [{ Message: 'Send failed (test stub)' }] } }));
        }
        const id  = decodeURIComponent(sendM[1]);
        const inv = state.invoices[id] || { Id: id, SyncToken: '0' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ Invoice: inv }));
      }

      // GET /v3/company/:realm/invoice/:id
      const invGetM = p.match(/^\/v3\/company\/[^/]+\/invoice\/([^/]+)$/);
      if (invGetM && req.method === 'GET') {
        const id  = decodeURIComponent(invGetM[1]);
        const inv = state.invoices[id];
        if (!inv) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ Fault: { Error: [{ Message: 'Invoice not found' }] } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ Invoice: inv }));
      }

      // POST /v3/company/:realm/invoice (create or sparse-update)
      const invPostM = p.match(/^\/v3\/company\/[^/]+\/invoice$/);
      if (invPostM && req.method === 'POST') {
        if (body.sparse && body.Id) {
          const existing = state.invoices[body.Id] || { Id: body.Id, SyncToken: '0' };
          const updated  = { ...existing, ...body, SyncToken: String((parseInt(existing.SyncToken, 10) || 0) + 1) };
          state.invoices[body.Id] = updated;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ Invoice: updated }));
        }
        // Create invoice
        const newId  = String(state.nextId++);
        const newInv = {
          Id:        newId,
          DocNumber: `INVDOC${newId}`,
          SyncToken: '0',
          TotalAmt:  body.Line?.[0]?.Amount || 0,
          ...body,
          Id: newId, // force generated ID
        };
        state.invoices[newId] = newInv;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ Invoice: newInv }));
      }

      // GET /v3/company/:realm/estimate/:id
      const estGetM = p.match(/^\/v3\/company\/[^/]+\/estimate\/([^/]+)$/);
      if (estGetM && req.method === 'GET') {
        const id  = decodeURIComponent(estGetM[1]);
        const est = state.estimates[id];
        if (!est) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ Fault: { Error: [{ Message: 'Estimate not found' }] } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ Estimate: est }));
      }

      // POST /v3/company/:realm/estimate (sparse update)
      const estPostM = p.match(/^\/v3\/company\/[^/]+\/estimate$/);
      if (estPostM && req.method === 'POST') {
        if (body.Id != null) {
          const existing = state.estimates[body.Id] || { Id: body.Id, SyncToken: '0' };
          const updated  = { ...existing, ...body, SyncToken: String((parseInt(existing.SyncToken, 10) || 0) + 1) };
          state.estimates[body.Id] = updated;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ Estimate: updated }));
        }
        const newId  = String(state.nextId++);
        const newEst = { Id: newId, SyncToken: '0', TxnStatus: 'Pending', ...body, Id: newId };
        state.estimates[newId] = newEst;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ Estimate: newEst }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', path: p }));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, state });
    });
  });
}

// ── Mock HubSpot HTTP server ──────────────────────────────────────────────────
function startMockHubSpot() {
  const state = {
    patches: [],   // { contactId, properties }
    contactProps: {
      firstname:      'PrivTest',
      lastname:       'OpenDeal',
      email:          CONTACT_EMAIL,
      hs_lead_status: 'OPEN_DEAL',
    },
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      let body = {};
      try { if (raw) body = JSON.parse(raw); } catch {}

      const u = new URL(req.url, `http://${req.headers.host}`);
      const p = u.pathname;

      // PATCH /crm/v3/objects/contacts/:id  (patchContactProperties)
      const patchM = p.match(/^\/crm\/v3\/objects\/contacts\/([^/]+)$/);
      if (patchM && req.method === 'PATCH') {
        state.patches.push({ contactId: patchM[1], properties: body.properties || {} });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: patchM[1], properties: body.properties || {} }));
      }

      // GET /crm/v3/objects/contacts/:id  (open-deal data load + accept/decline flows)
      const getM = p.match(/^\/crm\/v3\/objects\/contacts\/(\d+)$/);
      if (getM && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: getM[1], properties: state.contactProps }));
      }

      // POST /crm/v3/objects/contacts/search — lead-status count on boot
      if (p === '/crm/v3/objects/contacts/search' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ results: [], total: 0, paging: {} }));
      }

      // GET/POST /crm/v3/properties/contacts — ensureHubSpotProperties on boot
      if (p === '/crm/v3/properties/contacts') {
        res.writeHead(req.method === 'GET' ? 200 : 409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ results: [] }));
      }

      // Catch-all HubSpot paths (pipelines, owners, etc.) used during boot
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [], total: 0, paging: {} }));
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, state });
    });
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function apiPost(base, urlPath, cookie, body = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const r = await fetch(`${base}${urlPath}`, {
    method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual',
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

async function apiGet(base, urlPath, cookie) {
  const headers = cookie ? { cookie } : {};
  const r = await fetch(`${base}${urlPath}`, { headers, redirect: 'manual' });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

async function apiPut(base, urlPath, cookie, body = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const r = await fetch(`${base}${urlPath}`, {
    method: 'PUT', headers, body: JSON.stringify(body), redirect: 'manual',
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

// ── Mail capture ──────────────────────────────────────────────────────────────

function readMailFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function seedQbToken(pool) {
  await pool.query('DELETE FROM qb_tokens');
  await pool.query(
    `INSERT INTO qb_tokens (access_token, refresh_token, realm_id, expires_at)
     VALUES ('privtest-at', 'privtest-rt', $1, $2)`,
    [REALM_ID, Date.now() + 24 * 60 * 60 * 1000]
  );
}

// Ensure the keys used by accept-deal / decline-deal are present in
// lead_status_config.  DEPOSIT_INVOICE and OPEN_DEAL are now included in
// DEFAULT_LEAD_STATUSES so they will already exist on a fresh boot, but we
// upsert here as a belt-and-braces guard for isolated test DBs that bypass
// the server boot seed.
async function ensureLeadStatusKeys(pool) {
  for (const [key, label] of [
    ['OPEN_DEAL',       'Open Deal'],
    ['DEPOSIT_INVOICE', 'Deposit Invoice'],
    ['DECLINED_DEAL',   'Declined Deal'],
  ]) {
    await pool.query(
      `INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
       VALUES ($1, $2, 999, false)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label`,
      [key, label]
    );
  }
}

async function clearQbSettings(pool) {
  await pool.query('DELETE FROM qb_settings');
}

async function clearSendLog(pool, userId) {
  if (userId) await pool.query('DELETE FROM qb_send_log WHERE user_id = $1', [userId]);
}

async function clearOpenDealInvoices(pool) {
  // Remove any rows seeded by a previous run of this test suite so the
  // idempotency guard starts each run with a clean slate.
  const estIds = [EST_A, EST_B, EST_C, EST_D, EST_E1, EST_E2, EST_F1, EST_F2, EST_F3, EST_G, EST_I, EST_J, EST_K];
  await pool.query(
    'DELETE FROM open_deal_invoices WHERE estimate_id = ANY($1::text[])',
    [estIds]
  ).catch(() => { /* table may not exist on first boot before migrations */ });
}

async function clearOpenDealDeclines(pool) {
  // Remove any decline-guard rows left by a previous run so each test run
  // starts with a clean slate for the advisory-lock + declined_at checks.
  const contactIds = [CONTACT_ID, CONTACT_ID_EXTRA, CONTACT_ID_L];
  await pool.query(
    'DELETE FROM open_deal_declines WHERE contact_id = ANY($1::text[])',
    [contactIds]
  ).catch(() => { /* table may not exist on first boot before migrations */ });
}

// ── main ─────────────────────────────────────────────────────────────────────

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
  console.log(`\n  open-deal integration tests  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool   = new Pool({ connectionString: connStr });
  const mockQb = await startMockQb();
  const mockHs = await startMockHubSpot();

  console.log(`  mock QB on port ${mockQb.port}`);
  console.log(`  mock HubSpot on port ${mockHs.port}`);

  // Set env vars BEFORE spawnServer so the child inherits them.
  process.env.QB_API_BASE_OVERRIDE              = `http://127.0.0.1:${mockQb.port}`;
  process.env.HUBSPOT_API_URL                   = `http://127.0.0.1:${mockHs.port}`;
  // PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN=1 is required: the harness's optionalPassthrough
  // only forwards HUBSPOT_ACCESS_TOKEN to the spawned child when this flag is set.
  process.env.HUBSPOT_ACCESS_TOKEN              = 'privtest-hs-token';
  process.env.PRIVTEST_USE_HUBSPOT_ACCESS_TOKEN = '1';

  // Mail capture — server will write sent emails as JSONL lines to this file.
  const mailFile = path.join(os.tmpdir(), `mo-open-deal-mail-${runId}.jsonl`);
  process.env.MAIL_TRANSPORT_FILE_OVERRIDE = mailFile;
  if (fs.existsSync(mailFile)) fs.unlinkSync(mailFile);

  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool, BASE,
  } = require('../privileges/harness');
  setPool(pool);

  await cleanupTestData(pool);
  await resetRateLimitStore(pool);
  await clearOpenDealInvoices(pool);
  await clearOpenDealDeclines(pool);

  const { child } = spawnServer();
  let exitCode = 1;

  const stop = () => { try { child.kill('SIGTERM'); } catch {} };
  process.on('SIGINT',  () => { stop(); process.exit(130); });
  process.on('SIGTERM', () => { stop(); process.exit(143); });

  try {
    await waitForServer();
    console.log(`  server up at ${BASE}`);

    // Seed required DB fixtures after the server has booted and created its tables.
    await seedQbToken(pool);
    await ensureLeadStatusKeys(pool);
    await clearQbSettings(pool);

    const users = await seedUsers(pool, runId);
    const admin = await login(users.admin.email, users.admin.password);
    const mgr   = await login(users.manager.email, users.manager.password);

    // ─────────────────────────────────────────────────────────────────────────
    // Probe A: Default 10% deposit calculation
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n  [A] Default 10% deposit from estimate TotalAmt');
    {
      await clearQbSettings(pool);
      await clearSendLog(pool, users.manager.id);
      mockQb.state.calls.length = 0;
      mockHs.state.patches.length = 0;
      if (fs.existsSync(mailFile)) fs.unlinkSync(mailFile);

      const TOTAL_A = 1200;
      mockQb.state.estimates[EST_A] = {
        Id: EST_A, SyncToken: '1', TxnStatus: 'Pending',
        TotalAmt: TOTAL_A,
        CustomerRef: { value: CONTACT_ID },
      };

      const r = await apiPost(BASE, `/api/quickbooks/contacts/${CONTACT_ID}/accept-deal`, mgr.cookie, {
        estimateId:   EST_A,
        contactEmail: CONTACT_EMAIL,
        contactName:  CONTACT_NAME,
      });

      const createCall = mockQb.state.calls.find(
        c => c.method === 'POST' && c.path.endsWith('/invoice') && !c.body.Id && !c.body.sparse
      );
      const depositAmt  = createCall?.body?.Line?.[0]?.Amount;
      const expectedAmt = Math.round(TOTAL_A * 0.10 * 100) / 100;
      const amountOk    = depositAmt === expectedAmt;
      record('A.deposit-amount', amountOk,
        amountOk
          ? `Amount=${depositAmt} (10% of ${TOTAL_A} = ${expectedAmt})`
          : `expected ${expectedAmt}, got ${depositAmt} — HTTP ${r.status}: ${js(r.body).slice(0, 120)}`);

      const desc   = createCall?.body?.Line?.[0]?.Description ?? '';
      const descOk = typeof desc === 'string' && desc.includes('10%');
      record('A.deposit-description', descOk,
        descOk ? `Description="${desc}"` : `Description missing "10%": "${desc}"`);

      const statusOk = r.body?.hs_lead_status === 'DEPOSIT_INVOICE';
      record('A.lead-status', statusOk,
        statusOk ? 'hs_lead_status=DEPOSIT_INVOICE' : `response: ${js(r.body).slice(0, 150)}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Probe B: Custom depositPercent from qb_settings
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n  [B] Custom depositPercent from qb_settings');
    {
      await clearQbSettings(pool);
      await clearSendLog(pool, users.manager.id);
      mockQb.state.calls.length = 0;
      mockHs.state.patches.length = 0;
      if (fs.existsSync(mailFile)) fs.unlinkSync(mailFile);

      // Set a custom deposit percent via the admin settings endpoint.
      const putR = await apiPut(BASE, '/api/admin/qb-settings', admin.cookie, { depositPercent: 25 });
      if (putR.status !== 200) {
        record('B.custom-percent', false, `PUT qb-settings failed: HTTP ${putR.status} ${js(putR.body)}`);
        record('B.description-uses-custom-percent', false, 'skipped — settings PUT failed');
      } else {
        const TOTAL_B = 800;
        mockQb.state.estimates[EST_B] = {
          Id: EST_B, SyncToken: '1', TxnStatus: 'Pending',
          TotalAmt: TOTAL_B,
          CustomerRef: { value: CONTACT_ID },
        };

        const r = await apiPost(BASE, `/api/quickbooks/contacts/${CONTACT_ID}/accept-deal`, mgr.cookie, {
          estimateId:   EST_B,
          contactEmail: CONTACT_EMAIL,
          contactName:  CONTACT_NAME,
        });

        const createCall  = mockQb.state.calls.find(
          c => c.method === 'POST' && c.path.endsWith('/invoice') && !c.body.Id && !c.body.sparse
        );
        const depositAmt  = createCall?.body?.Line?.[0]?.Amount;
        const expectedAmt = Math.round(TOTAL_B * 0.25 * 100) / 100; // 200
        const amountOk    = depositAmt === expectedAmt;
        record('B.custom-percent', amountOk,
          amountOk
            ? `Amount=${depositAmt} (25% of ${TOTAL_B} = ${expectedAmt})`
            : `expected ${expectedAmt}, got ${depositAmt} — HTTP ${r.status}: ${js(r.body).slice(0, 120)}`);

        const desc   = createCall?.body?.Line?.[0]?.Description ?? '';
        const descOk = typeof desc === 'string' && desc.includes('25%');
        record('B.description-uses-custom-percent', descOk,
          descOk ? `Description="${desc}"` : `Description missing "25%": "${desc}"`);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Probe C: BillEmailBcc/BillEmailCc on every QB send
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n  [C] BillEmailBcc/Cc set from copy_me_email');
    {
      await clearQbSettings(pool);
      await clearSendLog(pool, users.manager.id);
      await clearSendLog(pool, users.admin.id);
      const COPY_EMAIL = 'copy-me@example.com';
      await apiPut(BASE, '/api/admin/qb-settings', admin.cookie, {
        copyMeEmail:    COPY_EMAIL,
        copyMeMode:     'bcc',
        depositPercent: 10,
      });

      mockQb.state.calls.length = 0;
      mockHs.state.patches.length = 0;
      if (fs.existsSync(mailFile)) fs.unlinkSync(mailFile);

      mockQb.state.estimates[EST_C] = {
        Id: EST_C, SyncToken: '1', TxnStatus: 'Pending',
        TotalAmt: 1000,
        CustomerRef: { value: CONTACT_ID },
      };

      await apiPost(BASE, `/api/quickbooks/contacts/${CONTACT_ID}/accept-deal`, mgr.cookie, {
        estimateId:   EST_C,
        contactEmail: CONTACT_EMAIL,
        contactName:  CONTACT_NAME,
      });

      // sendQbTransactionEmail: fetches invoice (GET), sparse-updates CC/BCC, then sends.
      const bccCall = mockQb.state.calls.find(
        c => c.method === 'POST' && c.path.endsWith('/invoice')
          && c.body.sparse === true
          && (c.body.BillEmailBcc || c.body.BillEmailCc)
      );
      const bccAddr = bccCall?.body?.BillEmailBcc?.Address ?? bccCall?.body?.BillEmailCc?.Address;
      const bccOk   = bccAddr === COPY_EMAIL;
      record('C.accept-deal-bcc', bccOk,
        bccOk
          ? `sparse update sets BillEmail(Bcc/Cc).Address=${COPY_EMAIL}`
          : `no BCC/CC sparse-update found | invoice POSTs=${js(mockQb.state.calls.filter(c=>c.path.endsWith('/invoice')&&c.method==='POST').map(c=>({sparse:c.body.sparse,BCC:c.body.BillEmailBcc,CC:c.body.BillEmailCc}))).slice(0,300)}`);

      const sendCall = mockQb.state.calls.find(
        c => c.method === 'POST' && /\/invoice\/[^/]+\/send$/.test(c.path)
      );
      record('C.send-call-made', !!sendCall,
        sendCall ? `send POST at ${sendCall.path}` : 'no send call found');

      // Also test the standalone /api/quickbooks/invoice/:id/send endpoint.
      mockQb.state.invoices[INV_STANDALONE] = { Id: INV_STANDALONE, SyncToken: '0', TotalAmt: 500 };
      await clearSendLog(pool, users.admin.id);
      mockQb.state.calls.length = 0;

      await apiPost(BASE, `/api/quickbooks/invoice/${INV_STANDALONE}/send`, admin.cookie, {
        email: CONTACT_EMAIL,
      });

      const bccCallStd = mockQb.state.calls.find(
        c => c.method === 'POST' && c.path.endsWith('/invoice')
          && c.body.sparse === true
          && (c.body.BillEmailBcc || c.body.BillEmailCc)
      );
      const bccAddrStd = bccCallStd?.body?.BillEmailBcc?.Address ?? bccCallStd?.body?.BillEmailCc?.Address;
      const bccOkStd   = bccAddrStd === COPY_EMAIL;
      record('C.standalone-send-bcc', bccOkStd,
        bccOkStd
          ? `standalone send also sets BillEmail(Bcc/Cc).Address=${COPY_EMAIL}`
          : `no BCC/CC sparse-update on standalone send | invoice POSTs=${js(mockQb.state.calls.filter(c=>c.path.endsWith('/invoice')&&c.method==='POST').map(c=>({sparse:c.body.sparse,BCC:c.body.BillEmailBcc,CC:c.body.BillEmailCc}))).slice(0,300)}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Probe D: qb_settings round-trip
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n  [D] qb_settings round-trip');
    {
      await clearQbSettings(pool);

      // D.1: GET returns defaults when no row exists
      const getDefault = await apiGet(BASE, '/api/admin/qb-settings', admin.cookie);
      const defPctOk   = getDefault.body?.depositPercent === 10;
      const defModeOk  = typeof getDefault.body?.copyMeMode === 'string';
      record('D.get-defaults', defPctOk && defModeOk,
        defPctOk && defModeOk
          ? `depositPercent=${getDefault.body?.depositPercent} copyMeMode=${getDefault.body?.copyMeMode}`
          : `unexpected defaults: ${js(getDefault.body)}`);

      // D.2: PUT changes values
      const putR = await apiPut(BASE, '/api/admin/qb-settings', admin.cookie, {
        depositPercent: 15,
        copyMeEmail:    'updated-copy@example.com',
        copyMeMode:     'cc',
      });
      const putOk = putR.body?.depositPercent === 15 && putR.body?.copyMeMode === 'cc';
      record('D.put-response', putOk,
        putOk
          ? 'PUT response reflects updated values (depositPercent=15, copyMeMode=cc)'
          : `PUT response: ${js(putR.body)}`);

      // D.3: GET confirms updated values
      const getUpd = await apiGet(BASE, '/api/admin/qb-settings', admin.cookie);
      const updOk  = getUpd.body?.depositPercent === 15
        && getUpd.body?.copyMeEmail === 'updated-copy@example.com'
        && getUpd.body?.copyMeMode  === 'cc';
      record('D.get-after-put', updOk,
        updOk ? 'GET after PUT returns updated values' : `GET: ${js(getUpd.body)}`);

      // D.4: accept-deal uses the updated depositPercent (15%)
      await clearSendLog(pool, users.manager.id);
      mockQb.state.calls.length = 0;
      mockHs.state.patches.length = 0;
      if (fs.existsSync(mailFile)) fs.unlinkSync(mailFile);

      const TOTAL_D = 1000;
      mockQb.state.estimates[EST_D] = {
        Id: EST_D, SyncToken: '1', TxnStatus: 'Pending',
        TotalAmt: TOTAL_D,
        CustomerRef: { value: CONTACT_ID },
      };

      const rD = await apiPost(BASE, `/api/quickbooks/contacts/${CONTACT_ID}/accept-deal`, mgr.cookie, {
        estimateId:   EST_D,
        contactEmail: CONTACT_EMAIL,
        contactName:  CONTACT_NAME,
      });

      const createCallD = mockQb.state.calls.find(
        c => c.method === 'POST' && c.path.endsWith('/invoice') && !c.body.Id && !c.body.sparse
      );
      const expectedD = Math.round(TOTAL_D * 0.15 * 100) / 100; // 150
      const amtDOk    = createCallD?.body?.Line?.[0]?.Amount === expectedD;
      record('D.accept-deal-uses-updated-pct', amtDOk,
        amtDOk
          ? `invoice Amount=${expectedD} matches updated 15%`
          : `expected ${expectedD}, got ${createCallD?.body?.Line?.[0]?.Amount} — HTTP ${rD.status}: ${js(rD.body).slice(0, 120)}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Probe E: Accept-deal full flow
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n  [E] Accept-deal full flow');
    {
      await clearQbSettings(pool); // defaults (10%)
      await clearSendLog(pool, users.manager.id);
      mockQb.state.calls.length = 0;
      mockHs.state.patches.length = 0;
      if (fs.existsSync(mailFile)) fs.unlinkSync(mailFile);

      mockQb.state.estimates[EST_E1] = {
        Id: EST_E1, SyncToken: '2', TxnStatus: 'Pending',
        TotalAmt: 2000,
        CustomerRef: { value: CONTACT_ID },
      };
      mockQb.state.estimates[EST_E2] = {
        Id: EST_E2, SyncToken: '3', TxnStatus: 'Pending',
        TotalAmt: 1500,
        CustomerRef: { value: CONTACT_ID },
      };

      const r = await apiPost(BASE, `/api/quickbooks/contacts/${CONTACT_ID}/accept-deal`, mgr.cookie, {
        estimateId:                EST_E1,
        otherEstimateIdsToDecline: [EST_E2],
        contactEmail:              CONTACT_EMAIL,
        contactName:               CONTACT_NAME,
      });

      record('E.http-ok', r.status === 200,
        r.status === 200 ? 'HTTP 200' : `HTTP ${r.status}: ${js(r.body).slice(0, 150)}`);

      {
        // E.2: Chosen estimate marked Accepted
        const accCall = mockQb.state.calls.find(
          c => c.method === 'POST' && c.path.endsWith('/estimate')
            && c.body.Id === EST_E1 && c.body.TxnStatus === 'Accepted'
        );
        record('E.estimate-accepted', !!accCall,
          accCall ? `POST estimate ${EST_E1} TxnStatus=Accepted` : 'no Accepted estimate POST found');

        // E.3: Other estimate marked Rejected
        const rejCall = mockQb.state.calls.find(
          c => c.method === 'POST' && c.path.endsWith('/estimate')
            && c.body.Id === EST_E2 && c.body.TxnStatus === 'Rejected'
        );
        record('E.other-estimate-rejected', !!rejCall,
          rejCall ? `POST estimate ${EST_E2} TxnStatus=Rejected` : 'no Rejected estimate POST found');

        // E.4: Deposit invoice created
        const invCreate = mockQb.state.calls.find(
          c => c.method === 'POST' && c.path.endsWith('/invoice') && !c.body.Id && !c.body.sparse
        );
        record('E.invoice-created', !!invCreate,
          invCreate ? `invoice create Amount=${invCreate.body?.Line?.[0]?.Amount}` : 'no invoice create POST');

        // E.5: Invoice sent via QB
        const sentCall = mockQb.state.calls.find(
          c => c.method === 'POST' && /\/invoice\/[^/]+\/send$/.test(c.path)
        );
        record('E.invoice-sent', !!sentCall,
          sentCall ? `send POST at ${sentCall.path}` : 'no invoice send POST');

        // E.6: App email sent
        const mails   = readMailFile(mailFile);
        const appMail = mails.find(m =>
          (typeof m.to === 'string' ? m.to : (m.to?.[0] || '')) === CONTACT_EMAIL
          && String(m.subject || '').toLowerCase().includes('deposit')
        );
        record('E.app-email-sent', !!appMail,
          appMail
            ? `deposit email sent to ${CONTACT_EMAIL}, subject="${appMail.subject}"`
            : `no deposit email. mails=${js(mails.map(m => ({ to: m.to, subject: m.subject }))).slice(0, 200)}`);

        // E.7: Lead status → DEPOSIT_INVOICE via HubSpot PATCH
        const patch = mockHs.state.patches.find(
          p => p.contactId === CONTACT_ID && p.properties?.hs_lead_status === 'DEPOSIT_INVOICE'
        );
        record('E.lead-status', !!patch,
          patch
            ? `HubSpot PATCH hs_lead_status=DEPOSIT_INVOICE contactId=${patch.contactId}`
            : `no DEPOSIT_INVOICE PATCH. patches=${js(mockHs.state.patches).slice(0, 200)}`);

        // E.8: Response steps flags
        const steps  = r.body?.steps;
        const stepsOk = steps?.estimateAccepted
          && steps?.invoiceCreated
          && steps?.invoiceSent
          && steps?.appEmailSent
          && steps?.statusUpdated;
        record('E.steps-complete', !!stepsOk,
          stepsOk ? 'all step flags true' : `steps: ${js(steps)}`);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Probe F: Decline flow
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n  [F] Decline flow');
    {
      await clearQbSettings(pool);
      mockQb.state.calls.length = 0;
      mockHs.state.patches.length = 0;
      if (fs.existsSync(mailFile)) fs.unlinkSync(mailFile);

      mockQb.state.estimates[EST_F1] = {
        Id: EST_F1, SyncToken: '2', TxnStatus: 'Pending',
        TotalAmt: 900, CustomerRef: { value: CONTACT_ID },
      };
      mockQb.state.estimates[EST_F2] = {
        Id: EST_F2, SyncToken: '3', TxnStatus: 'Pending',
        TotalAmt: 600, CustomerRef: { value: CONTACT_ID },
      };

      // F.1: Decline WITH thank-you email
      const r1 = await apiPost(BASE, `/api/quickbooks/contacts/${CONTACT_ID}/decline-deal`, mgr.cookie, {
        estimateIds:  [EST_F1, EST_F2],
        sendThankYou: true,
        contactEmail: CONTACT_EMAIL,
        contactName:  CONTACT_NAME,
      });

      record('F.http-ok', r1.status === 200,
        r1.status === 200 ? 'HTTP 200' : `HTTP ${r1.status}: ${js(r1.body).slice(0, 150)}`);

      const rejF1 = mockQb.state.calls.find(
        c => c.method === 'POST' && c.path.endsWith('/estimate')
          && c.body.Id === EST_F1 && c.body.TxnStatus === 'Rejected'
      );
      const rejF2 = mockQb.state.calls.find(
        c => c.method === 'POST' && c.path.endsWith('/estimate')
          && c.body.Id === EST_F2 && c.body.TxnStatus === 'Rejected'
      );
      record('F.estimates-rejected', !!(rejF1 && rejF2),
        rejF1 && rejF2 ? 'both estimates marked Rejected' : `F1 rejected=${!!rejF1} F2 rejected=${!!rejF2}`);

      const mails1    = readMailFile(mailFile);
      const thankMail = mails1.find(m =>
        String(m.subject || '').toLowerCase().includes('thank')
        || String(m.subject || '').toLowerCase().includes('declin')
      );
      record('F.thank-you-sent', !!thankMail,
        thankMail
          ? `thank-you email: to=${js(thankMail.to)} subject="${thankMail.subject}"`
          : `no thank-you email. mails=${js(mails1.map(m => ({ to: m.to, subject: m.subject }))).slice(0, 200)}`);

      const patchF = mockHs.state.patches.find(
        p => p.contactId === CONTACT_ID && p.properties?.hs_lead_status === 'DECLINED_DEAL'
      );
      record('F.lead-status-declined', !!patchF,
        patchF
          ? `PATCH hs_lead_status=DECLINED_DEAL contactId=${patchF.contactId}`
          : `no DECLINED_DEAL PATCH. patches=${js(mockHs.state.patches).slice(0, 200)}`);

      // F.2: Decline WITHOUT thank-you (different contact to keep mail log clean)
      mockQb.state.calls.length = 0;
      mockHs.state.patches.length = 0;
      if (fs.existsSync(mailFile)) fs.unlinkSync(mailFile);

      mockQb.state.estimates[EST_F3] = {
        Id: EST_F3, SyncToken: '1', TxnStatus: 'Pending',
        TotalAmt: 400, CustomerRef: { value: CONTACT_ID_EXTRA },
      };

      const r2 = await apiPost(BASE, `/api/quickbooks/contacts/${CONTACT_ID_EXTRA}/decline-deal`, mgr.cookie, {
        estimateIds:  [EST_F3],
        sendThankYou: false,
        contactEmail: CONTACT_EMAIL,
        contactName:  CONTACT_NAME,
      });

      record('F.no-thank-you-http-ok', r2.status === 200,
        r2.status === 200 ? 'HTTP 200' : `HTTP ${r2.status}: ${js(r2.body).slice(0, 150)}`);

      const mails2 = readMailFile(mailFile);
      record('F.no-thank-you-skipped', mails2.length === 0,
        mails2.length === 0
          ? 'no email sent (correct)'
          : `unexpected mail: ${js(mails2.map(m => ({ to: m.to, subject: m.subject })))}`);

      const patchF2 = mockHs.state.patches.find(
        p => p.contactId === CONTACT_ID_EXTRA && p.properties?.hs_lead_status === 'DECLINED_DEAL'
      );
      record('F.no-thank-you-lead-status', !!patchF2,
        patchF2 ? 'lead status still DECLINED_DEAL' : 'no DECLINED_DEAL PATCH');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Probe G: Failed invoice send does not advance lead status
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n  [G] Failed invoice send does not advance lead status');
    {
      await clearQbSettings(pool);
      await clearSendLog(pool, users.manager.id);
      mockQb.state.calls.length = 0;
      mockHs.state.patches.length = 0;
      mockQb.state.sendFail = true;

      mockQb.state.estimates[EST_G] = {
        Id: EST_G, SyncToken: '1', TxnStatus: 'Pending',
        TotalAmt: 500,
        CustomerRef: { value: CONTACT_ID },
      };

      const r = await apiPost(BASE, `/api/quickbooks/contacts/${CONTACT_ID}/accept-deal`, mgr.cookie, {
        estimateId:   EST_G,
        contactEmail: CONTACT_EMAIL,
        contactName:  CONTACT_NAME,
      });

      // Invoice create fired before the send attempt
      const invCreate = mockQb.state.calls.find(
        c => c.method === 'POST' && c.path.endsWith('/invoice') && !c.body.Id && !c.body.sparse
      );
      record('G.invoice-created', !!invCreate,
        invCreate ? 'invoice create fired before send failure' : 'no invoice create POST');

      // Response is an error (not 200)
      record('G.http-error', r.status >= 500,
        r.status >= 500 ? `HTTP ${r.status} (send failed)` : `unexpected HTTP ${r.status}: ${js(r.body).slice(0, 150)}`);

      // No HubSpot PATCH fired at all — status stays OPEN_DEAL
      const noPatch = mockHs.state.patches.length === 0;
      record('G.no-lead-status-advance', noPatch,
        noPatch
          ? 'no HubSpot PATCH fired — status stays OPEN_DEAL (correct)'
          : `unexpected PATCH(es) fired: ${js(mockHs.state.patches).slice(0, 200)}`);

      // steps.invoiceSent = false in response
      const stepsInvSentFalse = r.body?.steps?.invoiceSent === false;
      record('G.steps-invoice-sent-false', stepsInvSentFalse,
        stepsInvSentFalse ? 'steps.invoiceSent=false' : `steps: ${js(r.body?.steps)}`);

      mockQb.state.sendFail = false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Probe H: Amendments path — data-load is non-mutating, status stays OPEN_DEAL
    //
    // When a user opens the OpenDealActionModal and picks "Make amendments" they
    // only trigger the data-load endpoint (POST /api/card-actions/open-deal).
    // That call must never patch the HubSpot lead status.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n  [H] Amendments path: data-load is non-mutating');
    {
      mockHs.state.patches.length = 0;

      // Pre-populate the mock QB side so the QB estimate query inside the
      // open-deal handler returns gracefully (no error path that might mutate).
      // The handler queries QB via fetchFromQuickBooks('/query', ...) which
      // hits QB_API_BASE_OVERRIDE.  Our mock returns 404 for unknown paths,
      // so we only need to handle the /query route.
      // The open-deal handler already catches QB errors gracefully, so even
      // a 404 on the QB side is fine — the handler sets qbConnected=false.

      const r = await apiPost(BASE, '/api/card-actions/open-deal', mgr.cookie, {
        contactId: CONTACT_ID,
      });

      // H.1: Endpoint responded (not a fatal server error)
      record('H.data-load-ok', r.status === 200,
        r.status === 200
          ? `HTTP 200; qbConnected=${r.body?.qbConnected} depositPercent=${r.body?.depositPercent}`
          : `HTTP ${r.status}: ${js(r.body).slice(0, 150)}`);

      // H.2: No HubSpot PATCH fired — amendments never changes the lead status
      const noPatchH = mockHs.state.patches.length === 0;
      record('H.no-status-mutation', noPatchH,
        noPatchH
          ? 'no HubSpot PATCH fired — lead status stays OPEN_DEAL (correct)'
          : `unexpected PATCH(es): ${js(mockHs.state.patches).slice(0, 200)}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Probe I: Idempotency guard — second call returns existing invoice, no dup
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n  [I] Idempotency: second accept-deal call for same estimate');
    {
      await clearQbSettings(pool); // defaults (10%)
      await clearSendLog(pool, users.manager.id);
      mockQb.state.calls.length = 0;
      mockHs.state.patches.length = 0;
      if (fs.existsSync(mailFile)) fs.unlinkSync(mailFile);

      mockQb.state.estimates[EST_I] = {
        Id: EST_I, SyncToken: '1', TxnStatus: 'Pending',
        TotalAmt: 1000,
        CustomerRef: { value: CONTACT_ID },
      };

      // I.1: First call — should succeed and create an invoice
      const r1 = await apiPost(BASE, `/api/quickbooks/contacts/${CONTACT_ID}/accept-deal`, mgr.cookie, {
        estimateId:   EST_I,
        contactEmail: CONTACT_EMAIL,
        contactName:  CONTACT_NAME,
      });

      record('I.first-call-ok', r1.status === 200 && r1.body?.ok === true,
        r1.status === 200 && r1.body?.ok === true
          ? `HTTP 200 ok=true invoiceId=${r1.body?.invoiceId}`
          : `HTTP ${r1.status}: ${js(r1.body).slice(0, 150)}`);

      const firstInvoiceId = r1.body?.invoiceId;
      const firstInvCreateCount = mockQb.state.calls.filter(
        c => c.method === 'POST' && c.path.endsWith('/invoice') && !c.body.Id && !c.body.sparse
      ).length;
      record('I.first-call-invoice-created', firstInvCreateCount === 1,
        firstInvCreateCount === 1
          ? `exactly 1 invoice create call (invoiceId=${firstInvoiceId})`
          : `expected 1 invoice create, got ${firstInvCreateCount}`);

      // I.2: Second call with same estimateId — must NOT create a second invoice.
      //      The route skips invoice create but still completes remaining steps
      //      (QB send, app email, HubSpot status) to handle partial-failure retries.
      await clearSendLog(pool, users.manager.id); // clear send limit from first call
      mockQb.state.calls.length = 0;
      mockHs.state.patches.length = 0;
      if (fs.existsSync(mailFile)) fs.unlinkSync(mailFile);

      const r2 = await apiPost(BASE, `/api/quickbooks/contacts/${CONTACT_ID}/accept-deal`, mgr.cookie, {
        estimateId:   EST_I,
        contactEmail: CONTACT_EMAIL,
        contactName:  CONTACT_NAME,
      });

      record('I.second-call-ok', r2.status === 200 && r2.body?.ok === true,
        r2.status === 200 && r2.body?.ok === true
          ? `HTTP 200 ok=true (idempotent=${r2.body?.idempotent})`
          : `HTTP ${r2.status}: ${js(r2.body).slice(0, 150)}`);

      record('I.second-call-idempotent-flag', r2.body?.idempotent === true,
        r2.body?.idempotent === true
          ? 'idempotent=true returned'
          : `idempotent flag missing or false: ${js(r2.body).slice(0, 150)}`);

      record('I.second-call-same-invoice-id', r2.body?.invoiceId === firstInvoiceId,
        r2.body?.invoiceId === firstInvoiceId
          ? `same invoiceId=${firstInvoiceId} returned on retry`
          : `invoiceId mismatch: first=${firstInvoiceId} second=${r2.body?.invoiceId}`);

      // No new invoice create call (the guard skips QB invoice POST on retry)
      const secondInvCreateCount = mockQb.state.calls.filter(
        c => c.method === 'POST' && c.path.endsWith('/invoice') && !c.body.Id && !c.body.sparse
      ).length;
      record('I.no-duplicate-invoice-created', secondInvCreateCount === 0,
        secondInvCreateCount === 0
          ? 'no invoice create call on retry (correct)'
          : `${secondInvCreateCount} unexpected invoice create call(s) on retry`);

      // The first call completed fully (invoice created + sent), so the
      // sequential retry must see sent_at IS NOT NULL and return sendSkipped=true.
      record('I.second-call-send-skipped',
        r2.body?.sendSkipped === true,
        r2.body?.sendSkipped === true
          ? 'sendSkipped=true returned on sequential retry after completed send'
          : `sendSkipped flag missing or false on sequential retry: ${js(r2.body).slice(0, 150)}`);

      // No new QB invoice send call should have been issued on the retry.
      const secondSendCount = mockQb.state.calls.filter(
        c => c.method === 'POST' && /\/invoice\/[^/]+\/send$/.test(c.path)
      ).length;
      record('I.no-duplicate-send', secondSendCount === 0,
        secondSendCount === 0
          ? 'no QB invoice send call on sequential retry (correct)'
          : `${secondSendCount} unexpected QB send call(s) on sequential retry`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Probe J: Concurrent idempotency — two simultaneous calls produce one invoice
    //
    // Fires two accept-deal requests for the same estimate at the same time
    // (using Promise.all) to exercise the advisory lock serialization path.
    // Exactly one QB invoice POST should be observed; both responses must
    // succeed (200) and return the same invoiceId.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n  [J] Concurrent idempotency: two simultaneous accept-deal calls');
    {
      await clearQbSettings(pool);
      await clearSendLog(pool, users.manager.id);
      await clearSendLog(pool, users.admin.id);
      mockQb.state.calls.length = 0;
      mockHs.state.patches.length = 0;
      if (fs.existsSync(mailFile)) fs.unlinkSync(mailFile);

      mockQb.state.estimates[EST_J] = {
        Id: EST_J, SyncToken: '1', TxnStatus: 'Pending',
        TotalAmt: 2000,
        CustomerRef: { value: CONTACT_ID },
      };

      // Fire two requests simultaneously.  Both users (manager + admin) are
      // managers-or-admins, so both are authorised to call accept-deal.
      // The advisory lock in the server ensures only one invoice is created
      // in QuickBooks even though both requests race past their SELECT check.
      const [r1, r2] = await Promise.all([
        apiPost(BASE, `/api/quickbooks/contacts/${CONTACT_ID}/accept-deal`, mgr.cookie, {
          estimateId:   EST_J,
          contactEmail: CONTACT_EMAIL,
          contactName:  CONTACT_NAME,
        }),
        apiPost(BASE, `/api/quickbooks/contacts/${CONTACT_ID}/accept-deal`, admin.cookie, {
          estimateId:   EST_J,
          contactEmail: CONTACT_EMAIL,
          contactName:  CONTACT_NAME,
        }),
      ]);

      // Both requests must succeed (200).
      record('J.both-requests-ok',
        r1.status === 200 && r1.body?.ok === true && r2.status === 200 && r2.body?.ok === true,
        r1.status === 200 && r1.body?.ok === true && r2.status === 200 && r2.body?.ok === true
          ? `both HTTP 200 ok=true (r1.invoiceId=${r1.body?.invoiceId} r2.invoiceId=${r2.body?.invoiceId})`
          : `r1: HTTP ${r1.status} ${js(r1.body).slice(0, 100)} | r2: HTTP ${r2.status} ${js(r2.body).slice(0, 100)}`);

      // Exactly one QB invoice create POST must have been issued.
      const concurrentInvCreates = mockQb.state.calls.filter(
        c => c.method === 'POST' && c.path.endsWith('/invoice') && !c.body.Id && !c.body.sparse
      ).length;
      record('J.exactly-one-invoice-created', concurrentInvCreates === 1,
        concurrentInvCreates === 1
          ? 'exactly 1 QB invoice create call — advisory lock prevented duplicate'
          : `expected 1 invoice create, got ${concurrentInvCreates} — duplicate invoice would have been created`);

      // Both responses must reference the same invoiceId.
      record('J.same-invoice-id-returned',
        r1.body?.invoiceId != null && r1.body?.invoiceId === r2.body?.invoiceId,
        r1.body?.invoiceId != null && r1.body?.invoiceId === r2.body?.invoiceId
          ? `same invoiceId=${r1.body?.invoiceId} returned to both callers`
          : `mismatched invoiceIds: r1=${r1.body?.invoiceId} r2=${r2.body?.invoiceId}`);

      // Exactly one row in the idempotency table for this estimate.
      const { rows: idemRows } = await pool.query(
        'SELECT COUNT(*) AS cnt FROM open_deal_invoices WHERE estimate_id = $1',
        [EST_J]
      );
      const idemCount = Number(idemRows[0]?.cnt ?? 0);
      record('J.one-idempotency-row', idemCount === 1,
        idemCount === 1
          ? 'exactly 1 row in open_deal_invoices for this estimate'
          : `expected 1 row, found ${idemCount}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Probe K: Concurrent-retry send guard
    //
    // Two users retry accept-deal simultaneously for an estimate whose invoice
    // was already created (pre-seeded open_deal_invoices row with sent_at=NULL).
    // Both callers skip the invoice-create advisory lock and race straight to
    // the send-claim UPDATE.  Exactly one QB send call should be observed.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n  [K] Concurrent-retry send guard: two retries produce exactly one QB send');
    {
      await clearQbSettings(pool);
      await clearSendLog(pool, users.manager.id);
      await clearSendLog(pool, users.admin.id);
      mockQb.state.calls.length = 0;
      mockHs.state.patches.length = 0;
      if (fs.existsSync(mailFile)) fs.unlinkSync(mailFile);

      // Seed the estimate in mock QB (route step 1 fetches it before the lock).
      mockQb.state.estimates[EST_K] = {
        Id: EST_K, SyncToken: '1', TxnStatus: 'Pending',
        TotalAmt: 1500,
        CustomerRef: { value: CONTACT_ID },
      };

      // Seed the invoice in mock QB so the QB send call can succeed.
      mockQb.state.invoices[INV_K] = {
        Id: INV_K, DocNumber: `INVDOC${INV_K}`, SyncToken: '0', TotalAmt: 150,
      };

      // Pre-seed open_deal_invoices with sent_at=NULL to simulate a prior run
      // that created the invoice but did not reach the send step.
      await pool.query(
        `INSERT INTO open_deal_invoices (estimate_id, contact_id, invoice_id, invoice_doc_num, sent_at)
         VALUES ($1, $2, $3, $4, NULL)
         ON CONFLICT (estimate_id) DO UPDATE SET sent_at = NULL`,
        [EST_K, CONTACT_ID, INV_K, `INVDOC${INV_K}`]
      );

      // Fire two requests simultaneously from two different users so the
      // per-user rate-limit cannot suppress the second send by itself.
      const [r1, r2] = await Promise.all([
        apiPost(BASE, `/api/quickbooks/contacts/${CONTACT_ID}/accept-deal`, mgr.cookie, {
          estimateId:   EST_K,
          contactEmail: CONTACT_EMAIL,
          contactName:  CONTACT_NAME,
        }),
        apiPost(BASE, `/api/quickbooks/contacts/${CONTACT_ID}/accept-deal`, admin.cookie, {
          estimateId:   EST_K,
          contactEmail: CONTACT_EMAIL,
          contactName:  CONTACT_NAME,
        }),
      ]);

      // Both requests must succeed (200).
      record('K.both-requests-ok',
        r1.status === 200 && r1.body?.ok === true && r2.status === 200 && r2.body?.ok === true,
        r1.status === 200 && r1.body?.ok === true && r2.status === 200 && r2.body?.ok === true
          ? `both HTTP 200 ok=true (r1.invoiceId=${r1.body?.invoiceId} r2.invoiceId=${r2.body?.invoiceId})`
          : `r1: HTTP ${r1.status} ${js(r1.body).slice(0, 100)} | r2: HTTP ${r2.status} ${js(r2.body).slice(0, 100)}`);

      // Exactly one QB invoice send POST must have been issued.
      const sendCalls = mockQb.state.calls.filter(
        c => c.method === 'POST' && /\/invoice\/[^/]+\/send$/.test(c.path)
      ).length;
      record('K.exactly-one-send', sendCalls === 1,
        sendCalls === 1
          ? 'exactly 1 QB invoice send call — concurrent-retry guard prevented duplicate send'
          : `expected 1 send, got ${sendCalls} — duplicate send would have been fired`);

      // Both responses must reference the same invoiceId.
      record('K.same-invoice-id-returned',
        r1.body?.invoiceId != null && r1.body?.invoiceId === r2.body?.invoiceId,
        r1.body?.invoiceId != null && r1.body?.invoiceId === r2.body?.invoiceId
          ? `same invoiceId=${r1.body?.invoiceId} returned to both callers`
          : `mismatched invoiceIds: r1=${r1.body?.invoiceId} r2=${r2.body?.invoiceId}`);

      // sent_at must be populated in the DB after the race.
      const { rows: sentRows } = await pool.query(
        'SELECT sent_at FROM open_deal_invoices WHERE estimate_id = $1',
        [EST_K]
      );
      const sentAt = sentRows[0]?.sent_at;
      record('K.sent-at-populated', sentAt != null,
        sentAt != null
          ? `sent_at=${sentAt} — row marked sent in DB`
          : 'sent_at is still NULL — send-claim did not persist');

      // The losing caller (the one that found sent_at already set) must have
      // sendSkipped=true in its response; the winner must not.
      const skipped = [r1, r2].filter(r => r.body?.sendSkipped === true).length;
      const notSkipped = [r1, r2].filter(r => r.body?.sendSkipped !== true).length;
      record('K.loser-has-send-skipped-flag',
        skipped === 1 && notSkipped === 1,
        skipped === 1 && notSkipped === 1
          ? `exactly 1 response has sendSkipped=true (loser correctly flagged)`
          : `expected 1 skipped + 1 not-skipped, got ${skipped} skipped — r1.sendSkipped=${r1.body?.sendSkipped} r2.sendSkipped=${r2.body?.sendSkipped}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Probe L: Concurrent-decline guard
    //
    // Two users fire decline-deal simultaneously for the same contact with
    // sendThankYou=true.  The advisory lock + declined_at guard in the server
    // must ensure exactly one thank-you email is sent even when both requests
    // race past the initial declined_at IS NULL check.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n  [L] Concurrent-decline guard: two simultaneous declines produce exactly one thank-you email');
    {
      await clearQbSettings(pool);
      await clearOpenDealDeclines(pool);
      mockQb.state.calls.length = 0;
      mockHs.state.patches.length = 0;
      if (fs.existsSync(mailFile)) fs.unlinkSync(mailFile);

      mockQb.state.estimates[EST_L] = {
        Id: EST_L, SyncToken: '1', TxnStatus: 'Pending',
        TotalAmt: 750, CustomerRef: { value: CONTACT_ID_L },
      };

      // Fire two simultaneous decline requests from two different users.
      const [r1, r2] = await Promise.all([
        apiPost(BASE, `/api/quickbooks/contacts/${CONTACT_ID_L}/decline-deal`, mgr.cookie, {
          estimateIds:  [EST_L],
          sendThankYou: true,
          contactEmail: CONTACT_EMAIL,
          contactName:  CONTACT_NAME,
        }),
        apiPost(BASE, `/api/quickbooks/contacts/${CONTACT_ID_L}/decline-deal`, admin.cookie, {
          estimateIds:  [EST_L],
          sendThankYou: true,
          contactEmail: CONTACT_EMAIL,
          contactName:  CONTACT_NAME,
        }),
      ]);

      // Both requests must succeed (200).
      record('L.both-requests-ok',
        r1.status === 200 && r1.body?.ok === true && r2.status === 200 && r2.body?.ok === true,
        r1.status === 200 && r1.body?.ok === true && r2.status === 200 && r2.body?.ok === true
          ? `both HTTP 200 ok=true`
          : `r1: HTTP ${r1.status} ${js(r1.body).slice(0, 100)} | r2: HTTP ${r2.status} ${js(r2.body).slice(0, 100)}`);

      // Exactly one thank-you email must have been sent.
      const lMails = readMailFile(mailFile);
      const thankMails = lMails.filter(m =>
        String(m.subject || '').toLowerCase().includes('thank')
        || String(m.subject || '').toLowerCase().includes('declin')
      );
      record('L.exactly-one-email',
        thankMails.length === 1,
        thankMails.length === 1
          ? `exactly 1 thank-you email — advisory lock prevented duplicate send`
          : `expected 1 thank-you email, got ${thankMails.length} — ${js(lMails.map(m => ({ to: m.to, subject: m.subject }))).slice(0, 200)}`);

      // Both responses must have steps.thankYouSent = true.
      record('L.both-steps-thank-you-sent',
        r1.body?.steps?.thankYouSent === true && r2.body?.steps?.thankYouSent === true,
        r1.body?.steps?.thankYouSent === true && r2.body?.steps?.thankYouSent === true
          ? 'both responses report thankYouSent=true'
          : `r1.steps=${js(r1.body?.steps)} r2.steps=${js(r2.body?.steps)}`);

      // The waiter (whichever request found declined_at already set) must have
      // emailAlreadySent=true; the winner must not have it.
      const alreadySentCount = [r1, r2].filter(r => r.body?.emailAlreadySent === true).length;
      record('L.waiter-has-email-already-sent-flag',
        alreadySentCount === 1,
        alreadySentCount === 1
          ? 'exactly 1 response has emailAlreadySent=true (waiter correctly flagged)'
          : `expected 1 waiter flag, got ${alreadySentCount} — r1.emailAlreadySent=${r1.body?.emailAlreadySent} r2.emailAlreadySent=${r2.body?.emailAlreadySent}`);

      // declined_at must be set in the DB for this contact.
      const { rows: declineRows } = await pool.query(
        'SELECT declined_at FROM open_deal_declines WHERE contact_id = $1',
        [CONTACT_ID_L]
      );
      const declinedAt = declineRows[0]?.declined_at;
      record('L.declined-at-populated', declinedAt != null,
        declinedAt != null
          ? `declined_at=${declinedAt} — row recorded in open_deal_declines`
          : 'declined_at is NULL — guard state not persisted');
    }

    exitCode = findings.every(f => f.ok) ? 0 : 1;
  } catch (e) {
    console.error('  fatal:', e.stack || e.message);
    record('harness', false, `fatal: ${e.message}`);
    exitCode = 1;
  } finally {
    stop();
    try { await cleanupTestData(pool); } catch {}
    try { mockQb.server.close(); } catch {}
    try { mockHs.server.close(); } catch {}
    try { if (fs.existsSync(mailFile)) fs.unlinkSync(mailFile); } catch {}
    await pool.end().catch(() => {});

    const pass = findings.filter(f => f.ok).length;
    const fail = findings.filter(f => !f.ok).length;
    console.log(`\n  Results: ${pass} passed, ${fail} failed`);

    const lines = [
      '# open-deal integration test results',
      '',
      `Run: ${new Date().toISOString()}`,
      `Result: ${findings.every(f => f.ok) ? 'PASS' : 'FAIL'} (${pass}/${findings.length})`,
      '',
      '| ID | Result | Detail |',
      '|----|--------|--------|',
      ...findings.map(f =>
        `| ${f.id} | ${f.ok ? 'PASS' : 'FAIL'} | ${String(f.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`
      ),
      '',
      '## PROBE_LABELS',
      '',
      ...PROBE_LABELS.map(l => `- ${l}`),
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
