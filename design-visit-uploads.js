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

let _client = null;
let _clientInitTried = false;
let _clientInitError = null;
function getClient() {
  if (_clientInitTried) {
    if (_clientInitError) throw _clientInitError;
    return _client;
  }
  _clientInitTried = true;
  try {
    const { Client } = require('@replit/object-storage');
    _client = new Client();
    return _client;
  } catch (e) {
    _clientInitError = new Error(
      'Object Storage is not configured. Provision a bucket in the Replit ' +
      'Object Storage pane (it will be wired in via .replit automatically), ' +
      'then restart the server. Original error: ' + e.message
    );
    throw _clientInitError;
  }
}

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
  const name = `design-visit-images/${id}.${ext}`;
  let client;
  try {
    client = getClient();
  } catch (e) {
    throw _friendlyStorageError(e);
  }
  let res;
  try {
    res = await client.uploadFromBytes(name, parsed.buf, { compress: false });
  } catch (e) {
    throw _friendlyStorageError(e);
  }
  if (res && res.ok === false) {
    throw _friendlyStorageError(new Error('Object storage upload failed: ' + (res.error?.message || 'unknown')));
  }
  return { storageKey: `obj:${id}.${ext}`, mimeType: parsed.mime, byteLength: parsed.buf.length };
}

function _objectNameFromKey(key) {
  if (!isOpaqueKey(key)) return null;
  return 'design-visit-images/' + key.slice('obj:'.length);
}

async function deleteOpaqueKey(key) {
  const name = _objectNameFromKey(key);
  if (!name) return false;
  let client;
  try {
    client = getClient();
  } catch (e) {
    throw _friendlyStorageError(e);
  }
  let res;
  try {
    res = await client.delete(name, { ignoreNotFound: true });
  } catch (e) {
    throw _friendlyStorageError(e);
  }
  if (res && res.ok === false) {
    throw _friendlyStorageError(new Error('Object storage delete failed: ' + (res.error?.message || 'unknown')));
  }
  return true;
}

async function downloadOpaqueKey(key) {
  const name = _objectNameFromKey(key);
  if (!name) return null;
  let client;
  try {
    client = getClient();
  } catch (e) {
    throw _friendlyStorageError(e);
  }
  let res;
  try {
    res = await client.downloadAsBytes(name);
  } catch (e) {
    throw _friendlyStorageError(e);
  }
  if (res && res.ok === false) {
    const code = res.error?.statusCode || res.error?.code;
    if (code === 404 || /not\s*found/i.test(String(res.error?.message || ''))) return null;
    throw _friendlyStorageError(new Error('Object storage download failed: ' + (res.error?.message || 'unknown')));
  }
  // SDK returns { ok: true, value: [Buffer] }
  const value = res?.value;
  const buf = Array.isArray(value) ? value[0] : value;
  return buf || null;
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
  signImageUrl,
  verifySignedUrl,
  MAX_UPLOAD_BYTES,
  ALLOWED_MIME,
};
