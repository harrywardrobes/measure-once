'use strict';

exports.shorthands = undefined;

exports.up = pgm => {
  pgm.sql(`ALTER TABLE lead_status_config DROP COLUMN IF EXISTS shorthand`);
};

exports.down = pgm => {
  pgm.sql(`ALTER TABLE lead_status_config ADD COLUMN IF NOT EXISTS shorthand VARCHAR(4)`);
};
