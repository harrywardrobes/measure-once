// design-visit-uploads.js — cloud-storage backend for design-visit room photos.
//
// New room photos are uploaded to Replit Object Storage. The DB only ever
// stores an opaque key of the shape `obj:<uuid>.<ext>`. Callers fetch the
// bytes via short-lived HMAC-signed URLs served by
// `GET /api/design-visit-images/:key`, so neither admin previews nor the
// public sign-off page need to inline base64 bytes any more.
//
// Backwards compatibility: legacy rows already in the DB may hold inline
// `data:image/*;base64,...` URIs, http(s) URLs, or `/uploads/...` paths.
// `toViewUrl()` and the orphan-cleanup helper in `design-visits.js` keep
// handling those legacy shapes unchanged.

const crypto = require('crypto');
const storage = require('./storage');

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp',
]);
const EXT_BY_MIME = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/gif':  'gif',
  'image/webp': 'webp',
  'image/bmp':  'bmp',
};
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const SIGNED_URL_TTL_SEC = 60 * 60;        // 1 hour

// Bucket folder for visit (design + survey) room photos. Kept separate from the
// customer-uploaded `customer-info-photos/` folder so these higher-value staff
// captures are easy to find. Only the opaque `obj:<id>.<ext>` key is stored in
// the DB; this prefix is reconstructed on upload/download, so changing it is
// purely forward-looking (no existing object is renamed).
const STORAGE_PREFIX = 'visit-photos/';

function isOpaqueKey(s) {
  return typeof s === 'string' && /^obj:[A-Za-z0-9_-]{16,}(\.[a-z0-9]{1,8})?$/.test(s);
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:(image\/[a-z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime)) return null;
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return null; }
  if (!buf.length || buf.length > MAX_UPLOAD_BYTES) return null;
  return { mime, buf };
}

const FRIENDLY_UPLOAD_MSG =
  'Photo uploads are temporarily unavailable. Please contact us and we\'ll be in touch to collect your photos another way.';

function _friendlyStorageError(err) {
  if (/bucket|object storage/i.test(err.message)) {
    console.error('[design-visit-uploads] Storage config error (original):', err.message);
    const friendly = new Error(FRIENDLY_UPLOAD_MSG);
    friendly.statusCode = 503;
    return friendly;
  }
  return err;
}

async function uploadFromDataUrl(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    const err = new Error('Invalid or unsupported image data');
    err.statusCode = 400;
    throw err;
  }
  const ext = EXT_BY_MIME[parsed.mime] || 'bin';
  const id  = crypto.randomBytes(18).toString('base64url');
  const name = `${STORAGE_PREFIX}${id}.${ext}`;
  try {
    await storage.uploadBytes(name, parsed.buf, { compress: false });
  } catch (e) {
    throw _friendlyStorageError(e);
  }
  return { storageKey: `obj:${id}.${ext}`, mimeType: parsed.mime, byteLength: parsed.buf.length };
}

function _objectNameFromKey(key) {
  if (!isOpaqueKey(key)) return null;
  return STORAGE_PREFIX + key.slice('obj:'.length);
}

async function deleteOpaqueKey(key) {
  const name = _objectNameFromKey(key);
  if (!name) return false;
  try {
    await storage.deleteObject(name, { ignoreNotFound: true });
  } catch (e) {
    throw _friendlyStorageError(e);
  }
  return true;
}

async function downloadOpaqueKey(key) {
  const name = _objectNameFromKey(key);
  if (!name) return null;
  try {
    return await storage.downloadBytes(name);
  } catch (e) {
    throw _friendlyStorageError(e);
  }
}

// ── Batch download helper ────────────────────────────────────────────────────
// Download multiple opaque storage keys in parallel.  Each entry resolves to
// { key, buf } where buf is a Buffer (or null when the object is not found or
// the key is not a valid opaque key).  Errors from individual downloads are
// caught per-key and returned as { key, buf: null, error }.
//
// WARNING: do NOT convert this to a serial for…of / await loop.  Each
// storage.downloadBytes call incurs one full RTT to object storage.  A serial
// loop would multiply that by N (number of photos), making it O(N × RTT)
// instead of O(1 × RTT) for the whole batch.  The
// scripts/check-parallel-downloads.mjs test enforces Promise.all wrapping here.
async function downloadOpaqueKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  return Promise.all(
    keys.map(async (key) => {
      const name = _objectNameFromKey(key);
      if (!name) return { key, buf: null };
      try {
        const buf = await storage.downloadBytes(name);
        return { key, buf: buf || null };
      } catch (e) {
        return { key, buf: null, error: _friendlyStorageError(e) };
      }
    }),
  );
}

// ── HMAC-signed URL helpers ──────────────────────────────────────────────────
function _signingSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is required to sign image URLs');
  return s;
}
function _createUrlSignature(key, exp) {
  return crypto
    .createHmac('sha256', _signingSecret())
    .update(`${key}|${exp}`)
    .digest('hex');
}

function signImageUrl(storageKey, ttlSec = SIGNED_URL_TTL_SEC) {
  if (!isOpaqueKey(storageKey)) return storageKey; // pass through legacy URLs/data URIs
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, ttlSec | 0);
  const sig = _createUrlSignature(storageKey, exp);
  return `/api/design-visit-images/${encodeURIComponent(storageKey)}?exp=${exp}&sig=${sig}`;
}

function verifySignedUrl(storageKey, exp, sig) {
  if (!isOpaqueKey(storageKey)) return false;
  const expNum = parseInt(exp, 10);
  if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) return false;
  if (typeof sig !== 'string' || sig.length !== 64) return false;
  const expected = _createUrlSignature(storageKey, expNum);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  isOpaqueKey,
  uploadFromDataUrl,
  deleteOpaqueKey,
  downloadOpaqueKey,
  downloadOpaqueKeys,
  signImageUrl,
  verifySignedUrl,
  MAX_UPLOAD_BYTES,
  ALLOWED_MIME,
};
