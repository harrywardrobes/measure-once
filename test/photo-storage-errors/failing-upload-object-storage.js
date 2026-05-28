'use strict';
// Fake @replit/object-storage whose Client constructor succeeds but whose
// uploadFromBytes returns { ok: false, error: { message: "bucket error" } }.
// Used by the STO-3 / STO-4 probes in the photo-storage-errors suite to
// verify that the ok:false path is also sanitised before reaching the caller.

class Client {
  constructor() {}
  async uploadFromBytes(_name, _buf, _opts) {
    return { ok: false, error: { message: 'bucket error: no such bucket configured' } };
  }
}

module.exports = { Client };
