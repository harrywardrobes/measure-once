'use strict';

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE design_visits ADD COLUMN IF NOT EXISTS visit_notes TEXT`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE design_visits DROP COLUMN IF EXISTS visit_notes`);
};
