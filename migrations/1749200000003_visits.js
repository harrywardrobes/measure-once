'use strict';
// Baseline migration: visits schema.
// DDL copied verbatim from visits.js ensureVisitsTable().

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS visits (
      id              SERIAL PRIMARY KEY,
      created_by      VARCHAR NOT NULL,
      customer_id     VARCHAR,
      customer_name   VARCHAR,
      type            VARCHAR NOT NULL,
      title           VARCHAR,
      start_at        TIMESTAMPTZ NOT NULL,
      end_at          TIMESTAMPTZ NOT NULL,
      is_workshop     BOOLEAN NOT NULL DEFAULT FALSE,
      notes           TEXT,
      location        VARCHAR,
      google_event_id VARCHAR,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS visits_start_at_idx ON visits (start_at);
    ALTER TABLE visits ADD COLUMN IF NOT EXISTS assignee_id   VARCHAR;
    ALTER TABLE visits ADD COLUMN IF NOT EXISTS assignee_role VARCHAR;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS visits;`);
};
