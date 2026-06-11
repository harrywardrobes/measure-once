'use strict';

exports.shorthands = undefined;

// Adds a sent_at column to open_deal_invoices so the send step can be
// claimed atomically.  The UPDATE ... WHERE sent_at IS NULL pattern
// ensures only one concurrent caller fires the QuickBooks invoice send
// and follow-up email even when two users retry for the same invoice at
// the same time (both would have passed the advisory-lock gate on the
// idempotency retry path).

exports.up = pgm => {
  pgm.sql(`
    ALTER TABLE open_deal_invoices
      ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ
  `);
};

exports.down = pgm => {
  pgm.sql(`
    ALTER TABLE open_deal_invoices
      DROP COLUMN IF EXISTS sent_at
  `);
};
