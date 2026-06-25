'use strict';
// Slow in-memory @google-cloud/storage stub for the parallel-download perf
// test. Every download() call waits DELAY_MS before resolving, so that
// 10 serial downloads would take 10 × DELAY_MS but 10 parallel downloads (via
// Promise.all) take only ~1 × DELAY_MS.
//
// DELAY_MS is tunable via the SLOW_STORAGE_DELAY_MS env var (default: 50).

const DELAY_MS = Number(process.env.SLOW_STORAGE_DELAY_MS) || 50;

const fs = require('fs');

const _bytes = new Map();

function notFoundError() {
  const err = new Error('No such object.');
  err.code = 404;
  return err;
}

class FakeFile {
  constructor(name) { this._name = name; }

  async save(buf) {
    _bytes.set(String(this._name), Buffer.from(buf));
  }

  async download() {
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    const buf = _bytes.get(String(this._name));
    if (!buf) throw notFoundError();
    return [buf];
  }

  async delete({ ignoreNotFound = false } = {}) {
    const had = _bytes.delete(String(this._name));
    if (!had && !ignoreNotFound) throw notFoundError();
  }
}

class FakeBucket {
  file(name) { return new FakeFile(name); }

  async upload(filePath, { destination } = {}) {
    // customer-info photo uploads stream from a temp file via the SDK's
    // bucket.upload; mirror that by reading the file into the in-memory
    // store so the later (slow) download() returns the same bytes.
    _bytes.set(String(destination), fs.readFileSync(filePath));
  }
}

class Storage {
  constructor() {}
  bucket(_name) { return new FakeBucket(); }
}

module.exports = { Storage, __bytes: _bytes, DELAY_MS };
