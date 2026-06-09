'use strict';
// Security hardening: customer-info workflow integrity.
//
// 1. Adds a UNIQUE constraint on photo_review_outcomes(submission_id) so the
//    database backstops the application-level "one review per submission" rule
//    and concurrent requests cannot both insert a duplicate outcome.
//
// 2. Expires any pre-existing duplicate active-pending rows per contact so the
//    data is clean before the application-level serialisation takes effect.

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Dedup: expire all but the newest active-pending row per contact so no
  // contact has more than one live bearer link going forward.
  pgm.sql(`
    UPDATE customer_info_submissions
    SET expires_at = NOW()
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY contact_id
                 ORDER BY created_at DESC
               ) AS rn
        FROM customer_info_submissions
        WHERE expires_at > NOW()
          AND submitted_at IS NULL
      ) ranked
      WHERE rn > 1
    );
  `);

  // Unique backstop: only one review outcome per submission.
  // If (unlikely) duplicate rows already exist, keep only the oldest per
  // submission and delete the rest before adding the constraint.
  pgm.sql(`
    DELETE FROM photo_review_outcomes
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY submission_id
                 ORDER BY created_at ASC
               ) AS rn
        FROM photo_review_outcomes
      ) ranked
      WHERE rn > 1
    );
  `);

  pgm.sql(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'pro_submission_id_unique'
          AND table_name = 'photo_review_outcomes'
      ) THEN
        ALTER TABLE photo_review_outcomes
          ADD CONSTRAINT pro_submission_id_unique UNIQUE (submission_id);
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE photo_review_outcomes
      DROP CONSTRAINT IF EXISTS pro_submission_id_unique;
  `);
};
