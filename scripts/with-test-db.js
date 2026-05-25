'use strict';
// scripts/with-test-db.js
//
// Creates a temporary PostgreSQL database, sets DATABASE_URL_TEST to point at
// it, spawns the remaining argv as a Node.js script, then drops the temp DB
// on exit — whether the child succeeded, failed, or was interrupted.
//
// Usage:
//   node scripts/with-test-db.js test/trades/run.js [extra-args...]
//   # or via npm:
//   npm run test:trades:ci

const { spawn }  = require('child_process');
const { Client } = require('pg');
const crypto     = require('crypto');

async function main() {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    console.error('[with-test-db] DATABASE_URL is required');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('[with-test-db] Usage: node scripts/with-test-db.js <script> [args...]');
    process.exit(1);
  }

  const suffix    = crypto.randomBytes(4).toString('hex');
  const tempDbName = `mo_testdb_${suffix}`;

  // Connect to the main database to issue DDL (CREATE/DROP DATABASE).
  // PostgreSQL allows this from any connected DB as long as the role has
  // CREATEDB privilege (which Replit's managed Postgres grants by default).
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${tempDbName}"`);
  await admin.end();

  // Build the DATABASE_URL_TEST connection string for the temp DB.
  // Replace only the database-name segment of the URL so host/port/creds stay.
  const parsed   = new URL(baseUrl);
  parsed.pathname = `/${tempDbName}`;
  const testDbUrl = parsed.toString();

  console.log(`[with-test-db] created temp DB: ${tempDbName}`);

  const cleanup = async () => {
    console.log(`[with-test-db] dropping temp DB: ${tempDbName}`);
    try {
      const c = new Client({ connectionString: baseUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS "${tempDbName}"`);
      await c.end();
      console.log('[with-test-db] temp DB dropped');
    } catch (e) {
      console.error('[with-test-db] drop failed:', e.message);
    }
  };

  const child = spawn('node', args, {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL_TEST: testDbUrl },
  });

  let cleaned = false;
  const safeCleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await cleanup();
  };

  // Handle Ctrl-C / SIGTERM so the temp DB is always dropped.
  process.on('SIGINT',  () => safeCleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => safeCleanup().then(() => process.exit(143)));

  child.on('exit', async (code, signal) => {
    await safeCleanup();
    // Mirror the child's exit: use signal-based exit code if killed by signal.
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}

main().catch(e => {
  console.error('[with-test-db] fatal:', e.message);
  process.exit(1);
});
