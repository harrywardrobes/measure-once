exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS firebase_uid VARCHAR(128);

    CREATE UNIQUE INDEX IF NOT EXISTS users_firebase_uid_idx
      ON users (firebase_uid)
      WHERE firebase_uid IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS users_firebase_uid_idx;
    ALTER TABLE users DROP COLUMN IF EXISTS firebase_uid;
  `);
};
