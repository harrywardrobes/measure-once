'use strict';
// In-memory @google-cloud/storage stub used by the design-visit photo
// probes. Stores uploaded bytes in a module-level Map keyed by object name
// (e.g. "visit-photos/<id>.png"). Mirrors the bits of the real SDK that
// design-visit-uploads.js calls via storage.js's gcsBackend: bucket.file(name)
// .save/.download/.delete — each resolves on success and throws on failure
// (a 404-coded Error for "not found").

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
}

class Storage {
  constructor() {}
  bucket(_name) { return new FakeBucket(); }
}

module.exports = { Storage, __bytes: _bytes };
