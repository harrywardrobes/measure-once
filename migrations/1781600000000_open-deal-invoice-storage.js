'use strict';

exports.shorthands = undefined;

// Adds deposit_invoice_id and deposit_invoice_doc_num to design_visits so
// the deposit invoice created by the accept-deal flow can be traced back to
// the visit that generated the underlying estimate.

exports.up = pgm => {
  pgm.sql(`
    ALTER TABLE design_visits
      ADD COLUMN IF NOT EXISTS deposit_invoice_id      TEXT,
      ADD COLUMN IF NOT EXISTS deposit_invoice_doc_num TEXT
  `);
};

exports.down = pgm => {
  pgm.sql(`
    ALTER TABLE design_visits
      DROP COLUMN IF EXISTS deposit_invoice_id,
      DROP COLUMN IF EXISTS deposit_invoice_doc_num
  `);
};
