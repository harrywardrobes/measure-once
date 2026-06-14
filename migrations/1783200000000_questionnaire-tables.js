'use strict';
// Questionnaire engine (Visits foundation, Task 1b).
//
// Adds a generic question/answer model shared by every visit type (Design Visit
// now, Survey Visit later):
//   - `visit_questions`  — the admin-curated question catalogue.
//   - `visit_answers`    — captured answers, keyed by visit type + id (+ room).
//
// Reference/config data, so these tables are intentionally NOT part of the
// offline SYNC_TABLES set (no `version` column / sync trigger). `updated_at` on
// `visit_questions` is stamped by the admin routes on edit.
//
// All DDL is guarded (IF NOT EXISTS) and the starter-question seed only runs
// when the table is empty, so the migration survives a full re-run against an
// arbitrary historical schema (see boot-migrations-vs-publish-flow memory).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS visit_questions (
      id          SERIAL PRIMARY KEY,
      scope       TEXT NOT NULL DEFAULT 'visit' CHECK (scope IN ('room', 'visit')),
      applies_to  TEXT[] NOT NULL DEFAULT '{}',
      label       TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('yesno', 'choice', 'text', 'number')),
      options     JSONB NOT NULL DEFAULT '[]'::jsonb,
      required    BOOLEAN NOT NULL DEFAULT FALSE,
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_visit_questions_scope_active
      ON visit_questions (scope, active, sort_order);
    CREATE INDEX IF NOT EXISTS idx_visit_questions_applies_to
      ON visit_questions USING GIN (applies_to);
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS visit_answers (
      id          SERIAL PRIMARY KEY,
      visit_type  TEXT NOT NULL,
      visit_id    INTEGER NOT NULL,
      room_id     INTEGER,
      question_id INTEGER NOT NULL REFERENCES visit_questions(id) ON DELETE CASCADE,
      answer      JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_visit_answers_visit
      ON visit_answers (visit_type, visit_id);
    CREATE INDEX IF NOT EXISTS idx_visit_answers_question
      ON visit_answers (question_id);
  `);

  // Seed a handful of starter questions for the Design Visit, but only when the
  // table is empty so re-runs never duplicate them. All are editable/deletable.
  pgm.sql(`
    INSERT INTO visit_questions (scope, applies_to, label, type, options, required, sort_order)
    SELECT * FROM (VALUES
      ('visit'::text, ARRAY['design']::text[], 'Any appliances to keep?',                      'text'::text,   '[]'::jsonb,                                                                false, 10),
      ('visit'::text, ARRAY['design']::text[], 'Preferred installation timeframe?',            'text'::text,   '[]'::jsonb,                                                                false, 20),
      ('room'::text,  ARRAY['design']::text[], 'Does the room have an existing worktop?',      'yesno'::text,  '[]'::jsonb,                                                                false, 10),
      ('room'::text,  ARRAY['design']::text[], 'Worktop material preference?',                 'choice'::text, '["Laminate","Quartz","Granite","Solid wood","Other"]'::jsonb,              false, 20),
      ('room'::text,  ARRAY['design']::text[], 'Any plumbing or electrical changes needed?',   'text'::text,   '[]'::jsonb,                                                                false, 30)
    ) AS seed(scope, applies_to, label, type, options, required, sort_order)
    WHERE NOT EXISTS (SELECT 1 FROM visit_questions);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS visit_answers;`);
  pgm.sql(`DROP TABLE IF EXISTS visit_questions;`);
};
