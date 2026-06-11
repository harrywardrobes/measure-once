'use strict';

exports.shorthands = undefined;

// Tracks deposit invoices created by the accept-deal flow so that a network
// retry or duplicate UI submission never creates a second invoice for the same
// estimate.  estimate_id is declared UNIQUE — on retry the route reads the
// existing row and returns the already-created invoice without calling QB again.

exports.up = pgm => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS open_deal_invoices (
      id               SERIAL PRIMARY KEY,
      estimate_id      TEXT        NOT NULL,
      contact_id       TEXT        NOT NULL,
      invoice_id       TEXT        NOT NULL,
      invoice_doc_num  TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT open_deal_invoices_estimate_id_uq UNIQUE (estimate_id)
    )
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS open_deal_invoices_contact_id_idx ON open_deal_invoices (contact_id)`);
};

exports.down = pgm => {
  pgm.sql(`DROP TABLE IF EXISTS open_deal_invoices`);
};
