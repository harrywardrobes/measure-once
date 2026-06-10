'use strict';

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS contact_attempt_log (
      id                  SERIAL      PRIMARY KEY,
      hubspot_contact_id  TEXT        NOT NULL
                            REFERENCES contact_attempt_tracking(hubspot_contact_id)
                            ON DELETE CASCADE,
      method              TEXT        NOT NULL
                            CHECK (method IN ('call', 'email', 'whatsapp')),
      attempted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempted_by        TEXT        REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contact_attempt_log_contact
      ON contact_attempt_log (hubspot_contact_id, attempted_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX  IF EXISTS idx_contact_attempt_log_contact;
    DROP TABLE  IF EXISTS contact_attempt_log;
  `);
};
