'use strict';
// Adds a structured_address JSONB column to design_visits and backfills it from
// the legacy free-text `location` column (stored as a single addressLines entry
// with countryCode "GB"). The legacy `location` column is intentionally
// preserved: the API keeps it populated with a single-line formatAddress()
// rendering for read-fallback and existing list/email display.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE design_visits
      ADD COLUMN IF NOT EXISTS structured_address JSONB;
  `);

  pgm.sql(`
    UPDATE design_visits
    SET structured_address = jsonb_build_object(
      'addressLines', jsonb_build_array(TRIM(location)),
      'countryCode',  'GB'
    )
    WHERE structured_address IS NULL
      AND COALESCE(TRIM(location), '') <> '';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE design_visits
      DROP COLUMN IF EXISTS structured_address;
  `);
};
