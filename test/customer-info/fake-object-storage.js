'use strict';
// In-memory @replit/object-storage stub for customer-info photo probes.
// Mirrors the bits of the real SDK called by customer-info.js:
//   uploadFromBytes, downloadAsBytes — returns { ok, value? }.

const _bytes = new Map();

class Client {
  constructor() {}

  async uploadFromBytes(name, buf) {
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
