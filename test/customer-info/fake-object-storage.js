'use strict';
// In-memory @replit/object-storage stub for customer-info photo probes.
// Mirrors the bits of the real SDK called by customer-info.js (via storage.js):
//   uploadFromBytes, uploadFromFilename, downloadAsBytes, delete.

const fs = require('fs');

const _bytes = new Map();

class Client {
  constructor() {}

  async uploadFromBytes(name, buf) {
    _bytes.set(String(name), Buffer.from(buf));
    return { ok: true };
  }

  async uploadFromFilename(name, filePath) {
    // customer-info photo uploads stream from a temp file on disk via the
    // SDK's uploadFromFilename. Mirror that here by reading the file into the
    // in-memory store so a later downloadAsBytes returns the same bytes.
    _bytes.set(String(name), fs.readFileSync(filePath));
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
