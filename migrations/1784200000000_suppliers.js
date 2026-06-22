'use strict';
// Adds a suppliers table with seed data, and many-to-many join tables linking
// suppliers to catalog_handles and catalog_doors.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id              SERIAL PRIMARY KEY,
      name            TEXT        NOT NULL,
      description     TEXT,
      website_address TEXT,
      account_number  TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO suppliers (name, description, website_address, account_number) VALUES
      ('HPP',      'Supplier of vinyl and melaime products',     'https://www.hpponline.co.uk/',              'GADE24'),
      ('Integral', 'Supplier of vinyl and melaime products',     'https://www.integralsurfacedesigns.co.uk/', 'G099'),
      ('Interfit', 'Supplier of drawers, hinges and hardware',   'https://www.interfitco.com/',               NULL)
    ON CONFLICT DO NOTHING;

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

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS catalog_door_suppliers   CASCADE;
    DROP TABLE IF EXISTS catalog_handle_suppliers CASCADE;
    DROP TABLE IF EXISTS suppliers                CASCADE;
  `);
};
