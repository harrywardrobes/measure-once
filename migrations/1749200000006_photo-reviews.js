'use strict';
// Baseline migration: photo-review outcomes schema.
// DDL copied verbatim from photo-reviews.js ensurePhotoReviewOutcomesTable().
// The one-time AWPH_RECIEVED -> AWPH_RECEIVED data repair (which depends on
// lead_substatuses / card_action_handler_bindings) remains a boot data op.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS photo_review_outcomes (
      id                  SERIAL PRIMARY KEY,
      submission_id       INT  NOT NULL REFERENCES customer_info_submissions(id) ON DELETE CASCADE,
      contact_id          TEXT NOT NULL,
      outcome             TEXT NOT NULL CHECK (outcome IN ('not_suitable', 'rough_estimate_sent')),
      price_range         TEXT,
      email_subject       TEXT NOT NULL,
      email_body          TEXT NOT NULL,
      reviewed_by_user_id TEXT NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS pro_submission_id_idx ON photo_review_outcomes (submission_id);
    CREATE INDEX IF NOT EXISTS pro_contact_id_idx ON photo_review_outcomes (contact_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS photo_review_outcomes;`);
};
