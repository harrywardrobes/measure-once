'use strict';
// Slow in-memory @replit/object-storage stub for the parallel-download perf
// test.  Every downloadAsBytes call waits DELAY_MS before resolving, so that
// 10 serial downloads would take 10 × DELAY_MS but 10 parallel downloads (via
// Promise.all) take only ~1 × DELAY_MS.
//
// DELAY_MS is tunable via the SLOW_STORAGE_DELAY_MS env var (default: 50).

const DELAY_MS = Number(process.env.SLOW_STORAGE_DELAY_MS) || 50;

const fs = require('fs');

const _bytes = new Map();

class Client {
  constructor() {}

  async uploadFromBytes(name, buf) {
    _bytes.set(String(name), Buffer.from(buf));
    return { ok: true };
  }

  async uploadFromFilename(name, filePath) {
    // customer-info photo uploads stream from a temp file via the SDK's
    // uploadFromFilename; mirror that by reading the file into the in-memory
    // store so the later (slow) downloadAsBytes returns the same bytes.
    _bytes.set(String(name), fs.readFileSync(filePath));
    return { ok: true };
  }

  async downloadAsBytes(name) {
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
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

module.exports = { Client, __bytes: _bytes, DELAY_MS };
