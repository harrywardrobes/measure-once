'use strict';
// Baseline migration: customer-info submission schema.
// DDL copied verbatim from customer-info.js ensureCustomerInfoSubmissionsTable()
// and ensureResendLogTable(). The one-time duplicate-link dedup is inlined here
// (idempotent). The recurring 48h resend-log cleanup remains a boot data op.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS customer_info_submissions (
      id               SERIAL PRIMARY KEY,
      contact_id       TEXT NOT NULL,
      contact_name     TEXT,
      contact_email    TEXT,
      token_hash       TEXT NOT NULL UNIQUE,
      expires_at       TIMESTAMPTZ NOT NULL,
      submitted_at     TIMESTAMPTZ,
      masked_email     TEXT,
      masked_phone     TEXT,
      corrected_email  TEXT,
      corrected_mobile TEXT,
      address_line1    TEXT,
      city             TEXT,
      postcode         TEXT,
      room_count       TEXT,
      room_notes       TEXT,
      photo_keys       JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS cis_contact_id_idx ON customer_info_submissions (contact_id);
    CREATE INDEX IF NOT EXISTS cis_token_hash_idx ON customer_info_submissions (token_hash);
    ALTER TABLE customer_info_submissions
      ADD COLUMN IF NOT EXISTS email_skipped_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE customer_info_submissions
      ADD COLUMN IF NOT EXISTS form_link TEXT;
  `);

  // One-time dedup: expire all but the newest active pending row per contact.
  pgm.sql(`
    UPDATE customer_info_submissions
    SET expires_at = NOW()
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY contact_id
                 ORDER BY created_at DESC
               ) AS rn
        FROM customer_info_submissions
        WHERE expires_at > NOW()
          AND submitted_at IS NULL
      ) ranked
      WHERE rn > 1
    );
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS customer_info_resend_log (
      id           SERIAL PRIMARY KEY,
      token_hash   TEXT NOT NULL,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS cirl_token_hash_idx ON customer_info_resend_log (token_hash);
    CREATE INDEX IF NOT EXISTS cirl_requested_at_idx ON customer_info_resend_log (requested_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS customer_info_resend_log;
    DROP TABLE IF EXISTS customer_info_submissions;
  `);
};
