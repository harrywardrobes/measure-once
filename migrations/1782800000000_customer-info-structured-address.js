'use strict';
// Adds a structured_address JSONB column to customer_info_submissions and
// backfills it from the legacy address_line1 / city / postcode columns. The
// legacy columns are intentionally preserved for read-fallback on old rows.
// countryCode defaults to "GB" (the home market) for all backfilled rows.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE customer_info_submissions
      ADD COLUMN IF NOT EXISTS structured_address JSONB;
  `);

  // Backfill: build a StructuredAddress object from the legacy flat columns.
  // address_line1 becomes the single addressLines entry; empty parts are
  // dropped. Only rows that have at least one legacy address part are touched.
  pgm.sql(`
    UPDATE customer_info_submissions
    SET structured_address = jsonb_strip_nulls(jsonb_build_object(
      'addressLines',
        CASE
          WHEN COALESCE(TRIM(address_line1), '') <> ''
          THEN jsonb_build_array(TRIM(address_line1))
          ELSE '[]'::jsonb
        END,
      'locality',           NULLIF(TRIM(COALESCE(city, '')), ''),
      'administrativeArea',  NULL,
      'postalCode',         NULLIF(TRIM(COALESCE(postcode, '')), ''),
      'countryCode',        'GB'
    ))
    WHERE structured_address IS NULL
      AND (
        COALESCE(TRIM(address_line1), '') <> '' OR
        COALESCE(TRIM(city), '')          <> '' OR
        COALESCE(TRIM(postcode), '')      <> ''
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE customer_info_submissions
      DROP COLUMN IF EXISTS structured_address;
  `);
};
