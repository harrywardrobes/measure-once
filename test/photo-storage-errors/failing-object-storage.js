'use strict';
// Fake @replit/object-storage whose Client constructor throws the raw SDK
// error that the photo-storage-errors error handling was introduced to suppress. Used by the
// photo-storage-errors test suite to verify neither photo-upload route
// leaks this internal message to callers.

class Client {
  constructor() {
    throw new Error('A bucket name is needed to use Cloud Storage.');
  }
}

module.exports = { Client };
