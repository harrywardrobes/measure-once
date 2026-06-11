exports.up = pgm => {
  pgm.sql(`
    ALTER TABLE customer_info_submissions
      ADD COLUMN IF NOT EXISTS photo_upload_count INT NOT NULL DEFAULT 0;
  `);
};

exports.down = pgm => {
  pgm.sql(`
    ALTER TABLE customer_info_submissions
      DROP COLUMN IF EXISTS photo_upload_count;
  `);
};
