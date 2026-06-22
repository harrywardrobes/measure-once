'use strict';
// Restore legacy catalogue stub tables on dev to unblock Replit publish-time
// schema diff.
//
// Root cause of the publish failure:
//   1783100000000_catalog-tables.js dropped design_visit_door_styles,
//   design_visit_furniture_ranges, and design_visit_handles on dev and
//   re-pointed three FKs to the new catalog_* tables.  Those old tables still
//   exist on prod.
//
//   Replit's publish-time dev→prod diff sees the tables missing on dev and
//   generates:
//     DROP TABLE design_visit_door_styles       CASCADE
//     DROP TABLE design_visit_furniture_ranges  CASCADE
//     DROP TABLE design_visit_handles           CASCADE
//
//   Each CASCADE implicitly removes the FK constraints that reference those
//   tables (design_visit_rooms_door_style_id_fkey,
//   design_visits_furniture_range_id_fkey, design_visits_handle_id_fkey).
//   The diff ALSO generates explicit ALTER TABLE … DROP CONSTRAINT statements
//   for those same FKs (to handle the FK target change →catalog_*).  Because
//   the CASCADE already removed the constraints, the explicit DROP CONSTRAINT
//   fails with "constraint does not exist", and the whole publish rolls back.
//
// Fix:
//   Recreate the three tables as empty stubs on dev, matching prod's schema
//   exactly.  Now both sides have the tables → Replit skips the DROP TABLE
//   CASCADE entirely → the FK retarget is handled by the explicit
//   DROP CONSTRAINT (succeeds) + ADD CONSTRAINT →catalog_* (succeeds).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS design_visit_door_styles (
      id         SERIAL PRIMARY KEY,
      name       TEXT             NOT NULL,
      image_url  TEXT,
      sort_order INTEGER          NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ      NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS design_visit_furniture_ranges (
      id          SERIAL PRIMARY KEY,
      name        TEXT        NOT NULL,
      description TEXT,
      sort_order  INTEGER     NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS design_visit_handles (
      id          SERIAL PRIMARY KEY,
      name        TEXT        NOT NULL,
      description TEXT,
      image_url   TEXT,
      sort_order  INTEGER     NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      style       TEXT
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS design_visit_door_styles      CASCADE;
    DROP TABLE IF EXISTS design_visit_furniture_ranges CASCADE;
    DROP TABLE IF EXISTS design_visit_handles          CASCADE;
  `);
};
