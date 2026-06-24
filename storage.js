// storage.js — storage-provider abstraction for cloud object storage.
//
// Feature code (design-visit-uploads.js, customer-info.js) talks to this
// module's normalised interface instead of any vendor SDK directly. The
// active backend is chosen by the STORAGE_BACKEND env var:
//   - 'replit' (default) → @replit/object-storage
//   - 'gcs'              → @google-cloud/storage (Application Default Creds)
//
// Normalised interface (all async, all throw on real errors and return plain
// values — no SDK `{ ok, value }` envelopes leak out):
//   uploadBytes(name, buffer, opts?)        — opts.compress passthrough.
//   uploadFile(name, filePath)              — streams from disk (no full read).
//   downloadBytes(name)                     — Buffer, or null on 404.
//   deleteObject(name, { ignoreNotFound })  — resolves true, swallows 404.
//   objectExists(name)                      — boolean (header/metadata only).
//
// Client construction is lazy + cached per backend, so importing this module
// never throws at load even with no bucket configured (tests run without one).
// The init error is cached and re-thrown with a consistent, friendly
// "not configured" message so callers can map it to a 503 via their own
// `/bucket|object storage/i` checks.

'use strict';

const BACKEND = (process.env.STORAGE_BACKEND || 'replit').toLowerCase();

// ── Replit Object Storage backend ────────────────────────────────────────────
let _replitClient = null;
let _replitInitTried = false;
let _replitInitError = null;

function getReplitClient() {
  if (_replitInitTried) {
    if (_replitInitError) throw _replitInitError;
    return _replitClient;
  }
  _replitInitTried = true;
  try {
    const { Client } = require('@replit/object-storage');
    _replitClient = new Client();
    return _replitClient;
  } catch (e) {
    _replitInitError = new Error(
      'Object Storage is not configured. Provision a bucket in the Replit ' +
      'Object Storage pane (it will be wired in via .replit automatically), ' +
      'then restart the server. Original error: ' + e.message
    );
    throw _replitInitError;
  }
}

function _is404(code, message) {
  return code === 404 || /not\s*found/i.test(String(message || ''));
}

const replitBackend = {
  async uploadBytes(name, buffer, opts = {}) {
    const client = getReplitClient();
    const res = await client.uploadFromBytes(name, buffer, { compress: !!opts.compress });
    if (res && res.ok === false) {
      throw new Error('Object storage upload failed: ' + (res.error?.message || 'unknown'));
    }
  },

  async uploadFile(name, filePath) {
    const client = getReplitClient();
    const res = await client.uploadFromFilename(name, filePath);
    if (res && res.ok === false) {
      throw new Error('Object storage upload failed: ' + (res.error?.message || 'unknown'));
    }
  },

  async downloadBytes(name) {
    const client = getReplitClient();
    const res = await client.downloadAsBytes(name);
    if (res && res.ok === false) {
      if (_is404(res.error?.statusCode || res.error?.code, res.error?.message)) return null;
      throw new Error('Object storage download failed: ' + (res.error?.message || 'unknown'));
    }
    // SDK returns { ok: true, value: [Buffer] }
    const value = res?.value;
    const buf = Array.isArray(value) ? value[0] : value;
    return buf || null;
  },

  async deleteObject(name, { ignoreNotFound = false } = {}) {
    const client = getReplitClient();
    const res = await client.delete(name, { ignoreNotFound });
    if (res && res.ok === false) {
      if (ignoreNotFound && _is404(res.error?.statusCode || res.error?.code, res.error?.message)) {
        return true;
      }
      throw new Error('Object storage delete failed: ' + (res.error?.message || 'unknown'));
    }
    return true;
  },

  async objectExists(name) {
    const client = getReplitClient();
    const res = await client.list({ prefix: name });
    if (res && res.ok === false) {
      throw new Error('Object storage list failed: ' + (res.error?.message || 'unknown'));
    }
    const objects = res?.value ?? res?.objects ?? [];
    return objects.some(obj => (obj.name ?? obj.key ?? obj) === name);
  },

  async list(prefix) {
    const client = getReplitClient();
    const names = [];
    let cursor;
    do {
      const opts = {};
      if (prefix) opts.prefix = prefix;
      if (cursor) opts.cursor = cursor;
      const res = await client.list(opts);
      if (res && res.ok === false) {
        throw new Error('Object storage list failed: ' + (res.error?.message || 'unknown'));
      }
      const objects = res?.value ?? res?.objects ?? [];
      for (const obj of objects) {
        const name = obj.name ?? obj.key ?? obj;
        if (typeof name === 'string') names.push(name);
      }
      cursor = res?.cursor ?? res?.nextCursor ?? null;
    } while (cursor);
    return names;
  },
};

// ── Google Cloud Storage backend (dormant unless STORAGE_BACKEND=gcs) ─────────
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

function getBackend() {
  return BACKEND === 'gcs' ? gcsBackend : replitBackend;
}

module.exports = {
  STORAGE_BACKEND: BACKEND,
  uploadBytes: (...args) => getBackend().uploadBytes(...args),
  uploadFile: (...args) => getBackend().uploadFile(...args),
  downloadBytes: (...args) => getBackend().downloadBytes(...args),
  deleteObject: (...args) => getBackend().deleteObject(...args),
  objectExists: (...args) => getBackend().objectExists(...args),
  list: (...args) => getBackend().list(...args),
};
