'use strict';

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS contact_attempt_history_log (
      id                 SERIAL PRIMARY KEY,
      hubspot_contact_id TEXT        NOT NULL,
      attempted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempted_by       TEXT        REFERENCES users(id) ON DELETE SET NULL,
      call_attempted     BOOLEAN     NOT NULL DEFAULT FALSE,
      email_sent         BOOLEAN     NOT NULL DEFAULT FALSE,
      whatsapp_sent      BOOLEAN     NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_cahl_contact
      ON contact_attempt_history_log(hubspot_contact_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS contact_attempt_history_log;`);
};
