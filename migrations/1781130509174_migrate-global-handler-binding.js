'use strict';

/**
 * Rename any surviving legacy "No lead status (global)" handler bindings
 * from stage_key = 'sales' to stage_key = '__global__'.
 *
 * Migration 1749200000015 did the same rename but ran before a new 'sales'|''
 * binding was created — so that row was never migrated. This migration is a
 * clean-up pass that catches any remaining rows.
 *
 * Note: substatus_id was dropped by 1749200000019_remove-substatuses which
 * runs before this migration (smaller timestamp), so we must NOT reference
 * that column here.
 *
 * UP: rename any sales|'' binding to __global__|''
 * DOWN: rename back (safe — no __global__ row will exist after the down)
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- If a __global__/'' binding already exists, the sales/'' row is a
    -- duplicate — delete it rather than causing a unique-index conflict.
    DELETE FROM card_action_handler_bindings
    WHERE stage_key = 'sales'
      AND (status_key IS NULL OR status_key = '')
      AND EXISTS (
        SELECT 1 FROM card_action_handler_bindings g
        WHERE g.stage_key = '__global__'
          AND (g.status_key IS NULL OR g.status_key = '')
      );

    -- Re-point any surviving sales/'' row to the canonical global slot.
    UPDATE card_action_handler_bindings
    SET    stage_key  = '__global__',
           status_key = ''
    WHERE  stage_key = 'sales'
      AND  (status_key IS NULL OR status_key = '');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE card_action_handler_bindings
    SET    stage_key = 'sales'
    WHERE  stage_key = '__global__'
      AND  (status_key IS NULL OR status_key = '');
  `);
};
