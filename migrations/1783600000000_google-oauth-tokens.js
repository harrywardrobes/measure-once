'use strict';
// Creates the google_oauth_tokens table for persisting Google OAuth credentials
// per user across logout/login cycles and server restarts. Mirrors the pattern
// used by qb_tokens for QuickBooks.
//
// TODO: Add column-level encryption for access_token and refresh_token before
// storing any real credentials in a production environment. Currently tokens are
// stored as plaintext — protect this table with strict DB-level access controls
// until encryption is in place.
//
// Safe to re-run: the CREATE TABLE is guarded by IF NOT EXISTS.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS google_oauth_tokens (
      user_sub     TEXT        PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT       NOT NULL,
      scope        TEXT,
      expires_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS google_oauth_tokens;`);
};
