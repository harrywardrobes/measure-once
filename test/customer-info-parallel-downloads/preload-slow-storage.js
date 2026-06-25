'use strict';
// Preloaded via NODE_OPTIONS=--require so the spawned server.js resolves
// `require('@google-cloud/storage')` to the slow in-memory fake.
// Each download() call waits ~50 ms (SLOW_STORAGE_DELAY_MS) before
// resolving, making the difference between serial and parallel downloads
// measurable without touching real object storage.

const Module = require('module');
const path   = require('path');

const FAKE_PATH = path.join(__dirname, 'slow-object-storage.js');
const origResolve = Module._resolveFilename;

Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '@google-cloud/storage') {
    return FAKE_PATH;
  }
  return origResolve.call(this, request, parent, ...rest);
};
