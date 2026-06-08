'use strict';
// Baseline migration: design-visit schema.
// DDL copied verbatim from design-visits.js ensureDesignVisitTables(). The
// one-time terms-version seed (previously JS-guarded) is expressed here as an
// idempotent INSERT ... SELECT so existing databases retain the same behaviour.
// admin_settings is NOT created here (deduped into the auth baseline).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS terms_conditions_versions (
      id             SERIAL PRIMARY KEY,
      version_number INT NOT NULL,
      terms_text     TEXT NOT NULL,
      created_by     TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS tcv_version_number_idx ON terms_conditions_versions (version_number);
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS design_visit_handles (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      image_url   TEXT,
      sort_order  INT  NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE design_visit_handles ADD COLUMN IF NOT EXISTS style TEXT;
    CREATE TABLE IF NOT EXISTS design_visit_furniture_ranges (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      sort_order  INT  NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS design_visit_door_styles (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      image_url   TEXT,
      sort_order  INT  NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS design_visits (
      id                   SERIAL PRIMARY KEY,
      contact_id           TEXT NOT NULL,
      contact_name         TEXT,
      contact_email        TEXT,
      created_by           TEXT NOT NULL,
      handle_id            INT  REFERENCES design_visit_handles(id) ON DELETE SET NULL,
      furniture_range_id   INT  REFERENCES design_visit_furniture_ranges(id) ON DELETE SET NULL,
      visit_date           TIMESTAMPTZ,
      duration_min         INT  NOT NULL DEFAULT 90,
      location             TEXT,
      notes                TEXT,
      terms_accepted       BOOLEAN NOT NULL DEFAULT FALSE,
      status               TEXT NOT NULL DEFAULT 'draft',
      qb_estimate_id       TEXT,
      qb_estimate_doc_num  TEXT,
      signoff_token_hash   TEXT,
      signoff_expires_at   TIMESTAMPTZ,
      signed_off_at        TIMESTAMPTZ,
      revision_note        TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE design_visits ADD COLUMN IF NOT EXISTS qb_estimate_history JSONB NOT NULL DEFAULT '[]'::jsonb;
    CREATE INDEX IF NOT EXISTS design_visits_contact_id_idx ON design_visits (contact_id);
    CREATE INDEX IF NOT EXISTS design_visits_status_idx ON design_visits (status);
    ALTER TABLE design_visits
      ADD COLUMN IF NOT EXISTS superseded_signoff_token_hashes TEXT[]
        NOT NULL DEFAULT ARRAY[]::TEXT[];
    CREATE INDEX IF NOT EXISTS design_visits_superseded_token_hashes_idx
      ON design_visits USING GIN (superseded_signoff_token_hashes);
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS design_visit_rooms (
      id               SERIAL PRIMARY KEY,
      design_visit_id  INT NOT NULL REFERENCES design_visits(id) ON DELETE CASCADE,
      room_name        TEXT NOT NULL,
      door_style_id    INT REFERENCES design_visit_door_styles(id) ON DELETE SET NULL,
      width_mm         INT,
      height_mm        INT,
      depth_mm         INT,
      unit_count       INT NOT NULL DEFAULT 1,
      unit_price_pence INT NOT NULL DEFAULT 0,
      notes            TEXT,
      sort_order       INT NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS design_visit_rooms_visit_id_idx ON design_visit_rooms (design_visit_id);
    CREATE TABLE IF NOT EXISTS design_visit_room_images (
      id          SERIAL PRIMARY KEY,
      room_id     INT  NOT NULL REFERENCES design_visit_rooms(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL,
      mime_type   TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS dvri_room_id_idx ON design_visit_room_images (room_id);
    CREATE TABLE IF NOT EXISTS design_visit_pending_uploads (
      storage_key TEXT PRIMARY KEY,
      created_by  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE design_visits
      ADD COLUMN IF NOT EXISTS terms_condition_version_id INT
        REFERENCES terms_conditions_versions(id) ON DELETE SET NULL;
  `);

  // Seed: if versions table is empty but admin_settings has terms text, insert version 1.
  pgm.sql(`
    INSERT INTO terms_conditions_versions (version_number, terms_text, created_by)
    SELECT 1, (value->>'text'), 'system'
      FROM admin_settings
     WHERE key = 'design_visit_terms'
       AND TRIM(COALESCE(value->>'text', '')) <> ''
       AND NOT EXISTS (SELECT 1 FROM terms_conditions_versions)
    LIMIT 1;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS design_visit_pending_uploads;
    DROP TABLE IF EXISTS design_visit_room_images;
    DROP TABLE IF EXISTS design_visit_rooms;
    DROP TABLE IF EXISTS design_visits;
    DROP TABLE IF EXISTS design_visit_door_styles;
    DROP TABLE IF EXISTS design_visit_furniture_ranges;
    DROP TABLE IF EXISTS design_visit_handles;
    DROP TABLE IF EXISTS terms_conditions_versions;
  `);
};
