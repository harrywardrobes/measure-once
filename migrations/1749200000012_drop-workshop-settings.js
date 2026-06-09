exports.up = pgm => {
  pgm.sql('DROP TABLE IF EXISTS workshop_settings');
};

exports.down = pgm => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS workshop_settings (
      key        TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ,
      updated_by TEXT
    )
  `);
};
