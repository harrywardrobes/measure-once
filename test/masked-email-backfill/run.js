'use strict';

const PROBE_LABELS = [
  '(A) masked_email IS NULL → updated to new format',
  '(B) old-format masked_email → updated to new format',
  '(C) already-correct masked_email → unchanged',
  '(D) submitted row → not touched by backfill',
];

// test/masked-email-backfill/run.js
//
// Integration test for the backfillMaskedEmails() function in customer-info.js.
//
// Seeds customer_info_submissions rows with three scenarios and asserts the
// backfill produces the correct outcome for each:
//
//   (A) masked_email IS NULL     → updated to new format  e.g. har***son@g**.com
//   (B) old-format masked_email  → updated to new format
//       (old format: local is first-char-only, domain is @***.<tld>
//        e.g. "h***@***.com" — three literal asterisks before the dot)
//   (C) already-correct masked_email → unchanged (not touched by backfill)
//
// The test does NOT boot an Express server — it calls backfillMaskedEmails()
// directly after pointing DATABASE_URL at the isolated test database.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> npm run test:masked-email-backfill
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:masked-email-backfill

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

require('dotenv').config();

const REPORT_PATH = path.join(
  __dirname, '..', '..', 'test-results', 'masked-email-backfill.md'
);
const findings = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} — ${detail}`);
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function waitForTable(pool, tableName, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1`,
      [tableName]
    );
    if (r.rowCount) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Table ${tableName} did not appear within ${timeoutMs}ms`);
}

async function insertRow(pool, opts) {
  const tokenHash = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  await pool.query(
    `INSERT INTO customer_info_submissions
       (contact_id, contact_email, token_hash, expires_at, masked_email,
        submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      opts.contactId,
      opts.contactEmail,
      tokenHash,
      expiresAt,
      opts.maskedEmail ?? null,
      opts.submitted ? new Date().toISOString() : null,
    ]
  );
  return tokenHash;
}

async function getMaskedEmail(pool, tokenHash) {
  const r = await pool.query(
    `SELECT masked_email FROM customer_info_submissions WHERE token_hash = $1`,
    [tokenHash]
  );
  return r.rows[0]?.masked_email ?? null;
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
      + '    Set DATABASE_URL_TEST=<disposable> or PRIVTEST_ALLOW_SHARED_DB=1.\n'
    );
    process.exit(2);
  }

  // Point customer-info.js pool at the test DB before requiring the module.
  process.env.DATABASE_URL = connStr;

  const { backfillMaskedEmails } = require('../../customer-info');
  const { runMigrations } = require('../../db-migrate');

  const runId     = Math.random().toString(36).slice(2, 8);
  const contactId = `privtest-backfill-${runId}`;

  console.log(`\n  masked-email-backfill  run=${runId}`);
  console.log(
    `  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`
  );

  const pool = new Pool({ connectionString: connStr });

  let exitCode = 1;
  try {
    await runMigrations();
    await waitForTable(pool, 'customer_info_submissions');
    await cleanup(pool, contactId);

    // ── Seed rows ─────────────────────────────────────────────────────────────

    // Row A: NULL masked_email → should be filled in
    const hashA = await insertRow(pool, {
      contactId,
      contactEmail: 'harrison@gmail.com',
      maskedEmail:  null,
    });

    // Row B: old-format masked_email ("h***@***.com") → should be updated.
    // Old format used @***.<tld> (three literal asterisks) with only the first
    // local char shown.  The regex in backfillMaskedEmails is: masked_email ~ '@\*{3}\.'
    const hashB = await insertRow(pool, {
      contactId,
      contactEmail: 'harrison@gmail.com',
      maskedEmail:  'h***@***.com',
    });

    // Row C: already-correct format ("har***son@g**.com") → must be unchanged.
    // Its domain starts with a real char (g**) so it does NOT match @\*{3}\.
    const correctMasked = 'har***son@g**.com';
    const hashC = await insertRow(pool, {
      contactId,
      contactEmail: 'harrison@gmail.com',
      maskedEmail:  correctMasked,
    });

    // Row D: submitted row (submitted_at IS NOT NULL) → must be ignored even
    // if masked_email is NULL, because the WHERE clause requires submitted_at IS NULL.
    const hashD = await insertRow(pool, {
      contactId,
      contactEmail: 'harrison@gmail.com',
      maskedEmail:  null,
      submitted:    true,
    });

    console.log('\n  Seeded 4 rows.  Running backfillMaskedEmails()…');

    // ── Run the backfill ──────────────────────────────────────────────────────
    await backfillMaskedEmails();

    // ── Assert outcomes ───────────────────────────────────────────────────────

    const afterA = await getMaskedEmail(pool, hashA);
    const afterB = await getMaskedEmail(pool, hashB);
    const afterC = await getMaskedEmail(pool, hashC);
    const afterD = await getMaskedEmail(pool, hashD);

    // maskEmail('harrison@gmail.com'):
    //   local 'harrison' (len 8 > 6) → 'har' + '***' + 'son' = 'har***son'
    //   domain 'gmail.com' → 'g' + '**.' + 'com'               = 'g**.com'
    //   result → 'har***son@g**.com'
    const EXPECTED_MASKED = 'har***son@g**.com';

    // Probe A: NULL row filled in with exact new format
    record('A.exact', afterA === EXPECTED_MASKED,
      `expected "${EXPECTED_MASKED}" got "${afterA}"`);
    record('A.not-old-format', typeof afterA === 'string' && !afterA.includes('@***.'),
      `"${afterA}" no longer uses old @***. pattern`);

    // Probe B: old-format row rewritten to exact new format
    record('B.exact', afterB === EXPECTED_MASKED,
      `expected "${EXPECTED_MASKED}" got "${afterB}"`);
    record('B.not-old-format', typeof afterB === 'string' && !afterB.includes('@***.'),
      `"${afterB}" no longer uses old @***. pattern`);

    // Probe C: already-correct row is unchanged
    record('C.unchanged', afterC === correctMasked,
      `already-correct row: expected "${correctMasked}" got "${afterC}"`);

    // Probe D: submitted row is not touched (masked_email stays NULL)
    record('D.submitted-untouched', afterD === null,
      `submitted row masked_email: "${afterD}" (expected null — must not be backfilled)`);

    exitCode = findings.every(f => f.ok) ? 0 : 1;
  } catch (e) {
    console.error('  fatal:', e.stack || e.message);
    record('harness', false, `fatal: ${e.message}`);
    exitCode = 1;
  } finally {
    try { await cleanup(pool, contactId); } catch {}
    await pool.end().catch(() => {});

    const allOk = findings.every(f => f.ok);
    const lines = [
      '# masked-email-backfill findings',
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
