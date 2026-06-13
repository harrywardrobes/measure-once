'use strict';
// test/migration-renames/run.js
//
// DB-backed integration test for the MIGRATION_RENAMES mechanism in db-migrate.js.
//
// WHY THIS TEST EXISTS
// ────────────────────
// The static check (scripts/check-migration-renames.mjs) validates that every
// MIGRATION_RENAMES entry points at a real file — but it cannot detect the
// inverse failure: a migration file renamed on disk with NO entry added to
// MIGRATION_RENAMES. That failure only surfaces at boot as a checkOrder crash.
//
// This test verifies the *detection* mechanism works end-to-end against a real
// database by simulating a pre-rename DB state and confirming that:
//
//   [P1] A fresh DB (all names match files) passes the coverage check.
//   [P2] Old names (DB rows that use pre-rename names from MIGRATION_RENAMES)
//        pass the coverage check — this confirms all existing MIGRATION_RENAMES
//        entries cover their stated old names correctly.
//   [P3] An uncovered old name (simulating a missing MIGRATION_RENAMES entry)
//        is detected and reported as a violation.
//
// with-test-db.js runs all migrations before invoking this script, so
// pgmigrations is fully populated with current names when the test starts.
//
// Usage:
//   DATABASE_URL_TEST=<isolated-db> node test/migration-renames/run.js
//   node scripts/with-test-db.js test/migration-renames/run.js   # via :ci

const path   = require('path');
const fs     = require('fs');
const { Pool } = require('pg');

require('dotenv').config();

const ROOT           = path.resolve(__dirname, '..', '..');
const DB_MIGRATE_SRC = path.join(ROOT, 'db-migrate.js');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const RESULTS_DIR    = path.join(ROOT, 'test-results');

// ── Parse MIGRATION_RENAMES from db-migrate.js ───────────────────────────

function parseMigrationRenames() {
  const src = fs.readFileSync(DB_MIGRATE_SRC, 'utf8');
  const arrayMatch = src.match(/const MIGRATION_RENAMES\s*=\s*(\[[\s\S]*?\]);/);
  if (!arrayMatch) {
    throw new Error('Could not locate MIGRATION_RENAMES in db-migrate.js — has it been renamed?');
  }
  const renames = [];
  const pairRe = /\[\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\]/g;
  for (const m of arrayMatch[1].matchAll(pairRe)) {
    renames.push([m[1], m[2]]);
  }
  return renames;
}

// ── Build file set ────────────────────────────────────────────────────────

function getMigrationFileSet() {
  return new Set(
    fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.js'))
      .map(f => path.basename(f, '.js'))
  );
}

// ── Core coverage check ───────────────────────────────────────────────────
//
// Reads pgmigrations rows from the DB and returns an array of uncovered names:
// rows whose name does not match any file in migrations/ AND is not listed as
// an oldName in MIGRATION_RENAMES.  An uncovered name means checkOrder will
// crash at boot when the DB has that row recorded.

async function findUncoveredNames(pool, renames, fileSet) {
  const { rows } = await pool.query('SELECT name FROM pgmigrations ORDER BY run_on');
  const oldNameSet = new Set(renames.map(([old]) => old));
  const uncovered  = [];
  for (const { name } of rows) {
    if (fileSet.has(name))   continue;  // matches a current file → OK
    if (oldNameSet.has(name)) continue; // covered by a MIGRATION_RENAMES entry → OK
    uncovered.push(name);
  }
  return uncovered;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const connStr = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;
  if (!connStr) {
    console.error('DATABASE_URL_TEST (or DATABASE_URL) is required.');
    process.exit(2);
  }

  const pool   = new Pool({ connectionString: connStr });
  const runId  = Math.random().toString(36).slice(2, 8);
  const startedAt = new Date().toISOString();

  const findings = []; // { id, ok, detail }

  function record(id, ok, detail = '') {
    findings.push({ id, ok, detail });
    const icon = ok ? '✓' : '✗';
    console.log(`  ${icon} [${id}] ${detail}`);
  }

  try {
    // Verify pgmigrations table exists.
    const { rows: tbl } = await pool.query(
      `SELECT to_regclass('pgmigrations'::text) AS t`,
    );
    if (!tbl[0].t) {
      console.error('pgmigrations table not found — was runMigrations() skipped?');
      process.exit(2);
    }

    const renames = parseMigrationRenames();
    const fileSet = getMigrationFileSet();

    console.log(
      `\nmigration-renames: ${renames.length} MIGRATION_RENAMES ` +
      `${renames.length === 1 ? 'entry' : 'entries'}, ` +
      `${fileSet.size} migration files\n`
    );

    // ── Probe P1: Fresh DB — all pgmigrations names match files ──────────

    const p1Uncovered = await findUncoveredNames(pool, renames, fileSet);
    if (p1Uncovered.length === 0) {
      record('P1', true, 'Fresh DB: all pgmigrations rows match files on disk (no uncovered rows)');
    } else {
      record(
        'P1', false,
        `Fresh DB has ${p1Uncovered.length} pgmigrations row(s) not matching any file ` +
        `and not covered by MIGRATION_RENAMES: ${p1Uncovered.join(', ')}`,
      );
    }

    // ── Probe P2: Simulate old-name rows (all covered by MIGRATION_RENAMES)

    // Revert each pgmigrations row from its current newName → oldName.
    // This simulates a DB that was migrated before the file was renamed.
    // All such names ARE declared in MIGRATION_RENAMES, so the coverage
    // check should still pass.

    if (renames.length > 0) {
      for (const [oldName, newName] of renames) {
        await pool.query(
          `UPDATE pgmigrations SET name = $1 WHERE name = $2`,
          [oldName, newName],
        );
      }

      const p2Uncovered = await findUncoveredNames(pool, renames, fileSet);
      if (p2Uncovered.length === 0) {
        record(
          'P2', true,
          `Simulated old-DB state (${renames.length} row(s) reverted to pre-rename names): ` +
          `all are covered by MIGRATION_RENAMES entries`,
        );
      } else {
        record(
          'P2', false,
          `Simulated old-DB state has ${p2Uncovered.length} uncovered row(s) — ` +
          `a MIGRATION_RENAMES entry may be wrong or missing: ${p2Uncovered.join(', ')}`,
        );
      }

      // Restore newNames before P3.
      for (const [oldName, newName] of renames) {
        await pool.query(
          `UPDATE pgmigrations SET name = $1 WHERE name = $2`,
          [newName, oldName],
        );
      }
    } else {
      record(
        'P2', true,
        'MIGRATION_RENAMES is empty — old-name simulation skipped (nothing to revert)',
      );
    }

    // ── Probe P3: Synthetic uncovered name → detection fires ─────────────
    //
    // Insert a synthetic pgmigrations row whose name does NOT match any file
    // and is NOT in MIGRATION_RENAMES.  The coverage check must detect it as
    // a violation — this proves the detection logic actually fires.

    const SYNTHETIC = '__test_migration_renames_uncovered_probe__';

    const { rows: maxRow } = await pool.query('SELECT MAX(run_on) AS m FROM pgmigrations');
    const syntheticRunOn   = new Date((maxRow[0].m || new Date()).getTime() + 1000);

    await pool.query(
      `INSERT INTO pgmigrations (name, run_on) VALUES ($1, $2)`,
      [SYNTHETIC, syntheticRunOn],
    );

    let p3Ok = false;
    try {
      const p3Uncovered = await findUncoveredNames(pool, renames, fileSet);
      p3Ok = p3Uncovered.includes(SYNTHETIC);
      if (p3Ok) {
        record(
          'P3', true,
          'Uncovered pgmigrations row (no matching file, not in MIGRATION_RENAMES) ' +
          'was correctly detected as a violation',
        );
      } else {
        record(
          'P3', false,
          `Synthetic uncovered row was NOT detected — ` +
          `detection logic may be broken (p3Uncovered: [${p3Uncovered.join(', ')}])`,
        );
      }
    } finally {
      await pool.query(`DELETE FROM pgmigrations WHERE name = $1`, [SYNTHETIC]);
    }

  } finally {
    await pool.end().catch(() => {});
  }

  // ── Report ────────────────────────────────────────────────────────────

  const passed = findings.filter(f => f.ok).length;
  const total  = findings.length;

  console.log(`\nmigration-renames: ${passed}/${total} probes passed\n`);

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const esc  = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = findings.map(f =>
    `| \`${esc(f.id)}\` | ${f.ok ? '✅ PASS' : '❌ FAIL'} | ${esc(f.detail)} |`
  );

  const report = [
    '# migration-renames — DB Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${startedAt}`,
    `- Command: \`npm run test:migration-renames:ci\``,
    '',
    '## Summary',
    '',
    `- Passed: ${passed} / ${total}`,
    '',
    '## Results',
    '',
    '| Probe | Status | Detail |',
    '|-------|--------|--------|',
    ...rows,
    '',
    '---',
    `_Generated by \`test/migration-renames/run.js\` at ${new Date().toISOString()}_`,
  ].join('\n');

  fs.writeFileSync(path.join(RESULTS_DIR, 'migration-renames.md'), report, 'utf8');
  console.log('  Report: test-results/migration-renames.md');

  process.exit(passed < total ? 1 : 0);
}

main().catch(err => {
  console.error('migration-renames: unexpected error:', err);
  process.exit(1);
});
