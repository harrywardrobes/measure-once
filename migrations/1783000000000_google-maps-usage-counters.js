'use strict';

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS google_maps_usage (
      period  TEXT   NOT NULL,
      api     TEXT   NOT NULL,
      count   BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (period, api)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS google_maps_usage;');
};
