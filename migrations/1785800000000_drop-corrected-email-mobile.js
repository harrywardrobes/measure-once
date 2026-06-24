'use strict';
// Drops the corrected_email and corrected_mobile columns from
// customer_info_submissions. The UI no longer collects or displays these
// fields; both columns have been NULL on every row since the correction
// form was removed, so no data is lost.

exports.up = pgm => {
  pgm.sql(`
    ALTER TABLE customer_info_submissions
      DROP COLUMN IF EXISTS corrected_email,
      DROP COLUMN IF EXISTS corrected_mobile;
  `);
};

exports.down = pgm => {
  pgm.sql(`
    ALTER TABLE customer_info_submissions
      ADD COLUMN IF NOT EXISTS corrected_email  TEXT,
      ADD COLUMN IF NOT EXISTS corrected_mobile TEXT;
  `);
};
