const admin = require('firebase-admin');

// Initialise once. On Cloud Run, applicationDefault() picks up the
// Cloud Run service account automatically. Locally, run:
//   gcloud auth application-default login
// and set IDENTITY_PROJECT_ID=harrywardrobes in .env.
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: process.env.IDENTITY_PROJECT_ID,
  });
}

module.exports = admin;
