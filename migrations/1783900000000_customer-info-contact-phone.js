'use strict';
// Adds contact_phone to customer_info_submissions for the generic flow.
// The generic submit path normalises the user-supplied phone to E.164 and
// stores it here, mirroring how corrected_mobile works for the token flow.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE customer_info_submissions
      ADD COLUMN IF NOT EXISTS contact_phone TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE customer_info_submissions
      DROP COLUMN IF EXISTS contact_phone;
  `);
};
