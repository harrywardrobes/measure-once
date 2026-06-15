'use strict';
// Survey-visit schema (Task: Start Survey Visit wizard).
//
// Mirrors the design-visit schema (design_visits / design_visit_rooms /
// design_visit_room_images / design_visit_pending_uploads) under a parallel
// survey_* family. The Survey Visit is a continuation of the Design Visit, so:
//   - survey_visits.design_visit_id links back to the originating design visit.
//   - survey_visit_rooms.source_design_visit_room_id links each room to the
//     design-visit room it was pre-filled from (NULL for rooms added fresh).
//
// Catalogue + questionnaire data is shared, so this migration adds no new
// catalog_* or visit_questions tables — survey FKs point at the existing
// catalog_handles / catalog_ranges / catalog_doors tables, and answers are
// captured in visit_answers with visit_type = 'survey'.
//
// survey_visits and survey_visit_rooms are offline-syncable record tables, so
// they carry updated_at + version and the shared
// set_updated_at_and_bump_version() trigger (defined in the sync-readiness
// migration). All DDL is guarded (IF NOT EXISTS / DROP TRIGGER IF EXISTS) so
// the migration survives a full re-run against an arbitrary historical schema
// (Replit publish-time dev->prod diff replays migrations on boot).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS survey_visits (
      id                   SERIAL PRIMARY KEY,
      contact_id           TEXT NOT NULL,
      contact_name         TEXT,
      contact_email        TEXT,
      created_by           TEXT NOT NULL,
      design_visit_id      INT  REFERENCES design_visits(id) ON DELETE SET NULL,
      handle_id            INT  REFERENCES catalog_handles(id) ON DELETE SET NULL,
      furniture_range_id   INT  REFERENCES catalog_ranges(id) ON DELETE SET NULL,
      visit_date           TIMESTAMPTZ,
      duration_min         INT  NOT NULL DEFAULT 90,
      location             TEXT,
      structured_address   JSONB,
      notes                TEXT,
      terms_accepted       BOOLEAN NOT NULL DEFAULT FALSE,
      terms_condition_version_id INT REFERENCES terms_conditions_versions(id) ON DELETE SET NULL,
      status               TEXT NOT NULL DEFAULT 'draft',
      qb_estimate_id       TEXT,
      qb_estimate_doc_num  TEXT,
      qb_estimate_history  JSONB NOT NULL DEFAULT '[]'::jsonb,
      signoff_token_hash   TEXT,
      signoff_expires_at   TIMESTAMPTZ,
      signed_off_at        TIMESTAMPTZ,
      superseded_signoff_token_hashes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      revision_note        TEXT,
      refund_requested_at  TIMESTAMPTZ,
      refund_requested_by  TEXT,
      refund_reason        TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      version              INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS survey_visits_contact_id_idx ON survey_visits (contact_id);
    CREATE INDEX IF NOT EXISTS survey_visits_status_idx ON survey_visits (status);
    CREATE INDEX IF NOT EXISTS survey_visits_design_visit_id_idx ON survey_visits (design_visit_id);
    CREATE INDEX IF NOT EXISTS survey_visits_superseded_token_hashes_idx
      ON survey_visits USING GIN (superseded_signoff_token_hashes);
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS survey_visit_rooms (
      id                          SERIAL PRIMARY KEY,
      survey_visit_id             INT NOT NULL REFERENCES survey_visits(id) ON DELETE CASCADE,
      source_design_visit_room_id INT REFERENCES design_visit_rooms(id) ON DELETE SET NULL,
      room_name                   TEXT NOT NULL,
      door_style_id               INT REFERENCES catalog_doors(id) ON DELETE SET NULL,
      width_mm                    INT,
      height_mm                   INT,
      depth_mm                    INT,
      unit_count                  INT NOT NULL DEFAULT 1,
      unit_price_pence            INT NOT NULL DEFAULT 0,
      notes                       TEXT,
      sort_order                  INT NOT NULL DEFAULT 0,
      created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      version                     INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS survey_visit_rooms_visit_id_idx ON survey_visit_rooms (survey_visit_id);

    CREATE TABLE IF NOT EXISTS survey_visit_room_images (
      id          SERIAL PRIMARY KEY,
      room_id     INT  NOT NULL REFERENCES survey_visit_rooms(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL,
      mime_type   TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS svri_room_id_idx ON survey_visit_room_images (room_id);

    CREATE TABLE IF NOT EXISTS survey_visit_pending_uploads (
      storage_key TEXT PRIMARY KEY,
      created_by  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Attach the shared sync-metadata trigger (function defined in the
  // sync-readiness migration) to both syncable record tables.
  for (const table of ['survey_visits', 'survey_visit_rooms']) {
    pgm.sql(`
      DROP TRIGGER IF EXISTS trg_${table}_sync_meta ON ${table};
      CREATE TRIGGER trg_${table}_sync_meta
        BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION set_updated_at_and_bump_version();
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_survey_visit_rooms_sync_meta ON survey_visit_rooms;
    DROP TRIGGER IF EXISTS trg_survey_visits_sync_meta ON survey_visits;
    DROP TABLE IF EXISTS survey_visit_pending_uploads;
    DROP TABLE IF EXISTS survey_visit_room_images;
    DROP TABLE IF EXISTS survey_visit_rooms;
    DROP TABLE IF EXISTS survey_visits;
  `);
};
