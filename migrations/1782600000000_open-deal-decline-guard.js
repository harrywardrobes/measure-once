'use strict';

exports.shorthands = undefined;

// Tracks when the thank-you email for a declined deal was successfully sent
// for each contact.  The decline-deal route acquires a session-level advisory
// lock keyed on contactId + ':decline' and checks this table before sending so
// that two concurrent retries from different users produce exactly one email.
// declined_at is set only after a successful send, so a transient SMTP failure
// still lets a future retry attempt the send again.

exports.up = pgm => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS open_deal_declines (
      contact_id   TEXT        PRIMARY KEY,
      declined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

exports.down = pgm => {
  pgm.sql(`DROP TABLE IF EXISTS open_deal_declines`);
};
