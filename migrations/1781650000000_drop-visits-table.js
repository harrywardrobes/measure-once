/**
 * Drop the `visits` table — all visit creation has been migrated to Google
 * Calendar (POST /api/events).  The PATCH/DELETE/GET routes that served this
 * table have already been retired from visits.js.
 */
exports.up = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS visits');
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS visits (
      id              SERIAL PRIMARY KEY,
      created_by      VARCHAR NOT NULL,
      customer_id     VARCHAR,
      customer_name   VARCHAR,
      type            VARCHAR NOT NULL,
      title           VARCHAR,
      start_at        TIMESTAMPTZ NOT NULL,
      end_at          TIMESTAMPTZ NOT NULL,
      is_workshop     BOOLEAN NOT NULL DEFAULT FALSE,
      notes           TEXT,
      location        VARCHAR,
      assignee_id     VARCHAR,
      assignee_role   VARCHAR,
      google_event_id VARCHAR,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      version         INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS visits_start_at_idx ON visits (start_at);
    DROP TRIGGER IF EXISTS trg_visits_sync_meta ON visits;
    CREATE TRIGGER trg_visits_sync_meta
      BEFORE UPDATE ON visits
      FOR EACH ROW EXECUTE FUNCTION set_updated_at_and_bump_version();
  `);
};
