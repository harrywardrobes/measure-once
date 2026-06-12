'use strict';

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE contact_attempt_log
      ADD COLUMN IF NOT EXISTS note TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE contact_attempt_log
      DROP COLUMN IF EXISTS note;
  `);
};
