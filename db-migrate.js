'use strict';
// db-migrate.js
//
// Thin wrapper around node-pg-migrate's programmatic runner. The server calls
// runMigrations() once on boot (before auth/session setup) so the schema is
// always built and upgraded by ordered, versioned migration files in
// ./migrations rather than the scattered ensureXTable() calls of old.
//
// Migrations keep using raw SQL (pgm.sql) so the project's plain `pg` query
// style is preserved end to end.

const path = require('path');
const { runner } = require('node-pg-migrate');
const { Pool } = require('pg');
const logger = require('./logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATIONS_TABLE = 'pgmigrations';

// Renames applied to pgmigrations rows for databases that were migrated before
// the files were renamed.  Each entry maps an old recorded name to the new
// filename so node-pg-migrate doesn't try to re-apply an already-run migration.
const MIGRATION_RENAMES = [
  // 1749200000018_contact_attempt_log was split off from its duplicate-
  // timestamped sibling and given a unique timestamp (1749200000019).
  ['1749200000018_contact_attempt_log', '1749200000019_contact_attempt_log'],
  // drop-orphan-tables was bumped from 1749200000019 to 1749200000020 to make
  // room for the above renaming.
  ['1749200000019_drop-orphan-tables', '1749200000020_drop-orphan-tables'],
  // deposit-invoice-followup-seed was originally created at 1781800000000 but
  // had a timestamp collision with open-deal-idempotency. The file was renamed
  // to 1782200000000 to resolve the collision; update existing DB records to
  // match so node-pg-migrate's checkOrder passes.
  ['1781800000000_deposit-invoice-followup-seed', '1782200000000_deposit-invoice-followup-seed'],
  // The five migrations below (1781800000000_open-deal-idempotency through
  // 1782100000000_lead-status-sort-order-dedup) were inserted into the DB
  // AFTER deposit-invoice-followup-seed (which was renamed to 1782200000000).
  // node-pg-migrate's checkOrder does a positional match — DB insertion order
  // vs file-sort order — so any file with a timestamp < 1782200000000 that was
  // inserted after it will always mismatch. Renaming these to timestamps > 1782200000000
  // makes DB insertion order match file-sort order and satisfies checkOrder.
  ['1781800000000_open-deal-idempotency', '1782300000000_open-deal-idempotency'],
  ['1781900000000_open-deal-invoice-sent-at', '1782400000000_open-deal-invoice-sent-at'],
  ['1781900000000_remove-delivery-installation-handlers', '1782500000000_remove-delivery-installation-handlers'],
  ['1782000000000_open-deal-decline-guard', '1782600000000_open-deal-decline-guard'],
  ['1782100000000_lead-status-sort-order-dedup', '1782700000000_lead-status-sort-order-dedup'],
  // The two structured-address migrations were recorded under 1782800000000/
  // 1782800000001 timestamps but were renamed to 1782900000001/1782900000002
  // when they landed in the repo (to avoid colliding with existing 1782800000000
  // contact-attempt-log-note and leave room for contact-attempt-history-notes
  // at 1782900000000). Without these renames checkOrder aborts because
  // 1782900000000_contact-attempt-history-notes (not yet run) appears before
  // the already-run structured-address rows in file-sort order.
  ['1782800000000_customer-info-structured-address', '1782900000001_customer-info-structured-address'],
  ['1782800000001_design-visits-structured-address', '1782900000002_design-visits-structured-address'],
  // contact-attempt-history-notes was applied to the DB under timestamp
  // 1782900000000, then its file was bumped to 1782900000003 to sit after the
  // structured-address migrations in file-sort order.
  ['1782900000000_contact-attempt-history-notes', '1782900000003_contact-attempt-history-notes'],
];

/**
 * Update pgmigrations rows for databases that recorded migrations under their
 * old filenames before those files were renamed.  This is idempotent: it only
 * acts when the old name is present and the new name is absent.
 */
async function applyMigrationRenames(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    // If the table doesn't exist yet there is nothing to fix.
    const { rows } = await pool.query(
      `SELECT to_regclass($1::text) AS tbl`,
      [MIGRATIONS_TABLE],
    );
    if (!rows[0].tbl) return;

    for (const [oldName, newName] of MIGRATION_RENAMES) {
      await pool.query(
        `UPDATE ${MIGRATIONS_TABLE}
            SET name = $2
          WHERE name = $1
            AND NOT EXISTS (
              SELECT 1 FROM ${MIGRATIONS_TABLE} WHERE name = $2
            )`,
        [oldName, newName],
      );
    }
  } finally {
    await pool.end();
  }
}

// Known migrations for the @acpr/rate-limit-postgresql package, tracked in the
// public.migrations table (managed by postgres-migrations, NOT node-pg-migrate).
// These records must be present for the package to skip its already-applied SQL
// files on startup — without them it tries to re-run init.sql and crashes on the
// already-existing unique_session_key constraint.
//
// Hashes are SHA1(fileName + fileContent) as computed by postgres-migrations'
// files-loader.  If the package is ever upgraded these will need updating.
const RATE_LIMIT_MIGRATIONS = [
  { id: 1, name: '1-init.sql',                      hash: '208eb8a4ca26ba263dee8cf9ecaa67d62457ff66' },
  { id: 2, name: '2-add-db-functions-agg.sql',       hash: '317e301e29395196eb085666baa6460895bb735e' },
  { id: 3, name: '3-add-db-functions-ind.sql',       hash: '6ad38534d3f44e57259031b0a544051b66accab9' },
  { id: 4, name: '4-add-db-functions-sessions.sql',  hash: '020ef3175794fe0fcacc951f94f9eee1a7a269a6' },
  { id: 5, name: '5-hotfix-update-constraints.sql',  hash: '575425e72a16d6a483c08b2d45e47d1bc014bedc' },
  { id: 6, name: '6-move-session-to-db-agg.sql',     hash: 'b8b8483e1c452db0d9611520aa91b780d2519605' },
  { id: 7, name: '7-move-session-to-db-ind.sql',     hash: '2fb7791420cba1696b4d9d53f6d50a1af02af666' },
];

/**
 * Ensure the rate-limit migration records are present in the public.migrations
 * table.  If they are missing (e.g. because the table was recreated or truncated)
 * the @acpr/rate-limit-postgresql store crashes on startup with
 * "relation unique_session_key already exists".
 *
 * This is idempotent — it only inserts rows that are absent.
 */
async function ensureRateLimitMigrations(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    // Nothing to do if the migrations table doesn't exist yet.
    const { rows: tbl } = await pool.query(
      `SELECT to_regclass('public.migrations'::text) AS t`,
    );
    if (!tbl[0].t) return;

    for (const m of RATE_LIMIT_MIGRATIONS) {
      await pool.query(
        `INSERT INTO migrations (id, name, hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [m.id, m.name, m.hash],
      );
    }
  } finally {
    await pool.end();
  }
}

/**
 * Run database migrations.
 *
 * @param {object} [opts]
 * @param {string} [opts.databaseUrl] Connection string (defaults to DATABASE_URL).
 * @param {'up'|'down'} [opts.direction] Migration direction (default 'up').
 * @param {number} [opts.count] Number of migrations to run (default: all pending
 *        for 'up', one for 'down').
 * @returns {Promise<Array>} The migrations that were run.
 */
async function runMigrations(opts = {}) {
  const databaseUrl = opts.databaseUrl || process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('runMigrations: DATABASE_URL is not set');
  }
  const direction = opts.direction || 'up';
  const count = opts.count !== undefined
    ? opts.count
    : (direction === 'down' ? 1 : Infinity);

  await applyMigrationRenames(databaseUrl);
  await ensureRateLimitMigrations(databaseUrl);

  const migrations = await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction,
    count,
    migrationsTable: MIGRATIONS_TABLE,
    checkOrder: true,
    singleTransaction: true,
    log: (msg) => logger.info({ component: 'migrations' }, String(msg).trimEnd()),
  });
  return migrations;
}

module.exports = { runMigrations, MIGRATIONS_DIR, MIGRATIONS_TABLE };
