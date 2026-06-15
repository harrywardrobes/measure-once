'use strict';
// google-token-crypto.cjs
//
// AES-256-GCM encrypt/decrypt helpers for Google OAuth tokens stored in
// google_oauth_tokens.  The symmetric key comes from the GOOGLE_TOKEN_ENCRYPTION_KEY
// environment variable (a base64-encoded 32-byte secret set in Replit Secrets).
//
// Wire format (base64url-encoded string):
//   <12-byte IV> || <ciphertext> || <16-byte auth-tag>
// All three parts are concatenated then base64url-encoded as one opaque string.
//
// Tokens are short strings, so no streaming is needed.

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES   = 12;
const TAG_BYTES  = 16;

function getKey() {
  const raw = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'GOOGLE_TOKEN_ENCRYPTION_KEY is not set. ' +
      'Add a 32-byte base64 secret to Replit Secrets.',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `GOOGLE_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}).`,
    );
  }
  return key;
}

/**
 * Parse and validate a base64-encoded 32-byte key string.
 * Returns a Buffer or throws a descriptive error.
 * Use this in admin/rotation scripts that accept an explicit key value.
 */
function parseKey(base64String, label = 'key') {
  if (!base64String) {
    throw new Error(`google-token-crypto: ${label} is missing or empty.`);
  }
  const key = Buffer.from(base64String, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `google-token-crypto: ${label} must decode to exactly 32 bytes (got ${key.length}).`,
    );
  }
  return key;
}

// ── Low-level helpers that accept an explicit key buffer ──────────────────────

/**
 * Encrypt a plaintext string using an explicit key buffer.
 * Returns an opaque base64url string (IV + ciphertext + tag).
 */
function encryptWithKey(plaintext, keyBuffer) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  const iv  = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString('base64url');
}

/**
 * Decrypt an opaque base64url string produced by `encryptWithKey`.
 * Returns the original plaintext string, or null/undefined if the input was null/undefined.
 * Throws if the ciphertext is invalid or the auth tag check fails.
 */
function decryptWithKey(ciphertext, keyBuffer) {
  if (ciphertext === null || ciphertext === undefined) return ciphertext;
  const buf  = Buffer.from(String(ciphertext), 'base64url');
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error('google-token-crypto: ciphertext is too short to be valid');
  }
  const iv         = buf.subarray(0, IV_BYTES);
  const tag        = buf.subarray(buf.length - TAG_BYTES);
  const encrypted  = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
  const decipher   = crypto.createDecipheriv(ALGORITHM, keyBuffer, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * Try to decrypt a value using an explicit key buffer.
 * Returns { ok: true, plaintext } on success, or { ok: false } on failure.
 */
function tryDecryptWithKey(value, keyBuffer) {
  if (!value) return { ok: false };
  try {
    const plaintext = decryptWithKey(value, keyBuffer);
    return { ok: true, plaintext };
  } catch {
    return { ok: false };
  }
}

// ── Convenience wrappers that read the key from the environment ───────────────

/**
 * Encrypt a plaintext string.
 * Returns an opaque base64url string (IV + ciphertext + tag).
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  return encryptWithKey(plaintext, getKey());
}

/**
 * Decrypt an opaque base64url string produced by `encrypt`.
 * Returns the original plaintext string, or null/undefined if the input was null/undefined.
 * Throws if the ciphertext is invalid or the auth tag check fails.
 */
function decrypt(ciphertext) {
  if (ciphertext === null || ciphertext === undefined) return ciphertext;
  return decryptWithKey(ciphertext, getKey());
}

/**
 * Try to decrypt a value.  Returns { ok: true, plaintext } on success,
 * or { ok: false } if decryption fails for any reason.
 *
 * Use this when you need to distinguish "already encrypted" from "plaintext"
 * without guessing from the string shape (e.g. in migration logic).
 * AES-256-GCM authentication will reliably reject plaintext as invalid ciphertext.
 */
function tryDecrypt(value) {
  if (!value) return { ok: false };
  try {
    const plaintext = decrypt(value);
    return { ok: true, plaintext };
  } catch {
    return { ok: false };
  }
}

module.exports = {
  encrypt,
  decrypt,
  tryDecrypt,
  encryptWithKey,
  decryptWithKey,
  tryDecryptWithKey,
  parseKey,
};
