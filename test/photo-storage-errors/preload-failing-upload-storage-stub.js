'use strict';
// Preloaded via NODE_OPTIONS=--require so the spawned server.js resolves
// `require('@replit/object-storage')` to the failing-upload fake. Simulates
// a configured bucket where uploadFromBytes itself returns { ok: false }.

const Module = require('module');
const path   = require('path');

const FAKE_PATH = path.join(__dirname, 'failing-upload-object-storage.js');
const origResolve = Module._resolveFilename;

Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '@replit/object-storage') {
    return FAKE_PATH;
  }
  return origResolve.call(this, request, parent, ...rest);
};
