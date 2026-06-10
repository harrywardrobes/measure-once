'use strict';

/**
 * Remove the hw_lead_substatus / sub-status system.
 *
 * - Drops substatus_id column from card_action_handler_bindings
 * - Drops lead_substatuses table
 * - Drops substatus_clear_failures table
 *
 * The hw_lead_substatus HubSpot property deletion is handled at startup by a
 * fire-and-forget IIFE in server.js. If deletion is blocked by a referencing
 * workflow/list, run: node scripts/cleanup-hw-lead-substatus.mjs --fix
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE card_action_handler_bindings DROP COLUMN IF EXISTS substatus_id;
    DROP TABLE IF EXISTS lead_substatuses CASCADE;
    DROP TABLE IF EXISTS substatus_clear_failures CASCADE;
  `);
};

exports.down = () => {
  // Intentionally a no-op — re-creating these tables is not supported.
};
