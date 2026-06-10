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
