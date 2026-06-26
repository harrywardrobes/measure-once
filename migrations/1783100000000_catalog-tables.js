'use strict';
// Visits foundation — shared catalogue tables (Task: Visits foundation 1a).
//
// Replaces the Design-Visit-specific catalogue tables with shared `catalog_*`
// tables that both the Design Visit and a future Survey Visit can build on:
//   design_visit_handles         -> catalog_handles
//   design_visit_door_styles     -> catalog_doors
//   design_visit_furniture_ranges-> catalog_ranges
// Two brand-new tables are added: catalog_finishes and catalog_pairings.
//
// Row IDs, sort orders and image URLs are preserved on copy so existing FK
// references on design_visits (handle_id, furniture_range_id) and
// design_visit_rooms (door_style_id) stay valid; the FKs are then repointed to
// the new tables and the old tables dropped.
//
// All steps are guarded (to_regclass / pg_constraint checks / IF [NOT] EXISTS)
// so the migration survives a full re-run against an arbitrary historical
// schema (the prior deploy pipeline's dev→prod diff replays migrations on boot).

exports.shorthands = undefined;

// Shared extra columns added to every catalogue table.
const EXTRA_COLS = `
  supplier_name TEXT,
  supplier_code TEXT,
  price_pence   INTEGER,
  notes         TEXT,
  colour        TEXT,
  finish        TEXT,
  material_type TEXT
`;

exports.up = (pgm) => {
  // 1. Create the new catalogue tables. ---------------------------------------
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS catalog_handles (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      image_url   TEXT,
      style       TEXT,
      sort_order  INT  NOT NULL DEFAULT 0,
      ${EXTRA_COLS},
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS catalog_doors (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      image_url   TEXT,
      sort_order  INT  NOT NULL DEFAULT 0,
      ${EXTRA_COLS},
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS catalog_finishes (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      image_url   TEXT,
      sort_order  INT  NOT NULL DEFAULT 0,
      ${EXTRA_COLS},
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS catalog_ranges (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      image_url   TEXT,
      sort_order  INT  NOT NULL DEFAULT 0,
      ${EXTRA_COLS},
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS catalog_pairings (
      id         SERIAL PRIMARY KEY,
      door_id    INT NOT NULL REFERENCES catalog_doors(id) ON DELETE CASCADE,
      handle_id  INT REFERENCES catalog_handles(id) ON DELETE CASCADE,
      finish_id  INT REFERENCES catalog_finishes(id) ON DELETE CASCADE,
      sort_order INT NOT NULL DEFAULT 0,
      notes      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS catalog_pairings_door_id_idx ON catalog_pairings (door_id);
  `);

  // 2. Copy legacy rows (preserving IDs / sort orders / image URLs) and reset
  //    each sequence to MAX(id). Guarded so re-runs after the old tables are
  //    gone are no-ops.
  pgm.sql(`
    DO $$
    BEGIN
      IF to_regclass('public.design_visit_handles') IS NOT NULL THEN
        INSERT INTO catalog_handles (id, name, description, image_url, style, sort_order, created_at, updated_at)
          SELECT id, name, description, image_url, style, sort_order, created_at, updated_at
            FROM design_visit_handles
          ON CONFLICT (id) DO NOTHING;
        PERFORM setval(
          pg_get_serial_sequence('catalog_handles','id'),
          COALESCE((SELECT MAX(id) FROM catalog_handles), 1),
          (SELECT MAX(id) IS NOT NULL FROM catalog_handles)
        );
      END IF;

      IF to_regclass('public.design_visit_door_styles') IS NOT NULL THEN
        INSERT INTO catalog_doors (id, name, image_url, sort_order, created_at, updated_at)
          SELECT id, name, image_url, sort_order, created_at, updated_at
            FROM design_visit_door_styles
          ON CONFLICT (id) DO NOTHING;
        PERFORM setval(
          pg_get_serial_sequence('catalog_doors','id'),
          COALESCE((SELECT MAX(id) FROM catalog_doors), 1),
          (SELECT MAX(id) IS NOT NULL FROM catalog_doors)
        );
      END IF;

      IF to_regclass('public.design_visit_furniture_ranges') IS NOT NULL THEN
        INSERT INTO catalog_ranges (id, name, description, sort_order, created_at, updated_at)
          SELECT id, name, description, sort_order, created_at, updated_at
            FROM design_visit_furniture_ranges
          ON CONFLICT (id) DO NOTHING;
        PERFORM setval(
          pg_get_serial_sequence('catalog_ranges','id'),
          COALESCE((SELECT MAX(id) FROM catalog_ranges), 1),
          (SELECT MAX(id) IS NOT NULL FROM catalog_ranges)
        );
      END IF;
    END $$;
  `);

  // 3. Repoint FKs on design_visits / design_visit_rooms to the new tables.
  //    Drop the old constraints (whatever they are named), drop the old tables,
  //    then add fresh constraints referencing the catalog_* tables.
  pgm.sql(`
    ALTER TABLE design_visits      DROP CONSTRAINT IF EXISTS design_visits_handle_id_fkey;
    ALTER TABLE design_visits      DROP CONSTRAINT IF EXISTS design_visits_furniture_range_id_fkey;
    ALTER TABLE design_visit_rooms DROP CONSTRAINT IF EXISTS design_visit_rooms_door_style_id_fkey;

    DROP TABLE IF EXISTS design_visit_handles          CASCADE;
    DROP TABLE IF EXISTS design_visit_door_styles      CASCADE;
    DROP TABLE IF EXISTS design_visit_furniture_ranges CASCADE;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'design_visits_handle_id_fkey') THEN
        ALTER TABLE design_visits
          ADD CONSTRAINT design_visits_handle_id_fkey
          FOREIGN KEY (handle_id) REFERENCES catalog_handles(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'design_visits_furniture_range_id_fkey') THEN
        ALTER TABLE design_visits
          ADD CONSTRAINT design_visits_furniture_range_id_fkey
          FOREIGN KEY (furniture_range_id) REFERENCES catalog_ranges(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'design_visit_rooms_door_style_id_fkey') THEN
        ALTER TABLE design_visit_rooms
          ADD CONSTRAINT design_visit_rooms_door_style_id_fkey
          FOREIGN KEY (door_style_id) REFERENCES catalog_doors(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  // Recreate the legacy tables, copy the original columns back (preserving IDs),
  // repoint FKs to them, then drop the new catalogue tables.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS design_visit_handles (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      image_url   TEXT,
      sort_order  INT  NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE design_visit_handles ADD COLUMN IF NOT EXISTS style TEXT;
    CREATE TABLE IF NOT EXISTS design_visit_furniture_ranges (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      sort_order  INT  NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS design_visit_door_styles (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      image_url   TEXT,
      sort_order  INT  NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF to_regclass('public.catalog_handles') IS NOT NULL THEN
        INSERT INTO design_visit_handles (id, name, description, image_url, style, sort_order, created_at, updated_at)
          SELECT id, name, description, image_url, style, sort_order, created_at, updated_at
            FROM catalog_handles
          ON CONFLICT (id) DO NOTHING;
        PERFORM setval(
          pg_get_serial_sequence('design_visit_handles','id'),
          COALESCE((SELECT MAX(id) FROM design_visit_handles), 1),
          (SELECT MAX(id) IS NOT NULL FROM design_visit_handles)
        );
      END IF;
      IF to_regclass('public.catalog_doors') IS NOT NULL THEN
        INSERT INTO design_visit_door_styles (id, name, image_url, sort_order, created_at, updated_at)
          SELECT id, name, image_url, sort_order, created_at, updated_at
            FROM catalog_doors
          ON CONFLICT (id) DO NOTHING;
        PERFORM setval(
          pg_get_serial_sequence('design_visit_door_styles','id'),
          COALESCE((SELECT MAX(id) FROM design_visit_door_styles), 1),
          (SELECT MAX(id) IS NOT NULL FROM design_visit_door_styles)
        );
      END IF;
      IF to_regclass('public.catalog_ranges') IS NOT NULL THEN
        INSERT INTO design_visit_furniture_ranges (id, name, description, sort_order, created_at, updated_at)
          SELECT id, name, description, sort_order, created_at, updated_at
            FROM catalog_ranges
          ON CONFLICT (id) DO NOTHING;
        PERFORM setval(
          pg_get_serial_sequence('design_visit_furniture_ranges','id'),
          COALESCE((SELECT MAX(id) FROM design_visit_furniture_ranges), 1),
          (SELECT MAX(id) IS NOT NULL FROM design_visit_furniture_ranges)
        );
      END IF;
    END $$;
  `);

  pgm.sql(`
    ALTER TABLE design_visits      DROP CONSTRAINT IF EXISTS design_visits_handle_id_fkey;
    ALTER TABLE design_visits      DROP CONSTRAINT IF EXISTS design_visits_furniture_range_id_fkey;
    ALTER TABLE design_visit_rooms DROP CONSTRAINT IF EXISTS design_visit_rooms_door_style_id_fkey;

    DROP TABLE IF EXISTS catalog_pairings CASCADE;
    DROP TABLE IF EXISTS catalog_finishes CASCADE;
    DROP TABLE IF EXISTS catalog_handles  CASCADE;
    DROP TABLE IF EXISTS catalog_doors    CASCADE;
    DROP TABLE IF EXISTS catalog_ranges   CASCADE;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'design_visits_handle_id_fkey') THEN
        ALTER TABLE design_visits
          ADD CONSTRAINT design_visits_handle_id_fkey
          FOREIGN KEY (handle_id) REFERENCES design_visit_handles(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'design_visits_furniture_range_id_fkey') THEN
        ALTER TABLE design_visits
          ADD CONSTRAINT design_visits_furniture_range_id_fkey
          FOREIGN KEY (furniture_range_id) REFERENCES design_visit_furniture_ranges(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'design_visit_rooms_door_style_id_fkey') THEN
        ALTER TABLE design_visit_rooms
          ADD CONSTRAINT design_visit_rooms_door_style_id_fkey
          FOREIGN KEY (door_style_id) REFERENCES design_visit_door_styles(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);
};
