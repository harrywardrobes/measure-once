'use strict';

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS contact_attempt_tracking (
      hubspot_contact_id  TEXT        PRIMARY KEY,
      call_attempted      BOOLEAN     NOT NULL DEFAULT FALSE,
      email_sent          BOOLEAN     NOT NULL DEFAULT FALSE,
      whatsapp_sent       BOOLEAN     NOT NULL DEFAULT FALSE,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS contact_attempt_tracking;`);
};
