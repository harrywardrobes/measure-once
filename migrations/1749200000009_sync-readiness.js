'use strict';
// Sync-readiness migration (Offline Phase 0).
// Adds optimistic-concurrency metadata to the core offline-syncable record
// tables: an `updated_at` column (where missing), a monotonically increasing
// `version` column, and a shared BEFORE UPDATE trigger that stamps updated_at
// and bumps version on every row update. This gives future offline-sync logic a
// reliable change marker and conflict signal without touching business code.
//
// Target tables: visits, design_visits, design_visit_rooms,
// customer_info_submissions.

exports.shorthands = undefined;

const SYNC_TABLES = [
  'visits',
  'design_visits',
  'design_visit_rooms',
  'customer_info_submissions',
];

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION set_updated_at_and_bump_version()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at := NOW();
      NEW.version := COALESCE(OLD.version, 0) + 1;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  for (const table of SYNC_TABLES) {
    pgm.sql(`
      ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
      DROP TRIGGER IF EXISTS trg_${table}_sync_meta ON ${table};
      CREATE TRIGGER trg_${table}_sync_meta
        BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION set_updated_at_and_bump_version();
    `);
  }
};

exports.down = (pgm) => {
  for (const table of SYNC_TABLES) {
    pgm.sql(`
      DROP TRIGGER IF EXISTS trg_${table}_sync_meta ON ${table};
      ALTER TABLE ${table} DROP COLUMN IF EXISTS version;
    `);
  }
  pgm.sql(`DROP FUNCTION IF EXISTS set_updated_at_and_bump_version();`);
};
