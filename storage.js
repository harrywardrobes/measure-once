// storage.js — storage-provider abstraction for cloud object storage.
//
// Feature code (design-visit-uploads.js, customer-info.js) talks to this
// module's normalised interface instead of the @google-cloud/storage SDK
// directly (Application Default Credentials — no keys in code).
//
// Normalised interface (all async, all throw on real errors and return plain
// values — no SDK envelopes leak out):
//   uploadBytes(name, buffer, opts?)        — opts.compress passthrough.
//   uploadFile(name, filePath)              — streams from disk (no full read).
//   downloadBytes(name)                     — Buffer, or null on 404.
//   deleteObject(name, { ignoreNotFound })  — resolves true, swallows 404.
//   objectExists(name)                      — boolean (header/metadata only).
//
// Client construction is lazy + cached, so importing this module never throws
// at load even with no bucket configured (tests run without one). The init
// error is cached and re-thrown with a consistent, friendly "not configured"
// message so callers can map it to a 503 via their own
// `/bucket|object storage/i` checks.

'use strict';

// ── Google Cloud Storage backend ───────────────────────────────────────────
let _gcsBucket = null;
let _gcsInitTried = false;
let _gcsInitError = null;

function getGcsBucket() {
  if (_gcsInitTried) {
    if (_gcsInitError) throw _gcsInitError;
    return _gcsBucket;
  }
  _gcsInitTried = true;
  try {
    const bucketName = process.env.GCS_BUCKET;
    if (!bucketName) {
      throw new Error('GCS_BUCKET environment variable is not set');
    }
    const { Storage } = require('@google-cloud/storage');
    // No keys in code — Application Default Credentials only.
    const gcs = new Storage();
    _gcsBucket = gcs.bucket(bucketName);
    return _gcsBucket;
  } catch (e) {
    _gcsInitError = new Error(
      'Google Cloud Storage bucket is not configured. Set GCS_BUCKET and ensure ' +
      'Application Default Credentials are available, then restart the server. ' +
      'Original error: ' + e.message
    );
    throw _gcsInitError;
  }
}

function _isGcsNotFound(e) {
  const code = e && (e.code ?? e.statusCode);
  return code === 404 || code === '404';
}

const gcsBackend = {
  async uploadBytes(name, buffer, _opts = {}) {
    const bucket = getGcsBucket();
    await bucket.file(name).save(buffer);
  },

  async uploadFile(name, filePath) {
    const bucket = getGcsBucket();
    await bucket.upload(filePath, { destination: name });
  },

  async downloadBytes(name) {
    const bucket = getGcsBucket();
    try {
      const data = await bucket.file(name).download();
      return data[0] || null;
    } catch (e) {
      if (_isGcsNotFound(e)) return null;
      throw e;
    }
  },

  async deleteObject(name, { ignoreNotFound = false } = {}) {
    const bucket = getGcsBucket();
    await bucket.file(name).delete({ ignoreNotFound });
    return true;
  },

  async objectExists(name) {
    const bucket = getGcsBucket();
    const [exists] = await bucket.file(name).exists();
    return !!exists;
  },

  async list(prefix) {
    const bucket = getGcsBucket();
    const [files] = await bucket.getFiles(prefix ? { prefix } : {});
    return files.map(f => f.name);
  },
};

module.exports = {
  STORAGE_BACKEND: 'gcs',
  uploadBytes: (...args) => gcsBackend.uploadBytes(...args),
  uploadFile: (...args) => gcsBackend.uploadFile(...args),
  downloadBytes: (...args) => gcsBackend.downloadBytes(...args),
  deleteObject: (...args) => gcsBackend.deleteObject(...args),
  objectExists: (...args) => gcsBackend.objectExists(...args),
  list: (...args) => gcsBackend.list(...args),
};
