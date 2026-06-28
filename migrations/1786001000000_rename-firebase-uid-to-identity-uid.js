exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users RENAME COLUMN firebase_uid TO identity_uid;
    ALTER INDEX IF EXISTS users_firebase_uid_idx RENAME TO users_identity_uid_idx;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE users RENAME COLUMN identity_uid TO firebase_uid;
    ALTER INDEX IF EXISTS users_identity_uid_idx RENAME TO users_firebase_uid_idx;
  `);
};
