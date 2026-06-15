'use strict';
// Data-cleanup migration: remove stale command-palette action IDs from
// search_settings.
//
// The IDs `go-admin-tab-designvisit` and `go-admin-tab-surveyvisit` were
// replaced by `go-admin-visits`. Any row in search_settings that still carries
// them in `disabled_actions` or `action_order` results in silent no-ops in the
// command palette. This migration scrubs them from both JSONB arrays.
//
// Safe to re-run: the array_remove expressions are idempotent.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE search_settings
    SET
      disabled_actions = (
        SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(disabled_actions) AS elem
        WHERE elem::text NOT IN ('"go-admin-tab-designvisit"', '"go-admin-tab-surveyvisit"')
      ),
      action_order = (
        SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(action_order) AS elem
        WHERE elem::text NOT IN ('"go-admin-tab-designvisit"', '"go-admin-tab-surveyvisit"')
      )
    WHERE
      disabled_actions @> '["go-admin-tab-designvisit"]'::jsonb
      OR disabled_actions @> '["go-admin-tab-surveyvisit"]'::jsonb
      OR action_order    @> '["go-admin-tab-designvisit"]'::jsonb
      OR action_order    @> '["go-admin-tab-surveyvisit"]'::jsonb;
  `);
};

exports.down = (pgm) => {
  // The stale IDs are not re-inserted on rollback — this is a one-way
  // data-cleanup; the old IDs no longer correspond to any registered action.
};
