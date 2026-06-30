'use strict';
// Adds staff-upload provenance to customer_info_submissions so team members can
// upload photos directly to a contact, folded into the same photo set that the
// customer token-link flow populates (and surfaced by the existing
// CustomerInfoSubmissionsRail via GET /api/customer-info/by-contact/:contactId).
//
//   source       — 'customer' (token-link submission) | 'staff' (uploaded
//                  in-app by a team member). Existing rows default to 'customer'.
//   uploaded_by  — staff user who added a staff row (NULL for customer rows).
//
// updated_at / version / the BEFORE UPDATE trigger already exist on this table
// (see 1749200000009_sync-readiness.js), so no sync columns are added here.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE customer_info_submissions
      ADD COLUMN IF NOT EXISTS source      TEXT NOT NULL DEFAULT 'customer',
      ADD COLUMN IF NOT EXISTS uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL;

    -- Idempotent CHECK: only add the constraint once (no ADD CONSTRAINT IF NOT
    -- EXISTS in this PG version, so guard on pg_constraint).
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'cis_source_check'
      ) THEN
        ALTER TABLE customer_info_submissions
          ADD CONSTRAINT cis_source_check CHECK (source IN ('customer', 'staff'));
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS cis_contact_source_idx
      ON customer_info_submissions (contact_id, source);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS cis_contact_source_idx;
    ALTER TABLE customer_info_submissions DROP CONSTRAINT IF EXISTS cis_source_check;
    ALTER TABLE customer_info_submissions
      DROP COLUMN IF EXISTS uploaded_by,
      DROP COLUMN IF EXISTS source;
  `);
};
