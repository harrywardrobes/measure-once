'use strict';

// Remove duplicate card_action_handler_bindings rows that accumulated because
// the seed function used ON CONFLICT DO NOTHING without an actual unique
// constraint on (stage_key, status_key).  For each slot we keep the row with
// the lowest id (the original) and delete the rest.  Then add a unique
// expression index so this can never happen again.
//
// NULL handling: PostgreSQL treats two NULLs as distinct for UNIQUE constraints,
// so we use COALESCE(col, '') in the expression index.  The sentinel '' is safe
// because stage_key='' is never used (slots use '__global__' or a real key).

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Step 1: delete all duplicate rows, keeping the minimum id per slot.
  pgm.sql(`
    DELETE FROM card_action_handler_bindings
    WHERE id NOT IN (
      SELECT MIN(id)
      FROM card_action_handler_bindings
      GROUP BY COALESCE(stage_key, ''), COALESCE(status_key, '')
    )
  `);

  // Step 2: add a unique expression index so future inserts cannot duplicate a slot.
  pgm.sql(`
    CREATE UNIQUE INDEX card_action_handler_bindings_slot_unique
    ON card_action_handler_bindings (
      COALESCE(stage_key, ''),
      COALESCE(status_key, '')
    )
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS card_action_handler_bindings_slot_unique`);
};
