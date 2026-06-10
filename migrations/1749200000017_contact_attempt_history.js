'use strict';

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE contact_attempt_tracking
      ADD COLUMN IF NOT EXISTS attempted_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS attempted_by   TEXT REFERENCES users(id) ON DELETE SET NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE contact_attempt_tracking
      DROP COLUMN IF EXISTS attempted_at,
      DROP COLUMN IF EXISTS attempted_by;
  `);
};
