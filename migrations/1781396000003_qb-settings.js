'use strict';

exports.shorthands = undefined;

// ── qb_settings table ────────────────────────────────────────────────────────
// Stores organisation-wide QuickBooks send preferences:
//   copy_me_email   — address added as CC or BCC on every QB email send
//   copy_me_mode    — 'cc' or 'bcc' (default: 'bcc')
//   deposit_percent — default deposit percentage (used by Open Deal flow)
//   payment_stages  — JSONB array of { label, percent } payment-stage rows

exports.up = pgm => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS qb_settings (
      id              SERIAL PRIMARY KEY,
      copy_me_email   TEXT        NOT NULL DEFAULT 'harry@harrywardrobes.co.uk',
      copy_me_mode    TEXT        NOT NULL DEFAULT 'bcc'
                        CHECK (copy_me_mode IN ('cc', 'bcc')),
      deposit_percent NUMERIC(5,2) NOT NULL DEFAULT 10,
      payment_stages  JSONB       NOT NULL DEFAULT '[]'::jsonb,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  pgm.sql(`
    INSERT INTO qb_settings (copy_me_email, copy_me_mode, deposit_percent, payment_stages)
    SELECT 'harry@harrywardrobes.co.uk', 'bcc', 10, '[]'::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM qb_settings)
  `);
};

exports.down = pgm => {
  pgm.sql(`DROP TABLE IF EXISTS qb_settings`);
};
