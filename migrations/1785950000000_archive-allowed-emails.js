exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE allowed_emails
      ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE allowed_emails DROP COLUMN IF EXISTS archived_at;
  `);
};
