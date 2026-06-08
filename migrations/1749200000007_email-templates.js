'use strict';
// Baseline migration: email-templates schema.
// DDL copied verbatim from email-templates.js ensureEmailTemplatesTable().
// The default-content seed (driven by the JS TEMPLATE_DEFS constant) remains a
// boot data op so the template text is not duplicated here.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS email_templates (
      id          SERIAL PRIMARY KEY,
      key         TEXT UNIQUE NOT NULL,
      subject     TEXT NOT NULL DEFAULT '',
      body_text   TEXT NOT NULL DEFAULT '',
      body_html   TEXT NOT NULL DEFAULT '',
      footer_text TEXT NOT NULL DEFAULT '',
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by  TEXT
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS email_templates;`);
};
