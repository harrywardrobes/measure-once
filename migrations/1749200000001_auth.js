'use strict';
// Baseline migration: core auth/session/access-control schema.
// SQL copied verbatim from auth.js ensureAuthTables() so existing databases
// upgrade identically (every statement is idempotent / IF NOT EXISTS) and a
// fresh database is built to the same end state. admin_settings is created
// here ONLY (deduped from design-visits.js ensureAdminSettings()).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid VARCHAR PRIMARY KEY,
      sess JSONB NOT NULL,
      expire TIMESTAMP NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON sessions (expire);
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
      email VARCHAR UNIQUE,
      first_name VARCHAR,
      last_name VARCHAR,
      profile_image_url VARCHAR,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS allowed_emails (
      email VARCHAR PRIMARY KEY,
      approved_at TIMESTAMP DEFAULT NOW(),
      note VARCHAR
    );
    CREATE TABLE IF NOT EXISTS bootstrap_admin_emails (
      email VARCHAR PRIMARY KEY,
      seeded_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS account_requests (
      id SERIAL PRIMARY KEY,
      name VARCHAR NOT NULL,
      email VARCHAR NOT NULL,
      status VARCHAR NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS "IDX_account_requests_email" ON account_requests (email);
  `);

  // Dedup before creating the UNIQUE index (required on dirty existing DBs).
  pgm.sql(`
    DELETE FROM account_requests a
      USING account_requests b
      WHERE a.id > b.id AND a.email = b.email;
    CREATE UNIQUE INDEX IF NOT EXISTS "IDX_account_requests_email_unique" ON account_requests (email);
  `);

  pgm.sql(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS job_role TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS privilege_level TEXT NOT NULL DEFAULT 'member';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'active';
  `);

  pgm.sql(`
    UPDATE users SET onboarding_status = 'active'
     WHERE onboarding_status IS NULL OR onboarding_status NOT IN ('active','more_info_required');
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS password_set_tokens (
      token_hash TEXT PRIMARY KEY,
      email      VARCHAR NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used_at    TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS "IDX_password_set_tokens_email" ON password_set_tokens (email);
    CREATE INDEX IF NOT EXISTS "IDX_password_set_tokens_expire" ON password_set_tokens (expires_at);
    ALTER TABLE password_set_tokens ADD COLUMN IF NOT EXISTS purpose TEXT;
  `);

  pgm.sql(`ALTER TABLE allowed_emails ADD COLUMN IF NOT EXISTS metadata JSONB;`);
  pgm.sql(`ALTER TABLE allowed_emails ADD COLUMN IF NOT EXISTS pending_profile_updates JSONB;`);
  pgm.sql(`ALTER TABLE allowed_emails ADD COLUMN IF NOT EXISTS conflict_created_at TIMESTAMPTZ;`);

  pgm.sql(`
    UPDATE allowed_emails ae
       SET conflict_created_at = COALESCE(u.updated_at, u.created_at, NOW())
      FROM users u
     WHERE LOWER(u.email) = ae.email
       AND ae.pending_profile_updates IS NOT NULL
       AND ae.conflict_created_at IS NULL
  `);

  // admin_settings — created HERE only (deduped from design-visits.js).
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      key VARCHAR PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  pgm.sql(`
    DO $$
    BEGIN
      CREATE TABLE IF NOT EXISTS job_roles (
        job_id         SERIAL PRIMARY KEY,
        name           VARCHAR NOT NULL UNIQUE,
        privilege_level TEXT    NOT NULL DEFAULT 'member',
        created_at     TIMESTAMP DEFAULT NOW()
      );

      BEGIN
        ALTER TABLE job_roles ADD COLUMN job_id SERIAL;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END;

      BEGIN
        ALTER TABLE job_roles ADD COLUMN privilege_level TEXT NOT NULL DEFAULT 'member';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END;

      IF EXISTS (
        SELECT 1
        FROM   information_schema.key_column_usage kcu
        JOIN   information_schema.table_constraints tc
               ON  tc.constraint_name = kcu.constraint_name
               AND tc.table_name      = kcu.table_name
        WHERE  tc.table_name      = 'job_roles'
          AND  tc.constraint_type = 'PRIMARY KEY'
          AND  kcu.column_name    = 'name'
      ) THEN
        ALTER TABLE job_roles DROP CONSTRAINT job_roles_pkey;
        ALTER TABLE job_roles ADD  PRIMARY KEY (job_id);
        BEGIN
          ALTER TABLE job_roles ADD CONSTRAINT job_roles_name_key UNIQUE (name);
        EXCEPTION WHEN duplicate_table THEN NULL;
        END;
      END IF;

      INSERT INTO job_roles (name, privilege_level) VALUES
        ('Site Manager', 'manager'),
        ('Fitter',       'member'),
        ('Sales',        'member'),
        ('Admin',        'admin'),
        ('Office',       'manager')
      ON CONFLICT (name) DO NOTHING;

      UPDATE job_roles SET privilege_level = 'admin'   WHERE name = 'Admin'        AND privilege_level = 'member';
      UPDATE job_roles SET privilege_level = 'manager' WHERE name = 'Office'       AND privilege_level = 'member';
      UPDATE job_roles SET privilege_level = 'manager' WHERE name = 'Site Manager' AND privilege_level = 'member';
    END$$;
  `);

  pgm.sql(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_photo  TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_photo   TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_version  TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS prefs JSONB NOT NULL DEFAULT '{}';
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id SERIAL PRIMARY KEY,
      acted_at TIMESTAMP DEFAULT NOW(),
      admin_email VARCHAR NOT NULL,
      action_type VARCHAR NOT NULL,
      target_email VARCHAR,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS "IDX_admin_audit_log_acted_at" ON admin_audit_log (acted_at DESC);
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      permission_key  VARCHAR NOT NULL,
      privilege_level VARCHAR NOT NULL,
      allowed         BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (permission_key, privilege_level)
    );
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS nav_role_configs (
      role_name    TEXT PRIMARY KEY,
      primary_keys JSONB NOT NULL DEFAULT '["home","customers","projects"]',
      updated_at   TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE nav_role_configs ADD COLUMN IF NOT EXISTS is_customized BOOLEAN NOT NULL DEFAULT FALSE;
    INSERT INTO nav_role_configs (role_name, primary_keys) VALUES
      ('__default__',  '["home","customers","projects"]'),
      ('Fitter',       '["home","customers","projects"]'),
      ('Site Manager', '["home","sales","projects"]'),
      ('Sales',        '["home","customers","projects"]'),
      ('Admin',        '["home","sales","projects"]'),
      ('Office',       '["home","sales","projects"]')
    ON CONFLICT (role_name) DO NOTHING;
    UPDATE nav_role_configs
      SET primary_keys = (
        SELECT jsonb_agg(
          CASE WHEN elem = '"calendar"'::jsonb THEN '"projects"'::jsonb ELSE elem END
          ORDER BY ord
        )
        FROM jsonb_array_elements(primary_keys) WITH ORDINALITY AS arr(elem, ord)
      )
    WHERE primary_keys @> '"calendar"';
    UPDATE nav_role_configs
      SET primary_keys = '["home","customers","projects"]'
    WHERE role_name = '__default__'
      AND primary_keys @> '"trades"';
    UPDATE nav_role_configs
      SET is_customized = TRUE
    WHERE is_customized = FALSE
      AND role_name != '__default__'
      AND primary_keys != '["home","customers","projects"]'::jsonb;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS nav_role_configs;
    DROP TABLE IF EXISTS role_permissions;
    DROP TABLE IF EXISTS admin_audit_log;
    DROP TABLE IF EXISTS job_roles;
    DROP TABLE IF EXISTS admin_settings;
    DROP TABLE IF EXISTS password_set_tokens;
    DROP TABLE IF EXISTS account_requests;
    DROP TABLE IF EXISTS bootstrap_admin_emails;
    DROP TABLE IF EXISTS allowed_emails;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS sessions;
  `);
};
