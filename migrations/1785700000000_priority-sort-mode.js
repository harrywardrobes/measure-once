'use strict';

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO page_filter_config (key, value)
    VALUES ('customers_priority_sort_mode', 'last_contacted')
    ON CONFLICT (key) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM page_filter_config WHERE key = 'customers_priority_sort_mode';
  `);
};
