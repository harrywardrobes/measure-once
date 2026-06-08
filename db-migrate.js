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
const logger = require('./logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATIONS_TABLE = 'pgmigrations';

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
