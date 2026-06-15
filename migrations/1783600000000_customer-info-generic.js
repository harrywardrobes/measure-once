'use strict';
// Adds support for the generic (token-less) customer info form:
//   - Makes contact_id nullable (generic rows have no contact until submission)
//   - Adds is_generic BOOLEAN NOT NULL DEFAULT false
//   - Adds have_we_spoken TEXT (optional field shown only on generic form)

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE customer_info_submissions
      ALTER COLUMN contact_id DROP NOT NULL;
    ALTER TABLE customer_info_submissions
      ADD COLUMN IF NOT EXISTS is_generic BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE customer_info_submissions
      ADD COLUMN IF NOT EXISTS have_we_spoken TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE customer_info_submissions
      DROP COLUMN IF EXISTS have_we_spoken;
    ALTER TABLE customer_info_submissions
      DROP COLUMN IF EXISTS is_generic;
    ALTER TABLE customer_info_submissions
      ALTER COLUMN contact_id SET NOT NULL;
  `);
};
