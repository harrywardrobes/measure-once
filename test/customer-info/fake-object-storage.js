'use strict';
// In-memory @google-cloud/storage stub for customer-info photo probes.
// Mirrors the bits of the real SDK called by storage.js's gcsBackend:
//   bucket.file(name).save/download/delete, bucket.upload (from disk).

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
    // customer-info photo uploads stream from a temp file on disk via the
    // SDK's bucket.upload. Mirror that here by reading the file into the
    // in-memory store so a later download() returns the same bytes.
    _bytes.set(String(destination), fs.readFileSync(filePath));
  }
}

class Storage {
  constructor() {}
  bucket(_name) { return new FakeBucket(); }
}

module.exports = { Storage, __bytes: _bytes };
