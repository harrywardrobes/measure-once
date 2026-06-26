'use strict';
// Drop two orphan tables that were never created by the app's own migration
// system and have no application code references:
//
//   db_editor_audit — created by the old database editor integration; zero rows.
//   migrations      — a legacy third-party database integration's own tracker;
//                     the app uses pgmigrations exclusively via node-pg-migrate.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS db_editor_audit;
    DROP TABLE IF EXISTS migrations;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS migrations (
      id          INTEGER NOT NULL,
      name        VARCHAR NOT NULL,
      hash        VARCHAR NOT NULL,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS db_editor_audit (
      id               SERIAL PRIMARY KEY,
      acted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      admin_email      TEXT        NOT NULL,
      table_name       TEXT        NOT NULL,
      pk               TEXT,
      op               TEXT        NOT NULL,
      before_data      JSONB,
      after_data       JSONB,
      reverts_audit_id INTEGER
    );
  `);
};
