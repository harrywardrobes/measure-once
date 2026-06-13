'use strict';

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE contact_attempt_history_log
      ADD COLUMN IF NOT EXISTS notes JSONB;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE contact_attempt_history_log
      DROP COLUMN IF EXISTS notes;
  `);
};
