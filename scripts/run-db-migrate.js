'use strict';
// Thin CLI wrapper around db-migrate.js so that `npm run db:migrate` goes
// through the same runMigrations() path as the server boot, picking up the
// pgmigrations rename fixup before node-pg-migrate runs.
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
