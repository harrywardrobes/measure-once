'use strict';

// Removes the legacy "Priority first" sort-mode setting. The Customers list
// now has a single priority ordering (no-status first, then by last-contacted
// ascending), so the configurable mode toggle has been retired.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    DELETE FROM page_filter_config WHERE key = 'customers_priority_sort_mode';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    INSERT INTO page_filter_config (key, value)
    VALUES ('customers_priority_sort_mode', 'last_contacted')
    ON CONFLICT (key) DO NOTHING;
  `);
};
