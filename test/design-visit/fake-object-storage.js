'use strict';
// In-memory @replit/object-storage stub used by the design-visit photo
// probes. Stores uploaded bytes in a module-level Map keyed by object name
// (e.g. "design-visit-images/<id>.png"). The shape mirrors the bits of the
// real SDK that design-visit-uploads.js calls: `uploadFromBytes`,
// `downloadAsBytes`, `delete` — each returns `{ ok: true, value? }` on
// success and `{ ok: false, error: { ... } }` on failure.

const _bytes = new Map();

class Client {
  constructor() {}

  async uploadFromBytes(name, buf /* , opts */) {
    _bytes.set(String(name), Buffer.from(buf));
    return { ok: true };
  }

  async downloadAsBytes(name) {
    const buf = _bytes.get(String(name));
    if (!buf) {
      return { ok: false, error: { statusCode: 404, message: 'not found' } };
    }
    return { ok: true, value: [buf] };
  }

  async delete(name, opts) {
    const had = _bytes.delete(String(name));
    if (!had && !(opts && opts.ignoreNotFound)) {
      return { ok: false, error: { statusCode: 404, message: 'not found' } };
    }
    return { ok: true };
  }
}

module.exports = { Client, __bytes: _bytes };
