'use strict';
// Fake @google-cloud/storage whose Storage constructor succeeds but whose
// file().save/.download/.delete all throw a raw SDK-style bucket error.
// Used by the STO-3/STO-4 probes (upload) and STO-8/STO-9 probes
// (delete/download) in the photo-storage-errors suite to verify that the
// thrown-error path is also sanitised before reaching the caller.

class FakeFile {
  async save(_buf) {
    throw new Error('bucket error: no such bucket configured');
  }
  async download() {
    throw new Error('bucket error: no such bucket configured');
  }
  async delete(_opts) {
    throw new Error('bucket error: no such bucket configured');
  }
}

class FakeBucket {
  file(_name) { return new FakeFile(); }
  async upload(_filePath, _opts) {
    throw new Error('bucket error: no such bucket configured');
  }
}

class Storage {
  constructor() {}
  bucket(_name) { return new FakeBucket(); }
}

module.exports = { Storage };
