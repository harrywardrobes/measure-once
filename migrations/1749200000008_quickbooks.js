'use strict';
// Baseline migration: QuickBooks token + send-log schema.
// DDL copied verbatim from quickbooks.js initDB(). The recurring qb_send_log
// purge (setInterval) remains in quickbooks.js.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS qb_tokens (
      id            SERIAL PRIMARY KEY,
      access_token  TEXT   NOT NULL,
      refresh_token TEXT   NOT NULL,
      realm_id      TEXT   NOT NULL,
      expires_at    BIGINT NOT NULL,
      updated_at    TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS qb_send_log (
      id         SERIAL PRIMARY KEY,
      user_id    TEXT        NOT NULL,
      sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS qb_send_log_user_sent ON qb_send_log (user_id, sent_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS qb_send_log;
    DROP TABLE IF EXISTS qb_tokens;
  `);
};
