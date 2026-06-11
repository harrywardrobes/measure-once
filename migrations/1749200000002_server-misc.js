'use strict';
// Baseline migration: miscellaneous schema owned by server.js.
// DDL copied verbatim from the ensureXTable() functions in server.js
// (trades, ideas, lead status config, substatus clear failures, stage action
// labels, lead substatuses, app/search/workshop settings, page filter config,
// WhatsApp messages, card action handlers). Table-creation order is arranged so
// foreign keys resolve on a fresh database; every statement is idempotent.
//
// Data seeds that read JS constants (lead_status stage backfill, workshop and
// page-filter defaults) remain as boot-time data ops. Hardcoded sentinel/default
// rows are inlined here.

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ── Trades ────────────────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS trade_contacts (
      id             SERIAL PRIMARY KEY,
      name           VARCHAR NOT NULL,
      trade_type     VARCHAR NOT NULL,
      phone          VARCHAR,
      email          VARCHAR,
      areas_served   TEXT,
      company_name   VARCHAR,
      timescale      VARCHAR,
      invoice_method VARCHAR,
      payment_terms  VARCHAR,
      notes          TEXT,
      created_by     VARCHAR,
      created_at     TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS trade_companies (
      id             SERIAL PRIMARY KEY,
      company_name   VARCHAR NOT NULL,
      trade_type     VARCHAR NOT NULL,
      areas_served   TEXT,
      timescale      VARCHAR,
      invoice_method VARCHAR,
      payment_terms  VARCHAR,
      notes          TEXT,
      created_by     VARCHAR,
      created_at     TIMESTAMP DEFAULT NOW(),
      legacy_id      INTEGER
    );
    CREATE TABLE IF NOT EXISTS trade_company_contacts (
      id         SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES trade_companies(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      name       VARCHAR NOT NULL,
      role       VARCHAR,
      phone      VARCHAR,
      email      VARCHAR
    );
    CREATE TABLE IF NOT EXISTS trade_company_submissions (
      id               SERIAL PRIMARY KEY,
      company_name     VARCHAR NOT NULL,
      trade_type       VARCHAR NOT NULL,
      areas_served     TEXT,
      timescale        VARCHAR,
      invoice_method   VARCHAR,
      payment_terms    VARCHAR,
      notes            TEXT,
      contacts         JSONB NOT NULL DEFAULT '[]',
      submitter_id     VARCHAR,
      submitter_email  VARCHAR,
      submitter_name   VARCHAR,
      status           VARCHAR NOT NULL DEFAULT 'pending',
      reviewer_id      VARCHAR,
      reviewer_email   VARCHAR,
      reviewer_name    VARCHAR,
      rejection_reason TEXT,
      created_at       TIMESTAMP DEFAULT NOW(),
      reviewed_at      TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS trade_audit_log (
      id         SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES trade_companies(id) ON DELETE CASCADE,
      actor_id   VARCHAR,
      actor_name VARCHAR,
      action     VARCHAR NOT NULL,
      changed_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE trade_companies ADD COLUMN IF NOT EXISTS updated_by VARCHAR;
    ALTER TABLE trade_companies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;
    ALTER TABLE trade_companies ADD COLUMN IF NOT EXISTS created_by_name VARCHAR;
    ALTER TABLE trade_companies ADD COLUMN IF NOT EXISTS updated_by_name VARCHAR;
    ALTER TABLE trade_companies ADD COLUMN IF NOT EXISTS timescale_updated_at TIMESTAMP;
    ALTER TABLE trade_companies ADD COLUMN IF NOT EXISTS website VARCHAR;
    ALTER TABLE trade_companies ADD COLUMN IF NOT EXISTS company_phone VARCHAR;
    ALTER TABLE trade_company_contacts ADD COLUMN IF NOT EXISTS preferred_contact VARCHAR;
    ALTER TABLE trade_company_submissions ADD COLUMN IF NOT EXISTS website VARCHAR;
    ALTER TABLE trade_company_submissions ADD COLUMN IF NOT EXISTS company_phone VARCHAR;
  `);

  // ── Ideas ─────────────────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS ideas (
      id             SERIAL PRIMARY KEY,
      author_user_id VARCHAR NOT NULL,
      body           TEXT NOT NULL,
      created_at     TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS idea_comments (
      id             SERIAL PRIMARY KEY,
      idea_id        INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      author_user_id VARCHAR NOT NULL,
      body           TEXT NOT NULL,
      created_at     TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE ideas ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;
    ALTER TABLE idea_comments ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;
    CREATE TABLE IF NOT EXISTS idea_votes (
      idea_id  INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      user_id  VARCHAR NOT NULL,
      CONSTRAINT idea_votes_pk PRIMARY KEY (idea_id, user_id)
    );
  `);

  // ── Lead status config ──────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS lead_status_config (
      key                 TEXT PRIMARY KEY,
      label               TEXT NOT NULL,
      sort_order          INT  NOT NULL DEFAULT 0,
      excluded_from_sales BOOLEAN NOT NULL DEFAULT FALSE
    );
    ALTER TABLE lead_status_config ADD COLUMN IF NOT EXISTS stage VARCHAR(32);
    ALTER TABLE lead_status_config ADD COLUMN IF NOT EXISTS is_null_row BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE lead_status_config ADD COLUMN IF NOT EXISTS shorthand CHAR(4);
    CREATE UNIQUE INDEX IF NOT EXISTS lead_status_config_shorthand_uniq
      ON lead_status_config(shorthand) WHERE shorthand IS NOT NULL;
    INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, is_null_row)
    VALUES ('__NULL__', 'No status', -1, FALSE, TRUE)
    ON CONFLICT (key) DO NOTHING;
  `);

  // ── Substatus clear failures ────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS substatus_clear_failures (
      id            SERIAL PRIMARY KEY,
      failed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_key   TEXT NOT NULL,
      failure_type  TEXT NOT NULL,
      contact_id    TEXT,
      error_message TEXT,
      resolved      BOOLEAN NOT NULL DEFAULT FALSE,
      resolved_at   TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS substatus_clear_failures_deleted_key_idx
      ON substatus_clear_failures (deleted_key, resolved);
  `);

  // ── Stage action labels ─────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS stage_action_labels (
      stage_key   TEXT NOT NULL,
      status_key  TEXT NOT NULL,
      label       TEXT NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (stage_key, status_key)
    );
  `);

  // ── Lead substatuses (FK -> lead_status_config) ─────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS lead_substatuses (
      id            SERIAL PRIMARY KEY,
      status_key    TEXT NOT NULL,
      substatus_key TEXT NOT NULL,
      label         TEXT NOT NULL,
      action_label  TEXT NOT NULL DEFAULT '',
      sort_order    INT  NOT NULL DEFAULT 0,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (status_key, substatus_key)
    );
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'lead_substatuses_status_key_fk'
      ) THEN
        DELETE FROM lead_substatuses s
          WHERE NOT EXISTS (
            SELECT 1 FROM lead_status_config c WHERE c.key = s.status_key
          );
        ALTER TABLE lead_substatuses
          ADD CONSTRAINT lead_substatuses_status_key_fk
          FOREIGN KEY (status_key) REFERENCES lead_status_config(key);
      END IF;
    END$$;
    ALTER TABLE lead_substatuses
      ADD COLUMN IF NOT EXISTS default_handler_type TEXT NOT NULL DEFAULT '';
  `);

  // ── App / search / workshop / page-filter settings ──────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO app_settings (key, value) VALUES ('dev_mode_enabled', 'false')
      ON CONFLICT (key) DO NOTHING;
    CREATE TABLE IF NOT EXISTS search_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      disabled_actions JSONB NOT NULL DEFAULT '[]',
      hint_placeholder TEXT NOT NULL DEFAULT '',
      action_order JSONB NOT NULL DEFAULT '[]'
    );
    INSERT INTO search_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS workshop_settings (
      key        TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMP DEFAULT NOW(),
      updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS page_filter_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // ── WhatsApp messages (FK -> users) ─────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id              SERIAL PRIMARY KEY,
      contact_id      TEXT        NOT NULL,
      sender_user_id  VARCHAR     NOT NULL REFERENCES users(id),
      mode            TEXT        NOT NULL CHECK (mode IN ('template','freeform')),
      template_name   TEXT,
      template_params TEXT,
      message_text    TEXT,
      sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS template_params TEXT;
    CREATE INDEX IF NOT EXISTS whatsapp_messages_contact_idx ON whatsapp_messages(contact_id, sent_at DESC);
  `);

  // ── Card action handlers (FK -> lead_substatuses) ───────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS card_action_handlers (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      config      JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS card_action_handler_bindings (
      id            SERIAL PRIMARY KEY,
      handler_id    INT  NOT NULL REFERENCES card_action_handlers(id) ON DELETE CASCADE,
      stage_key     TEXT,
      status_key    TEXT,
      substatus_id  INT  REFERENCES lead_substatuses(id) ON DELETE CASCADE,
      CHECK (
        (stage_key IS NOT NULL AND substatus_id IS NULL) OR
        (stage_key IS NULL AND substatus_id IS NOT NULL)
      )
    );
    -- These two indexes reference substatus_id. On a fresh DB the column was
    -- just created above so they apply normally. If this migration is re-run
    -- against a schema where a later migration (1749200000019_remove-substatuses)
    -- or an external schema sync has already dropped substatus_id, skip them —
    -- Postgres cascades these indexes away with the column, and the slot-unique
    -- index added by a later migration takes their place.
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'card_action_handler_bindings'
          AND column_name = 'substatus_id'
      ) THEN
        CREATE UNIQUE INDEX IF NOT EXISTS cahb_label_uniq
          ON card_action_handler_bindings (stage_key, status_key)
          WHERE substatus_id IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS cahb_substatus_uniq
          ON card_action_handler_bindings (substatus_id)
          WHERE substatus_id IS NOT NULL;
      END IF;
    END $$;
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_type = 'FOREIGN KEY'
          AND table_name = 'card_action_handler_bindings'
          AND constraint_name = 'cahb_status_key_fk'
      ) THEN
        ALTER TABLE card_action_handler_bindings DROP CONSTRAINT cahb_status_key_fk;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS card_action_handler_bindings;
    DROP TABLE IF EXISTS card_action_handlers;
    DROP TABLE IF EXISTS whatsapp_messages;
    DROP TABLE IF EXISTS page_filter_config;
    DROP TABLE IF EXISTS workshop_settings;
    DROP TABLE IF EXISTS search_settings;
    DROP TABLE IF EXISTS app_settings;
    DROP TABLE IF EXISTS lead_substatuses;
    DROP TABLE IF EXISTS stage_action_labels;
    DROP TABLE IF EXISTS substatus_clear_failures;
    DROP TABLE IF EXISTS lead_status_config;
    DROP TABLE IF EXISTS idea_votes;
    DROP TABLE IF EXISTS idea_comments;
    DROP TABLE IF EXISTS ideas;
    DROP TABLE IF EXISTS trade_audit_log;
    DROP TABLE IF EXISTS trade_company_submissions;
    DROP TABLE IF EXISTS trade_company_contacts;
    DROP TABLE IF EXISTS trade_companies;
    DROP TABLE IF EXISTS trade_contacts;
  `);
};
