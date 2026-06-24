'use strict';
// Thin CLI wrapper around db-migrate.js so that `npm run db:migrate` goes
// through the same runMigrations() path as the server boot, picking up the
// pgmigrations rename fixup before node-pg-migrate runs.
//
// This wrapper has no NODE_ENV guards or dev-only assumptions: it runs against
// whatever DATABASE_URL is set in the environment.  That makes it safe to use as
// a pre-deploy step against a production database (e.g.
// `DATABASE_URL=<prod> npm run db:migrate`) without any code changes — an
// alternative to the RUN_MIGRATIONS_ON_BOOT boot-time flag.
//
// Usage (via npm scripts only):
//   node scripts/run-db-migrate.js [up|down] [count]

const { runMigrations } = require('../db-migrate');

const direction = process.argv[2] || 'up';
const count = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined;

runMigrations({ direction, count })
  .then((migrations) => {
    if (migrations.length === 0) {
      console.log('No migrations to run.');
    } else {
      console.log(`Ran ${migrations.length} migration(s).`);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
  });
