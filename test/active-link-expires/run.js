'use strict';

const PROBE_LABELS = [
  '(A) first send — creates exactly 1 active row',
  '(B) second send — still 1 active row (stale expired)',
  '(C) stale row — original row\'s expires_at is in the past',
  '(D) row count — exactly 2 total rows for the contact',
];

// test/active-link-expires/run.js
//
// Regression guard for the "expire stale links on send" logic.
// Ensures that when POST /api/card-actions/upload-photos-and-info
// is called twice for the same contact, the older active link is expired and
// only one active link survives.
//
// Probes:
//   (A) First send   — creates exactly 1 active row for the contact
//   (B) Second send  — only 1 active row remains (expires_at > NOW(),
//                      submitted_at IS NULL)
//   (C) Stale row    — the original row's expires_at is now in the past
//   (D) Row count    — total rows for the contact is exactly 2
//
// Overrides used:
//   HUBSPOT_API_BASE_OVERRIDE      — local mock HubSpot for contact fetch
//   MAIL_TRANSPORT_FILE_OVERRIDE   — captures sendMail payloads to avoid
//                                    needing SMTP credentials
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:active-link-expires
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:active-link-expires

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const http   = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
const { pollFn } = require('../helpers/poll');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'active-link-expires.md');
const findings    = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}

// ── Mock HubSpot server ────────────────────────────────────────────────────────
function startMockHubSpot(contactId, contactProps) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url.includes(`/contacts/${contactId}`)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: contactId, properties: contactProps }));
      }
      if (req.method === 'PATCH' && req.url.includes(`/contacts/${contactId}`)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: contactId, properties: {} }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', path: req.url }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

// ── DB helpers ─────────────────────────────────────────────────────────────────
async function waitForTable(pool, tableName, timeoutMs = 15000) {
  const found = await pollFn(async () => {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1`,
      [tableName]
    );
    return r.rowCount || null;
  }, timeoutMs, 200);
  if (!found) throw new Error(`Table ${tableName} did not appear within ${timeoutMs}ms`);
}

async function cleanup(pool, contactId) {
  try {
    await pool.query(
      `DELETE FROM customer_info_submissions WHERE contact_id = $1`,
      [contactId]
    );
  } catch { /* ignore on fresh DB */ }
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
  // contactId must be all-digit (the route validates /^\d+$/)
  const contactId = String(700_000_000 + Math.floor(Math.random() * 99_999_999));

  console.log(`\n  active-link-expires  run=${runId}  contactId=${contactId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool     = new Pool({ connectionString: connStr });
  const mailFile = path.join(os.tmpdir(), `ci-mail-ale-${runId}.jsonl`);
  try { fs.unlinkSync(mailFile); } catch {}

  // Mock HubSpot — must be up before we set env vars so the port is known
  const contactProps = {
    email:       `ale-${runId}@privtest.local`,
    firstname:   'Active',
    lastname:    'LinkTest',
    phone:       '07700900000',
    mobilephone: '',
  };
  const { server: hsServer, port: hsPort } = await startMockHubSpot(contactId, contactProps);

  // Set env overrides before requiring the harness (spawnServer inherits them)
  process.env.HUBSPOT_API_BASE_OVERRIDE    = `http://127.0.0.1:${hsPort}`;
  process.env.MAIL_TRANSPORT_FILE_OVERRIDE = mailFile;

  const harness = require('../privileges/harness');
  const {
    spawnServer, waitForServer, cleanupTestData, resetRateLimitStore,
    seedUsers, login, setPool, TEST_PORT,
  } = harness;
  const BASE = `http://127.0.0.1:${TEST_PORT}`;
  setPool(pool);

  await cleanupTestData(pool);
  await resetRateLimitStore(pool);
  await cleanup(pool, contactId);

  const { child } = spawnServer({
    extraEnv: {
      HUBSPOT_API_BASE_OVERRIDE:    `http://127.0.0.1:${hsPort}`,
      MAIL_TRANSPORT_FILE_OVERRIDE: mailFile,
    },
  });

  let exitCode = 1;
  try {
    await waitForServer();
    console.log('  test server up');

    await waitForTable(pool, 'customer_info_submissions');

    // Seed a member user so we can make authenticated requests
    const users = await seedUsers(pool, runId);
    const client = await login(users.member.email, users.member.password);

    // ── Probe A: First send — creates exactly 1 active row ────────────────────
    console.log('\n  --- Probe A: first send ---');
    const resA = await client.post('/api/card-actions/upload-photos-and-info', { contactId });
    record('A.status', resA.status === 201,
      `POST (first) → status=${resA.status} (expected 201)`);

    const activeAfterFirst = parseInt(
      (await pool.query(
        `SELECT COUNT(*) AS cnt FROM customer_info_submissions
         WHERE contact_id = $1 AND expires_at > NOW() AND submitted_at IS NULL`,
        [contactId]
      )).rows[0].cnt, 10
    );
    record('A.one-active', activeAfterFirst === 1,
      `active rows after first send: ${activeAfterFirst} (expected 1)`);

    // Capture the hash of the first row so we can confirm it's stale later
    const firstRowHash = (await pool.query(
      `SELECT token_hash FROM customer_info_submissions WHERE contact_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [contactId]
    )).rows[0]?.token_hash;

    // ── Probe B: Second send — only 1 active row remains ─────────────────────
    console.log('\n  --- Probe B: second send ---');

    // Small delay so the two rows have distinct created_at timestamps
    await new Promise(r => setTimeout(r, 50));

    const resB = await client.post('/api/card-actions/upload-photos-and-info', { contactId });
    record('B.status', resB.status === 201,
      `POST (second) → status=${resB.status} (expected 201)`);

    const activeAfterSecond = parseInt(
      (await pool.query(
        `SELECT COUNT(*) AS cnt FROM customer_info_submissions
         WHERE contact_id = $1 AND expires_at > NOW() AND submitted_at IS NULL`,
        [contactId]
      )).rows[0].cnt, 10
    );
    record('B.one-active', activeAfterSecond === 1,
      `active rows after second send: ${activeAfterSecond} (expected 1)`);

    // ── Probe C: Stale row — first row's expires_at is now in the past ────────
    console.log('\n  --- Probe C: stale row ---');
    if (firstRowHash) {
      const staleRow = (await pool.query(
        `SELECT expires_at FROM customer_info_submissions WHERE token_hash = $1`,
        [firstRowHash]
      )).rows[0];
      const isStale = staleRow && new Date(staleRow.expires_at) <= new Date();
      record('C.stale', isStale,
        staleRow
          ? `first row expires_at=${staleRow.expires_at} is ${isStale ? 'in the past ✓' : 'still in the future ✗'}`
          : 'first row not found'
      );
    } else {
      record('C.stale', false, 'could not capture first row hash (Probe A may have failed)');
    }

    // ── Probe D: Total rows = 2 ───────────────────────────────────────────────
    console.log('\n  --- Probe D: total row count ---');
    const totalRows = parseInt(
      (await pool.query(
        `SELECT COUNT(*) AS cnt FROM customer_info_submissions WHERE contact_id = $1`,
        [contactId]
      )).rows[0].cnt, 10
    );
    record('D.total-rows', totalRows === 2,
      `total rows for contact: ${totalRows} (expected 2)`);

    exitCode = findings.every(f => f.ok) ? 0 : 1;
  } catch (e) {
    console.error('  fatal:', e.stack || e.message);
    record('harness', false, `fatal: ${e.message}`);
    exitCode = 1;
  } finally {
    try { await cleanup(pool, contactId); } catch {}
    try { await cleanupTestData(pool); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    try { hsServer.close(); } catch {}
    await pool.end().catch(() => {});
    try { fs.unlinkSync(mailFile); } catch {}

    const allOk = findings.every(f => f.ok);
    const lines  = [
      '# active-link-expires findings',
      '',
      `Run: ${new Date().toISOString()}`,
      `Result: ${allOk ? 'PASS' : 'FAIL'} (${findings.filter(f => f.ok).length}/${findings.length})`,
      '',
      '| ID | Result | Detail |',
      '|----|--------|--------|',
      ...findings.map(f =>
        `| ${f.id} | ${f.ok ? 'PASS' : 'FAIL'} | ${String(f.detail).replace(/\|/g, '\\|')} |`
      ),
    ];
    try {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, lines.join('\n') + '\n');
      console.log(`\n  report -> ${REPORT_PATH}`);
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
