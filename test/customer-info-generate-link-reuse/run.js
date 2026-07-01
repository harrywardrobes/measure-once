'use strict';

const PROBE_LABELS = [
  '(A) first generate-link call inserts exactly one active row',
  '(B) second call updates the row in place (resend path)',
  '(C) token rotation — second call issues a fresh raw token',
  '(D) duplicate cleanup — single call expires all but one active row',
];

// test/customer-info-generate-link-reuse/run.js
//
// Integration test verifying that the generate-link endpoint reuses the
// existing active row rather than inserting a new one.
//
// Probes:
//   (A) Fresh contact — first call inserts exactly one row.
//   (B) Resend path — second call updates the existing row: row count stays
//       at 1, the token hash changes, and expires_at is refreshed.
//   (C) Token rotation — the second call issues a fresh raw token (token2
//       returned in the JSON body differs from token1).
//   (D) Duplicate cleanup — when two or more active rows exist for the same
//       contact (data-migration / race condition), a single generate-link call
//       expires all but the first, leaving exactly one non-expired row.
//
// Override used:
//   HUBSPOT_API_BASE_OVERRIDE — local mock returning a canned contact record
//   so no real HubSpot token is needed.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:customer-info-generate-link-reuse
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:customer-info-generate-link-reuse

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
const { pollFn } = require('../helpers/poll');

require('dotenv').config();

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results',
  'customer-info-generate-link-reuse.md'
);
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

// ── Mock HubSpot server ────────────────────────────────────────────────────────

function startMockHubSpot(contactId, contactProps) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url.includes(`/crm/v3/objects/contacts/${contactId}`)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: contactId, properties: contactProps }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', path: req.url }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
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

async function activeRowCount(pool, contactId) {
  const r = await pool.query(
    `SELECT COUNT(*) AS cnt FROM customer_info_submissions
      WHERE contact_id = $1 AND expires_at > NOW() AND submitted_at IS NULL`,
    [contactId]
  );
  return parseInt(r.rows[0].cnt, 10);
}

async function getActiveRow(pool, contactId) {
  const r = await pool.query(
    `SELECT id, token_hash, expires_at FROM customer_info_submissions
      WHERE contact_id = $1 AND expires_at > NOW() AND submitted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [contactId]
  );
  return r.rows[0] || null;
}

/** Directly insert an active (non-expired, non-submitted) row. */
async function insertActiveRow(pool, contactId) {
  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await pool.query(
    `INSERT INTO customer_info_submissions
       (contact_id, contact_name, contact_email, token_hash, expires_at,
        masked_email, masked_phone)
     VALUES ($1, 'Generate Link Test', 'genlink@privtest.local', $2, $3,
             'gen***@***.local', '07***0000')`,
    [contactId, tokenHash, expiresAt.toISOString()]
  );
  return { rawToken, tokenHash };
}

async function cleanup(pool, contactId) {
  try {
    await pool.query(
      `DELETE FROM customer_info_submissions WHERE contact_id = $1`,
      [contactId]
    );
  } catch { /* ignore on fresh DB */ }
}

// ── Main ───────────────────────────────────────────────────────────────────────

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

  const runId     = Math.random().toString(36).slice(2, 8);
  // contactId must be all-digit (the route validates /^\d+$/)
  const contactId = String(700_000_000 + Math.floor(Math.random() * 99_999_999));

  console.log(`\n  customer-info generate-link row-reuse  run=${runId}  contactId=${contactId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });

  // Mock HubSpot — returns a minimal contact with email so generate-link
  // proceeds past the "no email" guard without a real HubSpot token.
  const contactProps = {
    email:       'genlink@privtest.local',
    firstname:   'GenLink',
    lastname:    'Test',
    phone:       '',
    mobilephone: '',
  };
  const { server: hsServer, port: hsPort } = await startMockHubSpot(contactId, contactProps);
  console.log(`  mock HubSpot listening on http://127.0.0.1:${hsPort}`);

  // Must be set before requiring harness so the spawned server inherits it.
  process.env.HUBSPOT_API_BASE_OVERRIDE = `http://127.0.0.1:${hsPort}`;

  const {
    spawnServer, waitForServer, seedUsers, cleanupTestData,
    resetRateLimitStore, login, setPool,
  } = require('../privileges/harness');
  setPool(pool);

  await cleanupTestData(pool);
  await resetRateLimitStore(pool);
  await cleanup(pool, contactId);

  const { child } = spawnServer({});
  let exitCode = 1;
  try {
    await waitForServer();
    console.log('  test server up');
    await waitForTable(pool, 'customer_info_submissions');

    const users  = await seedUsers(pool, runId);
    const client = await login(users.member.email, users.member.password);

    const GENERATE_URL = `/api/customer-info/by-contact/${contactId}/generate-link`;

    // ── Probe A: First call → exactly one active row created ──────────────────
    console.log('\n  --- Probe A: first call creates exactly one active row ---');
    const resA = await client.post(GENERATE_URL, {});
    record('A.status', resA.status === 201,
      `POST generate-link → status=${resA.status} (expected 201)`);

    const token1 = resA.json?.token;
    record('A.token-returned', typeof token1 === 'string' && token1.length === 64,
      `token in response: ${typeof token1 === 'string' ? token1.slice(0, 8) + '…' : 'missing'}`);

    const cntA = await activeRowCount(pool, contactId);
    record('A.row-count', cntA === 1,
      `active rows after first call: ${cntA} (expected 1)`);

    const isResendA = resA.json?.isResend;
    record('A.not-resend', isResendA === false,
      `isResend=${isResendA} (expected false for first call)`);

    // ── Probe B: Second call reuses the same row ───────────────────────────────
    console.log('\n  --- Probe B: second call reuses existing row (count stays 1) ---');
    const rowBefore = await getActiveRow(pool, contactId);

    const resB = await client.post(GENERATE_URL, {});
    record('B.status', resB.status === 201,
      `POST generate-link (2nd) → status=${resB.status} (expected 201)`);

    const token2 = resB.json?.token;
    record('B.token-returned', typeof token2 === 'string' && token2.length === 64,
      `token2 in response: ${typeof token2 === 'string' ? token2.slice(0, 8) + '…' : 'missing'}`);

    const cntB = await activeRowCount(pool, contactId);
    record('B.row-count', cntB === 1,
      `active rows after second call: ${cntB} (expected 1, not 2)`);

    const rowAfter = await getActiveRow(pool, contactId);
    const sameId = rowBefore && rowAfter && rowBefore.id === rowAfter.id;
    record('B.same-row-id', sameId,
      sameId
        ? `row id preserved: ${rowAfter.id}`
        : `row id changed from ${rowBefore?.id} to ${rowAfter?.id}`);

    const isResendB = resB.json?.isResend;
    record('B.is-resend', isResendB === true,
      `isResend=${isResendB} (expected true for second call)`);

    // ── Probe C: Token rotation — second call issues a different raw token ─────
    console.log('\n  --- Probe C: second call issues a fresh token ---');
    const tokensDiffer = typeof token1 === 'string' && typeof token2 === 'string' && token1 !== token2;
    record('C.tokens-differ', tokensDiffer,
      tokensDiffer ? 'token1 ≠ token2 (fresh token issued)' : `token1=${token1?.slice(0,8)} token2=${token2?.slice(0,8)} (tokens should differ)`);

    // Verify the new token hash is stored in the DB (old hash is gone).
    if (token2 && rowAfter) {
      const hash2 = crypto.createHash('sha256').update(token2).digest('hex');
      const tokenUpdated = rowAfter.token_hash === hash2;
      record('C.token-hash-updated', tokenUpdated,
        tokenUpdated
          ? 'DB row now carries the new token_hash'
          : `DB token_hash=${rowAfter.token_hash?.slice(0,8)} but expected hash of token2`);
    }

    // ── Probe D: Duplicate row cleanup ────────────────────────────────────────
    // Simulate the data-migration / race scenario: manually insert two extra
    // active rows so the contact has three active rows total, then call
    // generate-link and assert that only one active row survives.
    console.log('\n  --- Probe D: duplicate rows are expired by generate-link call ---');

    // First, wipe all existing rows for this contact so we start clean.
    await pool.query(
      `DELETE FROM customer_info_submissions WHERE contact_id = $1`,
      [contactId]
    );

    // Seed three active rows directly in the DB (simulating duplicates).
    await insertActiveRow(pool, contactId);
    await insertActiveRow(pool, contactId);
    await insertActiveRow(pool, contactId);

    const cntBeforeD = await activeRowCount(pool, contactId);
    record('D.precondition', cntBeforeD === 3,
      `seeded ${cntBeforeD} active rows before generate-link (expected 3)`);

    const resD = await client.post(GENERATE_URL, {});
    record('D.status', resD.status === 201,
      `POST generate-link → status=${resD.status} (expected 201)`);

    const cntAfterD = await activeRowCount(pool, contactId);
    record('D.one-active-row', cntAfterD === 1,
      `active rows after generate-link: ${cntAfterD} (expected exactly 1)`);

    // The two stale rows must now be expired (expires_at <= NOW()).
    const expiredCount = parseInt(
      (await pool.query(
        `SELECT COUNT(*) AS cnt FROM customer_info_submissions
          WHERE contact_id = $1 AND expires_at <= NOW() AND submitted_at IS NULL`,
        [contactId]
      )).rows[0].cnt, 10
    );
    record('D.stale-rows-expired', expiredCount === 2,
      `expired rows after generate-link: ${expiredCount} (expected 2)`);

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

    const allOk = findings.every(f => f.ok);
    const lines = [
      '# customer-info generate-link row-reuse findings',
      '',
      `Run: ${new Date().toISOString()}`,
      `Result: ${allOk ? 'PASS' : 'FAIL'} (${findings.filter(f => f.ok).length}/${findings.length})`,
      '',
      '| ID | Result | Detail |',
      '|----|--------|--------|',
      ...findings.map(f =>
        `| ${f.id} | ${f.ok ? 'PASS' : 'FAIL'} | ${String(f.detail).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')} |`
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
