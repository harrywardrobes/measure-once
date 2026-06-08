'use strict';
// Index migration (Offline Phase 0).
// Adds lookup indexes that support offline-sync queries: by customer/visit id
// and by updated_at change marker on the sync tables. All IF NOT EXISTS so they
// are safe on existing databases that may already have some of them.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS visits_customer_id_idx ON visits (customer_id);
    CREATE INDEX IF NOT EXISTS visits_updated_at_idx ON visits (updated_at);
    CREATE INDEX IF NOT EXISTS design_visits_updated_at_idx ON design_visits (updated_at);
    CREATE INDEX IF NOT EXISTS design_visit_rooms_updated_at_idx ON design_visit_rooms (updated_at);
    CREATE INDEX IF NOT EXISTS customer_info_submissions_updated_at_idx ON customer_info_submissions (updated_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS visits_customer_id_idx;
    DROP INDEX IF EXISTS visits_updated_at_idx;
    DROP INDEX IF EXISTS design_visits_updated_at_idx;
    DROP INDEX IF EXISTS design_visit_rooms_updated_at_idx;
    DROP INDEX IF EXISTS customer_info_submissions_updated_at_idx;
  `);
};
