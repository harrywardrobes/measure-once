'use strict';
// Replaces the many-to-many supplier join tables with a simple supplier_id FK
// on catalog_handles and catalog_doors (one supplier per item).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS catalog_handle_suppliers CASCADE;
    DROP TABLE IF EXISTS catalog_door_suppliers   CASCADE;

    ALTER TABLE catalog_handles
      ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL;

    ALTER TABLE catalog_doors
      ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE catalog_doors   DROP COLUMN IF EXISTS supplier_id;
    ALTER TABLE catalog_handles DROP COLUMN IF EXISTS supplier_id;

    CREATE TABLE IF NOT EXISTS catalog_handle_suppliers (
      handle_id   INTEGER NOT NULL REFERENCES catalog_handles(id) ON DELETE CASCADE,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id)       ON DELETE CASCADE,
      PRIMARY KEY (handle_id, supplier_id)
    );

    CREATE TABLE IF NOT EXISTS catalog_door_suppliers (
      door_id     INTEGER NOT NULL REFERENCES catalog_doors(id) ON DELETE CASCADE,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id)     ON DELETE CASCADE,
      PRIMARY KEY (door_id, supplier_id)
    );
  `);
};
