'use strict';

// Idempotency key for design-visit submissions.
//
// The offline sync engine only deletes an outbox entry after a confirmed 2xx,
// so a response lost *after* the server committed would otherwise replay into a
// duplicate visit (and, for brand-new customers, a duplicate HubSpot contact +
// duplicate sign-off email). The client mints one `client_submission_id` per
// visit; POST /api/design-visits returns the existing row on a repeat instead
// of inserting again. Nullable so existing/in-app submissions are unaffected;
// the UNIQUE index ignores NULLs (Postgres treats NULLs as distinct).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE design_visits ADD COLUMN IF NOT EXISTS client_submission_id TEXT`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS design_visits_client_submission_id_key
           ON design_visits (client_submission_id)
           WHERE client_submission_id IS NOT NULL`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS design_visits_client_submission_id_key`);
  pgm.sql(`ALTER TABLE design_visits DROP COLUMN IF EXISTS client_submission_id`);
};
