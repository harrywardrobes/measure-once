'use strict';
// Encrypts any existing plaintext access_token / refresh_token rows in
// google_oauth_tokens using AES-256-GCM (via google-token-crypto.cjs).
//
// Detection: we attempt to decrypt each value with the current key.  If
// decryption succeeds the value is already encrypted ciphertext — skip it.
// If decryption fails (auth-tag mismatch, wrong length, etc.) the value is
// plaintext — encrypt it.  AES-256-GCM's authentication guarantee makes this
// fully deterministic: valid ciphertext for our key always decrypts cleanly;
// any other string (plaintext, ciphertext from a different key) will throw.
//
// Safe to re-run: rows that are already encrypted decrypt successfully and
// are left untouched; rows that have already been set to NULL/empty are also
// skipped.
//
// Down: intentionally a no-op.  Decrypting back to plaintext on rollback
// would require the key to be present and would re-expose tokens in the clear,
// so we treat the encrypted state as the floor and do not reverse it.

const { encrypt, tryDecrypt } = require('../google-token-crypto.cjs');

exports.shorthands = undefined;

exports.up = async (pgm) => {
  const { rows } = await pgm.db.query(
    'SELECT user_sub, access_token, refresh_token FROM google_oauth_tokens',
  );

  for (const row of rows) {
    // For each field: try decrypting — success means already encrypted (skip);
    // failure means plaintext (encrypt it now).
    let encAccessToken  = row.access_token;
    let encRefreshToken = row.refresh_token;
    let changed = false;

    if (row.access_token) {
      const { ok } = tryDecrypt(row.access_token);
      if (!ok) {
        encAccessToken = encrypt(row.access_token);
        changed = true;
      }
    }

    if (row.refresh_token) {
      const { ok } = tryDecrypt(row.refresh_token);
      if (!ok) {
        encRefreshToken = encrypt(row.refresh_token);
        changed = true;
      }
    }

    if (changed) {
      await pgm.db.query(
        `UPDATE google_oauth_tokens
            SET access_token  = $2,
                refresh_token = $3,
                updated_at    = now()
          WHERE user_sub = $1`,
        [row.user_sub, encAccessToken, encRefreshToken],
      );
    }
  }
};

exports.down = (_pgm) => {
  // Intentional no-op — see module comment above.
};
