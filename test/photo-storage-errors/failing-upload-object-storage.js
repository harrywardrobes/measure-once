'use strict';
// Fake @replit/object-storage whose Client constructor succeeds but whose
// uploadFromBytes, delete, and downloadAsBytes all return
// { ok: false, error: { message: "bucket error" } }.
// Used by the STO-3/STO-4 probes (upload) and STO-8/STO-9 probes
// (delete/download) in the photo-storage-errors suite to verify that the
// ok:false path is also sanitised before reaching the caller.

class Client {
  constructor() {}
  async uploadFromBytes(_name, _buf, _opts) {
    return { ok: false, error: { message: 'bucket error: no such bucket configured' } };
  }
  async uploadFromFilename(_name, _filePath) {
    return { ok: false, error: { message: 'bucket error: no such bucket configured' } };
  }
  async delete(_name, _opts) {
    return { ok: false, error: { message: 'bucket error: no such bucket configured' } };
  }
  async downloadAsBytes(_name) {
    return { ok: false, error: { message: 'bucket error: no such bucket configured' } };
  }
}

module.exports = { Client };
