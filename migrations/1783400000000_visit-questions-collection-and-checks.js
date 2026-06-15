'use strict';
// Visit-questions: required_on column, survey extension, and full question seed.
//
// 1. Adds `required_on TEXT[] NOT NULL DEFAULT '{}'` to visit_questions so a
//    question can be mandatory on one visit type but optional on another.
// 2. Backfills required_on for any previously required=TRUE questions.
// 3. Extends all existing design-only questions to also apply to survey visits.
// 4. Seeds four groups of questions:
//      A — Collection selection (visit-scoped + room-scoped)
//      B — Generic per-room spec fields (room-scoped, both visit types)
//      C — Generic survey library (visit-scoped and room-scoped, survey only)
//      D — Document checks (room-scoped; some required on survey, some optional)
//
// All DDL is guarded (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS). Seed inserts
// are idempotent per (label, scope) so re-running the migration is a no-op.
// No company, brand, product, or customer names appear in labels.

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ── Step 1: add column and backfill ──────────────────────────────────────
  pgm.sql(`
    ALTER TABLE visit_questions
      ADD COLUMN IF NOT EXISTS required_on TEXT[] NOT NULL DEFAULT '{}';

    -- Backfill: existing required=TRUE rows get required_on = applies_to.
    UPDATE visit_questions
       SET required_on = applies_to
     WHERE required = TRUE
       AND required_on = '{}';
  `);

  // ── Step 2: extend existing design-only questions to also cover survey ────
  pgm.sql(`
    UPDATE visit_questions
       SET applies_to = array_append(applies_to, 'survey'),
           updated_at = NOW()
     WHERE 'design' = ANY(applies_to)
       AND NOT ('survey' = ANY(applies_to));
  `);

  // ── Step 3: seed group A — Collection questions ───────────────────────────
  // Whole-visit collection selection (required on both visit types).
  pgm.sql(`
    INSERT INTO visit_questions
      (scope, applies_to, label, type, options, required, required_on, sort_order)
    SELECT v.scope, v.applies_to::text[], v.label, v.type, v.options::jsonb,
           v.required, v.required_on::text[], v.sort_order
    FROM (VALUES
      ('visit', '{design,survey}', 'Which collection is being chosen for this visit?',
       'choice', '[]', false, '{design,survey}', 100),
      ('room',  '{design,survey}', 'Collection for this room (if different from the visit selection)',
       'choice', '[]', false, '{}', 110)
    ) AS v(scope, applies_to, label, type, options, required, required_on, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM visit_questions vq
       WHERE vq.label = v.label AND vq.scope = v.scope
    );
  `);

  // ── Step 4: seed group B — Generic per-room spec fields ──────────────────
  pgm.sql(`
    INSERT INTO visit_questions
      (scope, applies_to, label, type, options, required, required_on, sort_order)
    SELECT v.scope, v.applies_to::text[], v.label, v.type, v.options::jsonb,
           v.required, v.required_on::text[], v.sort_order
    FROM (VALUES
      ('room', '{design,survey}', 'Range / collection name',        'text', '[]', false, '{}', 200),
      ('room', '{design,survey}', 'Door and drawer colour',          'text', '[]', false, '{}', 210),
      ('room', '{design,survey}', 'Exterior panel and trim colour',  'text', '[]', false, '{}', 220),
      ('room', '{design,survey}', 'Interior colour',                 'text', '[]', false, '{}', 230),
      ('room', '{design,survey}', 'Worktop colour',                  'text', '[]', false, '{}', 240),
      ('room', '{design,survey}', 'Handle choice',                   'text', '[]', false, '{}', 250)
    ) AS v(scope, applies_to, label, type, options, required, required_on, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM visit_questions vq
       WHERE vq.label = v.label AND vq.scope = v.scope
    );
  `);

  // ── Step 5: seed group C — Generic survey library (visit-scoped) ──────────
  pgm.sql(`
    INSERT INTO visit_questions
      (scope, applies_to, label, type, options, required, required_on, sort_order)
    SELECT v.scope, v.applies_to::text[], v.label, v.type, v.options::jsonb,
           v.required, v.required_on::text[], v.sort_order
    FROM (VALUES
      ('visit', '{survey}', 'Property type',
       'choice', '["Detached","Semi-detached","Terraced","End of terrace","Flat","Bungalow","Other"]',
       false, '{}', 10),
      ('visit', '{survey}', 'Approximate property age',
       'choice', '["Pre-1900","1900–1945","1945–1970","1970–1990","1990–2010","Post-2010","Unknown"]',
       false, '{}', 20),
      ('visit', '{survey}', 'Floor the room is on',
       'choice', '["Basement","Ground","First","Second","Third or above"]',
       false, '{}', 30),
      ('visit', '{survey}', 'Step-free access to the property?',
       'yesno', '[]', false, '{}', 40),
      ('visit', '{survey}', 'Access restrictions or narrow passages?',
       'text', '[]', false, '{}', 50),
      ('visit', '{survey}', 'Parking availability',
       'choice', '["On-site","On-street unrestricted","On-street permit","No nearby parking","Loading bay"]',
       false, '{}', 60),
      ('visit', '{survey}', 'Congestion charge or ULEZ zone?',
       'yesno', '[]', false, '{}', 70),
      ('visit', '{survey}', 'Mains power available on installation day?',
       'yesno', '[]', false, '{}', 80),
      ('visit', '{survey}', 'Occupancy during installation',
       'choice', '["Vacant","Owner / tenant present","Tenants staying"]',
       false, '{}', 90),
      ('visit', '{survey}', 'Pets on site?',
       'yesno', '[]', false, '{}', 100),
      ('visit', '{survey}', 'Any known hazards or site conditions?',
       'text', '[]', false, '{}', 110),
      ('visit', '{survey}', 'Listed building or conservation area?',
       'yesno', '[]', false, '{}', 120),
      ('visit', '{survey}', 'Customer preferred installation timeframe',
       'text', '[]', false, '{}', 130),
      ('visit', '{survey}', 'General survey notes',
       'text', '[]', false, '{}', 140)
    ) AS v(scope, applies_to, label, type, options, required, required_on, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM visit_questions vq
       WHERE vq.label = v.label AND vq.scope = v.scope
    );
  `);

  // ── Step 6: seed group C — Generic survey library (room-scoped) ──────────
  pgm.sql(`
    INSERT INTO visit_questions
      (scope, applies_to, label, type, options, required, required_on, sort_order)
    SELECT v.scope, v.applies_to::text[], v.label, v.type, v.options::jsonb,
           v.required, v.required_on::text[], v.sort_order
    FROM (VALUES
      ('room', '{survey}', 'Room type',
       'choice', '["Kitchen","Utility","Bathroom","En-suite","Bedroom","Living room","Study","Other"]',
       false, '{}', 10),
      ('room', '{survey}', 'Ceiling height (mm)',
       'number', '[]', false, '{}', 20),
      ('room', '{survey}', 'Sloped or vaulted ceiling?',
       'yesno', '[]', false, '{}', 30),
      ('room', '{survey}', 'Floor level relative to adjacent rooms',
       'choice', '["Level","Step up","Step down","Significant slope"]',
       false, '{}', 40),
      ('room', '{survey}', 'Existing floor covering',
       'choice', '["Tiles","Hardwood","Laminate","Vinyl","Carpet","Concrete","Other"]',
       false, '{}', 50),
      ('room', '{survey}', 'Flooring being replaced before or after installation?',
       'choice', '["Before","After","No change","Unknown"]',
       false, '{}', 60),
      ('room', '{survey}', 'Wall construction',
       'choice', '["Brick / block","Stud / plasterboard","Stone","Other / unknown"]',
       false, '{}', 70),
      ('room', '{survey}', 'Skirting board height (mm)',
       'number', '[]', false, '{}', 80),
      ('room', '{survey}', 'Picture or dado rail present?',
       'yesno', '[]', false, '{}', 90),
      ('room', '{survey}', 'Radiator positions and sizes noted?',
       'yesno', '[]', false, '{}', 100),
      ('room', '{survey}', 'Pipework moving required?',
       'yesno', '[]', false, '{}', 110),
      ('room', '{survey}', 'Number of existing sockets and switches',
       'number', '[]', false, '{}', 120),
      ('room', '{survey}', 'Socket or switch relocation required?',
       'yesno', '[]', false, '{}', 130),
      ('room', '{survey}', 'Window position and style noted?',
       'yesno', '[]', false, '{}', 140),
      ('room', '{survey}', 'Window reveal depth (mm)',
       'number', '[]', false, '{}', 150),
      ('room', '{survey}', 'Any obstructions (beams, columns, pipes)?',
       'text', '[]', false, '{}', 160),
      ('room', '{survey}', 'Loft hatch within the room?',
       'yesno', '[]', false, '{}', 170),
      ('room', '{survey}', 'Lighting type and positions noted?',
       'yesno', '[]', false, '{}', 180),
      ('room', '{survey}', 'Existing furniture to be retained?',
       'text', '[]', false, '{}', 190),
      ('room', '{survey}', 'Wall measurement A (mm)',
       'number', '[]', false, '{}', 200),
      ('room', '{survey}', 'Wall measurement B (mm)',
       'number', '[]', false, '{}', 210),
      ('room', '{survey}', 'Room out-of-square noted?',
       'yesno', '[]', false, '{}', 220),
      ('room', '{survey}', 'Room photographs taken?',
       'yesno', '[]', false, '{}', 230),
      ('room', '{survey}', 'Room notes',
       'text', '[]', false, '{}', 240)
    ) AS v(scope, applies_to, label, type, options, required, required_on, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM visit_questions vq
       WHERE vq.label = v.label AND vq.scope = v.scope
    );
  `);

  // ── Step 7: seed group D — Document checks ────────────────────────────────
  // Customer advice notes — required on survey, optional on design (sort 300–430).
  pgm.sql(`
    INSERT INTO visit_questions
      (scope, applies_to, label, type, options, required, required_on, sort_order)
    SELECT v.scope, v.applies_to::text[], v.label, v.type, v.options::jsonb,
           v.required, v.required_on::text[], v.sort_order
    FROM (VALUES
      ('room', '{design,survey}', 'Lead time and delivery schedule discussed',         'yesno', '[]', false, '{survey}', 300),
      ('room', '{design,survey}', 'Installation process and timescales explained',     'yesno', '[]', false, '{survey}', 310),
      ('room', '{design,survey}', 'Pre-installation preparation requirements covered', 'yesno', '[]', false, '{survey}', 320),
      ('room', '{design,survey}', 'Access requirements on installation day confirmed', 'yesno', '[]', false, '{survey}', 330),
      ('room', '{design,survey}', 'Removal and disposal of existing units discussed',  'yesno', '[]', false, '{survey}', 340),
      ('room', '{design,survey}', 'Post-installation decoration sequence explained',   'yesno', '[]', false, '{survey}', 350),
      ('room', '{design,survey}', 'Plumbing and electrical requirements outlined',     'yesno', '[]', false, '{survey}', 360),
      ('room', '{design,survey}', 'Worktop templating and fitting process explained',  'yesno', '[]', false, '{survey}', 370),
      ('room', '{design,survey}', 'Snagging process and aftercare discussed',          'yesno', '[]', false, '{survey}', 380),
      ('room', '{design,survey}', 'Warranty and guarantee terms confirmed',            'yesno', '[]', false, '{survey}', 390),
      ('room', '{design,survey}', 'Care and maintenance guidance provided',            'yesno', '[]', false, '{survey}', 400),
      ('room', '{design,survey}', 'Appliance installation and handover discussed',     'yesno', '[]', false, '{survey}', 410),
      ('room', '{design,survey}', 'Payment schedule and terms confirmed',              'yesno', '[]', false, '{survey}', 420),
      ('room', '{design,survey}', 'Contact details for queries provided to customer',  'yesno', '[]', false, '{survey}', 430)
    ) AS v(scope, applies_to, label, type, options, required, required_on, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM visit_questions vq
       WHERE vq.label = v.label AND vq.scope = v.scope
    );
  `);

  // Responsibilities — required on survey, optional on design (sort 440–500).
  pgm.sql(`
    INSERT INTO visit_questions
      (scope, applies_to, label, type, options, required, required_on, sort_order)
    SELECT v.scope, v.applies_to::text[], v.label, v.type, v.options::jsonb,
           v.required, v.required_on::text[], v.sort_order
    FROM (VALUES
      ('room', '{design,survey}', 'Customer to clear and protect area before installation', 'yesno', '[]', false, '{survey}', 440),
      ('room', '{design,survey}', 'Customer to arrange redecoration after installation',    'yesno', '[]', false, '{survey}', 450),
      ('room', '{design,survey}', 'Customer to arrange plumber for final connections',      'yesno', '[]', false, '{survey}', 460),
      ('room', '{design,survey}', 'Customer to arrange electrician for final connections',  'yesno', '[]', false, '{survey}', 470),
      ('room', '{design,survey}', 'Customer responsible for floor preparation',             'yesno', '[]', false, '{survey}', 480),
      ('room', '{design,survey}', 'Customer to arrange removal of appliances if required',  'yesno', '[]', false, '{survey}', 490),
      ('room', '{design,survey}', 'Responsibility for permits or planning confirmed',       'yesno', '[]', false, '{survey}', 500)
    ) AS v(scope, applies_to, label, type, options, required, required_on, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM visit_questions vq
       WHERE vq.label = v.label AND vq.scope = v.scope
    );
  `);

  // Survey-specific checks — optional, survey only (sort 510–670).
  pgm.sql(`
    INSERT INTO visit_questions
      (scope, applies_to, label, type, options, required, required_on, sort_order)
    SELECT v.scope, v.applies_to::text[], v.label, v.type, v.options::jsonb,
           v.required, v.required_on::text[], v.sort_order
    FROM (VALUES
      ('room', '{survey}', 'Building regulations compliance checked',             'yesno', '[]', false, '{}', 510),
      ('room', '{survey}', 'Gas supply location noted',                           'yesno', '[]', false, '{}', 520),
      ('room', '{survey}', 'Electricity supply and consumer unit location noted', 'yesno', '[]', false, '{}', 530),
      ('room', '{survey}', 'Water supply and stop cock location noted',           'yesno', '[]', false, '{}', 540),
      ('room', '{survey}', 'Waste and drainage routes identified',                'yesno', '[]', false, '{}', 550),
      ('room', '{survey}', 'Structural wall identification checked',              'yesno', '[]', false, '{}', 560),
      ('room', '{survey}', 'Window position and trim requirements noted',         'yesno', '[]', false, '{}', 570),
      ('room', '{survey}', 'Heating radiator positions confirmed',                'yesno', '[]', false, '{}', 580),
      ('room', '{survey}', 'Extractor fan route identified',                      'yesno', '[]', false, '{}', 590),
      ('room', '{survey}', 'Lighting positions and type confirmed',               'yesno', '[]', false, '{}', 600),
      ('room', '{survey}', 'Socket and switch relocation requirements noted',     'yesno', '[]', false, '{}', 610),
      ('room', '{survey}', 'Floor level and condition assessed',                  'yesno', '[]', false, '{}', 620),
      ('room', '{survey}', 'Ceiling height and any obstructions noted',           'yesno', '[]', false, '{}', 630),
      ('room', '{survey}', 'Access and delivery route confirmed',                 'yesno', '[]', false, '{}', 640),
      ('room', '{survey}', 'Site photograph checklist completed',                 'yesno', '[]', false, '{}', 650),
      ('room', '{survey}', 'Measurements cross-checked and verified',             'yesno', '[]', false, '{}', 660),
      ('room', '{survey}', 'Survey report completed and signed',                  'yesno', '[]', false, '{}', 670)
    ) AS v(scope, applies_to, label, type, options, required, required_on, sort_order)
    WHERE NOT EXISTS (
      SELECT 1 FROM visit_questions vq
       WHERE vq.label = v.label AND vq.scope = v.scope
    );
  `);
};

exports.down = (pgm) => {
  // Remove all rows seeded by this migration (by exact label).
  pgm.sql(`
    DELETE FROM visit_questions
     WHERE label IN (
       -- Group A
       'Which collection is being chosen for this visit?',
       'Collection for this room (if different from the visit selection)',
       -- Group B
       'Range / collection name',
       'Door and drawer colour',
       'Exterior panel and trim colour',
       'Interior colour',
       'Worktop colour',
       'Handle choice',
       -- Group C visit-scoped
       'Property type',
       'Approximate property age',
       'Floor the room is on',
       'Step-free access to the property?',
       'Access restrictions or narrow passages?',
       'Parking availability',
       'Congestion charge or ULEZ zone?',
       'Mains power available on installation day?',
       'Occupancy during installation',
       'Pets on site?',
       'Any known hazards or site conditions?',
       'Listed building or conservation area?',
       'Customer preferred installation timeframe',
       'General survey notes',
       -- Group C room-scoped
       'Room type',
       'Ceiling height (mm)',
       'Sloped or vaulted ceiling?',
       'Floor level relative to adjacent rooms',
       'Existing floor covering',
       'Flooring being replaced before or after installation?',
       'Wall construction',
       'Skirting board height (mm)',
       'Picture or dado rail present?',
       'Radiator positions and sizes noted?',
       'Pipework moving required?',
       'Number of existing sockets and switches',
       'Socket or switch relocation required?',
       'Window position and style noted?',
       'Window reveal depth (mm)',
       'Any obstructions (beams, columns, pipes)?',
       'Loft hatch within the room?',
       'Lighting type and positions noted?',
       'Existing furniture to be retained?',
       'Wall measurement A (mm)',
       'Wall measurement B (mm)',
       'Room out-of-square noted?',
       'Room photographs taken?',
       'Room notes',
       -- Group D customer advice notes
       'Lead time and delivery schedule discussed',
       'Installation process and timescales explained',
       'Pre-installation preparation requirements covered',
       'Access requirements on installation day confirmed',
       'Removal and disposal of existing units discussed',
       'Post-installation decoration sequence explained',
       'Plumbing and electrical requirements outlined',
       'Worktop templating and fitting process explained',
       'Snagging process and aftercare discussed',
       'Warranty and guarantee terms confirmed',
       'Care and maintenance guidance provided',
       'Appliance installation and handover discussed',
       'Payment schedule and terms confirmed',
       'Contact details for queries provided to customer',
       -- Group D responsibilities
       'Customer to clear and protect area before installation',
       'Customer to arrange redecoration after installation',
       'Customer to arrange plumber for final connections',
       'Customer to arrange electrician for final connections',
       'Customer responsible for floor preparation',
       'Customer to arrange removal of appliances if required',
       'Responsibility for permits or planning confirmed',
       -- Group D survey-specific checks
       'Building regulations compliance checked',
       'Gas supply location noted',
       'Electricity supply and consumer unit location noted',
       'Water supply and stop cock location noted',
       'Waste and drainage routes identified',
       'Structural wall identification checked',
       'Window position and trim requirements noted',
       'Heating radiator positions confirmed',
       'Extractor fan route identified',
       'Lighting positions and type confirmed',
       'Socket and switch relocation requirements noted',
       'Floor level and condition assessed',
       'Ceiling height and any obstructions noted',
       'Access and delivery route confirmed',
       'Site photograph checklist completed',
       'Measurements cross-checked and verified',
       'Survey report completed and signed'
     );
  `);

  // Reverse the applies_to extension: remove 'survey' from rows that still
  // have 'design' (the original design-only questions from the prior migration).
  pgm.sql(`
    UPDATE visit_questions
       SET applies_to = array_remove(applies_to, 'survey'),
           updated_at = NOW()
     WHERE 'design' = ANY(applies_to)
       AND 'survey' = ANY(applies_to);
  `);

  // Drop the required_on column (resets backfilled data too).
  pgm.sql(`
    ALTER TABLE visit_questions
      DROP COLUMN IF EXISTS required_on;
  `);
};
