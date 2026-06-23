'use strict';
// test/catalog-migration/run.js

const PROBE_LABELS = [
  '(TABLES) five shared catalog_* tables exist',
  '(DROPPED) three legacy design_visit_* catalogue tables removed',
  '(FK-H) design_visits.handle_id FK repointed to catalog_handles',
  '(FK-R) design_visits.furniture_range_id FK repointed to catalog_ranges',
  '(FK-D) design_visit_rooms.door_style_id FK repointed to catalog_doors',
  '(REJECT) bogus handle_id rejected by FK constraint (23503)',
  '(ACCEPT) valid catalog refs accepted by INSERT',
  '(SET-NULL) deleting a catalog_handles row nulls the referencing FK',
];


//
// Schema + FK-integrity test for the shared `catalog_*` tables introduced by
// migrations/1783100000000_catalog-tables.js (Task "Visits foundation").
//
// This is a DB-only suite — it does NOT spawn the app server. It connects to
// the isolated temp database (DATABASE_URL_TEST, provided by
// scripts/with-test-db.js after the full migration set has been applied) and
// asserts that:
//   (TABLES)   the five shared catalogue tables exist.
//   (DROPPED)  the three legacy design-visit catalogue tables are gone.
//   (FK-H)     design_visits.handle_id references catalog_handles.
//   (FK-R)     design_visits.furniture_range_id references catalog_ranges.
//   (FK-D)     design_visit_rooms.door_style_id references catalog_doors.
//   (REJECT)   inserting a design_visit with a non-existent handle_id is
//              rejected by the foreign key.
//   (ACCEPT)   inserting a design_visit with a valid handle_id / range_id and
//              a room with a valid door_style_id succeeds.
//   (SET-NULL) deleting a referenced catalog_handles row nulls the FK on the
//              referencing design_visit (ON DELETE SET NULL).
//
// Usage:
//   npm run test:catalog-migration:ci        (isolated temp DB — preferred)
//   DATABASE_URL_TEST=<disposable> npm run test:catalog-migration
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:catalog-migration

const PROBE_LABELS = [
  '(TABLES) five shared catalog_* tables exist',
  '(DROPPED) three legacy design_visit_* catalogue tables are dropped',
  '(FK-H) design_visits.handle_id FK repoints to catalog_handles',
  '(FK-R) design_visits.furniture_range_id FK repoints to catalog_ranges',
  '(FK-D) design_visit_rooms.door_style_id FK repoints to catalog_doors',
  '(REJECT) bogus handle_id is rejected by FK (23503)',
  '(ACCEPT) valid catalogue refs are accepted (visit + room insert succeeds)',
  '(SET-NULL) deleting a catalog_handles row nulls the referencing FK',
];

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

require('dotenv').config();

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'catalog-migration.md');
const RUN_PREFIX  = 'privtest-catmig';
const findings    = [];

function record(id, ok, detail) {
  findings.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

async function tableExists(pool, name) {
  const r = await pool.query(`SELECT to_regclass($1) AS reg`, [`public.${name}`]);
  return !!r.rows[0]?.reg;
}

// Returns { table, column } that `<table>.<column>` FK points at, or null.
async function fkTarget(pool, table, column) {
  const r = await pool.query(
    `SELECT ccu.table_name AS ref_table, ccu.column_name AS ref_column
       FROM information_schema.table_constraints      tc
       JOIN information_schema.key_column_usage        kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema    = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
        AND tc.table_schema    = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name      = $1
        AND kcu.column_name    = $2`,
    [table, column],
  );
  return r.rows[0] ? { table: r.rows[0].ref_table, column: r.rows[0].ref_column } : null;
}

async function cleanup(pool) {
  try { await pool.query(`DELETE FROM design_visits WHERE contact_id LIKE $1`, [`${RUN_PREFIX}%`]); } catch {}
  try { await pool.query(`DELETE FROM catalog_handles WHERE name LIKE $1`, [`${RUN_PREFIX}%`]); } catch {}
  try { await pool.query(`DELETE FROM catalog_ranges  WHERE name LIKE $1`, [`${RUN_PREFIX}%`]); } catch {}
  try { await pool.query(`DELETE FROM catalog_doors   WHERE name LIKE $1`, [`${RUN_PREFIX}%`]); } catch {}
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

  console.log(`\n  catalog-migration  (${hasTestDb ? 'isolated DATABASE_URL_TEST' : 'shared DATABASE_URL'})`);
  const pool = new Pool({ connectionString: connStr });
  let exitCode = 1;
  try {
    await cleanup(pool);

    // ── (TABLES) shared catalogue tables exist ───────────────────────────────
    for (const t of ['catalog_handles', 'catalog_doors', 'catalog_finishes', 'catalog_ranges', 'catalog_pairings']) {
      record(`TABLES.${t}`, await tableExists(pool, t), `${t} ${(await tableExists(pool, t)) ? 'exists' : 'MISSING'}`);
    }

    // ── (DROPPED) legacy DV catalogue tables removed ─────────────────────────
    for (const t of ['design_visit_handles', 'design_visit_door_styles', 'design_visit_furniture_ranges']) {
      const gone = !(await tableExists(pool, t));
      record(`DROPPED.${t}`, gone, gone ? `${t} dropped` : `${t} still present`);
    }

    // ── (FK targets) repointed to catalog_* ──────────────────────────────────
    const fkH = await fkTarget(pool, 'design_visits', 'handle_id');
    record('FK-H.handle_id', fkH?.table === 'catalog_handles',
      `design_visits.handle_id -> ${fkH ? `${fkH.table}.${fkH.column}` : 'NONE'}`);
    const fkR = await fkTarget(pool, 'design_visits', 'furniture_range_id');
    record('FK-R.furniture_range_id', fkR?.table === 'catalog_ranges',
      `design_visits.furniture_range_id -> ${fkR ? `${fkR.table}.${fkR.column}` : 'NONE'}`);
    const fkD = await fkTarget(pool, 'design_visit_rooms', 'door_style_id');
    record('FK-D.door_style_id', fkD?.table === 'catalog_doors',
      `design_visit_rooms.door_style_id -> ${fkD ? `${fkD.table}.${fkD.column}` : 'NONE'}`);

    // ── (REJECT) FK rejects a bogus handle_id ────────────────────────────────
    let rejected = false;
    try {
      await pool.query(
        `INSERT INTO design_visits (contact_id, created_by, handle_id, terms_accepted, status)
         VALUES ($1, 'privtest', 2147483000, TRUE, 'draft')`,
        [`${RUN_PREFIX}-reject`],
      );
    } catch (e) {
      rejected = e.code === '23503'; // foreign_key_violation
    }
    record('REJECT.bogus-handle_id', rejected,
      rejected ? 'non-existent handle_id rejected by FK (23503)' : 'bogus handle_id was NOT rejected');

    // ── (ACCEPT) valid catalogue refs are accepted ───────────────────────────
    const hId = (await pool.query(
      `INSERT INTO catalog_handles (name, sort_order) VALUES ($1, 0) RETURNING id`,
      [`${RUN_PREFIX} handle`],
    )).rows[0].id;
    const rId = (await pool.query(
      `INSERT INTO catalog_ranges (name, sort_order) VALUES ($1, 0) RETURNING id`,
      [`${RUN_PREFIX} range`],
    )).rows[0].id;
    const dId = (await pool.query(
      `INSERT INTO catalog_doors (name, sort_order) VALUES ($1, 0) RETURNING id`,
      [`${RUN_PREFIX} door`],
    )).rows[0].id;

    let visitId = null;
    let accepted = false;
    try {
      visitId = (await pool.query(
        `INSERT INTO design_visits (contact_id, created_by, handle_id, furniture_range_id, terms_accepted, status)
         VALUES ($1, 'privtest', $2, $3, TRUE, 'draft') RETURNING id`,
        [`${RUN_PREFIX}-accept`, hId, rId],
      )).rows[0].id;
      await pool.query(
        `INSERT INTO design_visit_rooms (design_visit_id, room_name, door_style_id, unit_count, unit_price_pence, sort_order)
         VALUES ($1, 'Kitchen', $2, 1, 0, 0)`,
        [visitId, dId],
      );
      accepted = true;
    } catch (e) {
      accepted = false;
      record('ACCEPT.error', false, `valid refs were rejected: ${e.message}`);
    }
    record('ACCEPT.valid-refs', accepted,
      accepted ? `visit ${visitId} created with valid handle/range/door refs` : 'valid refs rejected');

    // ── (SET-NULL) deleting referenced handle nulls the FK ───────────────────
    if (visitId) {
      await pool.query(`DELETE FROM catalog_handles WHERE id = $1`, [hId]);
      const after = await pool.query(`SELECT handle_id FROM design_visits WHERE id = $1`, [visitId]);
      const nulled = after.rows[0] && after.rows[0].handle_id === null;
      record('SET-NULL.handle_id', nulled,
        nulled ? 'deleting catalog_handles row nulled design_visits.handle_id' : `handle_id = ${after.rows[0]?.handle_id} (expected null)`);
    } else {
      record('SET-NULL.handle_id', false, 'no visit created — cannot test ON DELETE SET NULL');
    }

    await cleanup(pool);

    const passed = findings.filter(f => f.ok).length;
    const failed = findings.filter(f => !f.ok).length;
    exitCode = failed === 0 ? 0 : 1;

    try {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      const lines = [
        '# catalog-migration',
        '',
        `Result: **${failed === 0 ? 'PASS' : 'FAIL'}** — ${passed} passed, ${failed} failed.`,
        '',
        '| Probe | Result | Detail |',
        '| --- | --- | --- |',
        ...findings.map(f => `| ${f.id} | ${f.ok ? 'PASS' : 'FAIL'} | ${String(f.detail).replace(/\|/g, '\\|')} |`),
        '',
      ];
      fs.writeFileSync(REPORT_PATH, lines.join('\n'));
      console.log(`\n  report: ${REPORT_PATH}`);
    } catch {}

    console.log(`\n  ${failed === 0 ? '✔ PASS' : '✘ FAIL'} — ${passed} passed, ${failed} failed\n`);
  } catch (e) {
    console.error('  catalog-migration crashed:', e.message);
    exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
    process.exit(exitCode);
  }
}

main();
