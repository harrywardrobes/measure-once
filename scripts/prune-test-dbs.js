'use strict';
// scripts/prune-test-dbs.js
//
// Standalone script that drops any orphaned mo_testdb_* PostgreSQL databases.
// Safe to run at any time — live databases created within the TTL window are
// left untouched, only stale orphans (e.g. from a force-killed CI runner) are
// removed.
//
// Age is determined by the timestamp embedded in the database name:
//   mo_testdb_<timestamp_ms>_<hex>   — dropped when age > TTL
//   mo_testdb_<hex>  (legacy format) — always dropped (no timestamp = orphan)
//
// Usage:
//   node scripts/prune-test-dbs.js
//   TEST_DB_PRUNE_TTL_MS=3600000 node scripts/prune-test-dbs.js
//
// Required env:
//   DATABASE_URL  — connection string for the main (admin) database.

const { Client } = require('pg');

const PRUNE_TTL_MS = parseInt(process.env.TEST_DB_PRUNE_TTL_MS || '', 10) || 2 * 60 * 60 * 1000; // 2 hours

async function main() {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    console.error('[prune-test-dbs] DATABASE_URL is required');
    process.exit(1);
  }

  const client = new Client({ connectionString: baseUrl });
  await client.connect();

  let rows;
  try {
    const res = await client.query(
      `SELECT datname FROM pg_database WHERE datname LIKE 'mo_testdb_%'`
    );
    rows = res.rows;
  } catch (e) {
    console.error('[prune-test-dbs] could not query pg_database:', e.message);
    await client.end();
    process.exit(1);
  }

  if (!rows.length) {
    console.log('[prune-test-dbs] no mo_testdb_* databases found');
    await client.end();
    return;
  }

  const now = Date.now();
  let pruned = 0;
  let skipped = 0;

  for (const { datname } of rows) {
    const m = datname.match(/^mo_testdb_(\d+)_[0-9a-f]+$/);
    let isOld;
    if (m) {
      const createdAt = parseInt(m[1], 10);
      const ageMs = now - createdAt;
      isOld = ageMs > PRUNE_TTL_MS;
      if (!isOld) {
        console.log(`[prune-test-dbs] skipping ${datname} (age ${Math.round(ageMs / 1000)}s < TTL ${Math.round(PRUNE_TTL_MS / 1000)}s)`);
        skipped++;
        continue;
      }
    } else {
      isOld = true;
    }

    try {
      await client.query(`DROP DATABASE IF EXISTS "${datname}"`);
      console.log(`[prune-test-dbs] dropped: ${datname}`);
      pruned++;
    } catch (e) {
      console.warn(`[prune-test-dbs] could not drop ${datname}:`, e.message);
    }
  }

  await client.end();
  console.log(`[prune-test-dbs] done — dropped ${pruned}, skipped ${skipped}`);
}

main().catch(e => {
  console.error('[prune-test-dbs] fatal:', e.message);
  process.exit(1);
});
