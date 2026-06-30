'use strict';
// Per-user upload token for the WhatsApp-photo share path (iOS Shortcut /
// scripted uploads that can't carry a session cookie). The raw token is shown
// to the user once and only its SHA-256 hash is stored. One active token per
// user: regenerating overwrites the hash; revoking nulls it.
//
//   upload_token_hash         — SHA-256 hex of the raw token (NULL = none).
//   upload_token_created_at   — when the current token was minted.
//   upload_token_last_used_at — last successful auth via the token (NULL until used).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS upload_token_hash         TEXT,
      ADD COLUMN IF NOT EXISTS upload_token_created_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS upload_token_last_used_at TIMESTAMPTZ;

    -- Fast, unique lookup by token hash (only rows that have a token).
    CREATE UNIQUE INDEX IF NOT EXISTS users_upload_token_hash_idx
      ON users (upload_token_hash)
      WHERE upload_token_hash IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS users_upload_token_hash_idx;
    ALTER TABLE users
      DROP COLUMN IF EXISTS upload_token_last_used_at,
      DROP COLUMN IF EXISTS upload_token_created_at,
      DROP COLUMN IF EXISTS upload_token_hash;
  `);
};
