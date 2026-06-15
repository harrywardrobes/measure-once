#!/usr/bin/env node
// scripts/rotate-google-token-key.mjs
//
// Re-encrypts all rows in google_oauth_tokens from an old key to a new key.
// Run this after rotating GOOGLE_TOKEN_ENCRYPTION_KEY so existing tokens stay
// usable without forcing all users to reconnect.
//
// Required env vars:
//   GOOGLE_TOKEN_ENCRYPTION_KEY_OLD  — the base64-encoded 32-byte key that was
//                                      used when the tokens were originally saved
//   GOOGLE_TOKEN_ENCRYPTION_KEY      — the new base64-encoded 32-byte key
//   DATABASE_URL                     — PostgreSQL connection string (set by Replit)
//
// Usage:
//   GOOGLE_TOKEN_ENCRYPTION_KEY_OLD=<old-base64-key> \
//   GOOGLE_TOKEN_ENCRYPTION_KEY=<new-base64-key> \
//   node scripts/rotate-google-token-key.mjs
//
// or via npm:
//   GOOGLE_TOKEN_ENCRYPTION_KEY_OLD=<old> npm run google:rotate-token-key
//
// Behaviour per row:
//   - If the token decrypts OK with the old key: re-encrypt with the new key
//     and UPDATE the row.  The user's connection is preserved.
//   - If the token cannot be decrypted with the old key: the row is already
//     stale (perhaps from an earlier rotation or corruption).  The row is
//     DELETED so the user is asked to reconnect cleanly rather than being
//     stuck with an unreadable token.
//   - Dry-run mode (--dry-run): prints what would happen without touching the DB.

import pg from 'pg';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { encryptWithKey, tryDecryptWithKey, parseKey } = require('../google-token-crypto.cjs');

// ── Args / dry-run ────────────────────────────────────────────────────────────

const isDryRun = process.argv.includes('--dry-run');
if (isDryRun) {
  console.log('[rotate-google-token-key] DRY RUN — no database changes will be made.\n');
}

// ── Key parsing ───────────────────────────────────────────────────────────────

const oldKeyBase64 = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_OLD;
const newKeyBase64 = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;

if (!oldKeyBase64) {
  console.error(
    'ERROR: GOOGLE_TOKEN_ENCRYPTION_KEY_OLD is not set.\n' +
    'Set it to the base64-encoded 32-byte key that was used to encrypt the existing tokens.',
  );
  process.exit(1);
}
if (!newKeyBase64) {
  console.error(
    'ERROR: GOOGLE_TOKEN_ENCRYPTION_KEY is not set.\n' +
    'Set it to the new base64-encoded 32-byte key to re-encrypt tokens with.',
  );
  process.exit(1);
}

let oldKey, newKey;
try {
  oldKey = parseKey(oldKeyBase64, 'GOOGLE_TOKEN_ENCRYPTION_KEY_OLD');
} catch (e) {
  console.error(`ERROR parsing old key: ${e.message}`);
  process.exit(1);
}
try {
  newKey = parseKey(newKeyBase64, 'GOOGLE_TOKEN_ENCRYPTION_KEY');
} catch (e) {
  console.error(`ERROR parsing new key: ${e.message}`);
  process.exit(1);
}

if (oldKeyBase64 === newKeyBase64) {
  console.error('ERROR: GOOGLE_TOKEN_ENCRYPTION_KEY_OLD and GOOGLE_TOKEN_ENCRYPTION_KEY are identical — nothing to rotate.');
  process.exit(1);
}

// ── DB connection ─────────────────────────────────────────────────────────────

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Re-encrypt a single ciphertext field.
 * Returns { ok: true, ciphertext } on success, or { ok: false } if the old
 * key could not decrypt the value.
 */
function reEncrypt(value) {
  if (!value) return { ok: true, ciphertext: value };
  const { ok, plaintext } = tryDecryptWithKey(value, oldKey);
  if (!ok) return { ok: false };
  const ciphertext = encryptWithKey(plaintext, newKey);
  return { ok: true, ciphertext };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[rotate-google-token-key] Connecting to database…');
  const client = await pool.connect();

  try {
    const { rows } = await client.query(
      'SELECT user_sub, access_token, refresh_token FROM google_oauth_tokens ORDER BY user_sub',
    );

    console.log(`[rotate-google-token-key] Found ${rows.length} row(s) to process.\n`);

    let updated = 0;
    let deleted = 0;
    let skipped = 0;

    for (const row of rows) {
      const { user_sub, access_token, refresh_token } = row;

      const accessResult  = reEncrypt(access_token);
      const refreshResult = reEncrypt(refresh_token);

      const canRotate = accessResult.ok && refreshResult.ok;

      if (canRotate) {
        if (isDryRun) {
          console.log(`  [DRY RUN] Would UPDATE user_sub=${user_sub}`);
        } else {
          await client.query(
            `UPDATE google_oauth_tokens
             SET access_token  = $1,
                 refresh_token = $2,
                 updated_at    = now()
             WHERE user_sub = $3`,
            [accessResult.ciphertext, refreshResult.ciphertext, user_sub],
          );
          console.log(`  UPDATED user_sub=${user_sub}`);
        }
        updated++;
      } else {
        // Token is unreadable with the old key — delete so the user is prompted
        // to reconnect cleanly.
        if (isDryRun) {
          console.log(`  [DRY RUN] Would DELETE user_sub=${user_sub} (token unreadable with old key)`);
        } else {
          await client.query(
            'DELETE FROM google_oauth_tokens WHERE user_sub = $1',
            [user_sub],
          );
          console.warn(`  DELETED user_sub=${user_sub} — token could not be decrypted with the old key (user will be asked to reconnect)`);
        }
        deleted++;
      }
    }

    console.log(`
[rotate-google-token-key] Done.
  Updated (re-encrypted): ${updated}
  Deleted (unreadable):   ${deleted}
  Skipped:                ${skipped}
${isDryRun ? '\n(Dry run — no changes were committed.)' : ''}
After rotation, update GOOGLE_TOKEN_ENCRYPTION_KEY in Replit Secrets to the new
value and restart the application. Remove GOOGLE_TOKEN_ENCRYPTION_KEY_OLD once
you have confirmed the app is working correctly.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[rotate-google-token-key] Fatal error:', e);
  process.exit(1);
});
