// Backfill stage_action_labels rows that may be missing for non-sales pipeline
// stages (ORDER, WORKSHOP, PACKING, etc.) that were added to LEAD_STATUS_STAGE_KEYS
// after the initial seed ran.
//
// Two row types are seeded:
//   1. Per-status rows  — one row per (stage_key, status_key) derived from
//      lead_status_config rows that have a known stage assignment.  Uses the
//      status display label as the initial value.  Admin edits are never
//      overwritten (ON CONFLICT … DO NOTHING).
//   2. Null-status rows — one (stage_key, '') row per known pipeline stage so
//      the "No lead status / stage default" slot in the Card Actions tab is
//      immediately editable without requiring a server restart or manual
//      admin interaction.

const STAGE_KEYS = [
  'SALES', 'DESIGN_VISIT', 'SURVEY', 'ORDER', 'WORKSHOP',
  'PACKING', 'DELIVERY', 'INSTALLATION', 'AFTERCARE', 'CUSTOMER_SERVICE',
];

// Mirror of server-side _normToCardStageKey: lowercase + strip underscores.
const norm = s => s.toLowerCase().replace(/_/g, '');

exports.up = pgm => {
  // 1. Per-status rows
  pgm.sql(`
    INSERT INTO stage_action_labels (stage_key, status_key, label)
    SELECT
      LOWER(REPLACE(lsc.stage, '_', '')) AS stage_key,
      LOWER(lsc.key)                     AS status_key,
      COALESCE(NULLIF(lsc.label, ''), LOWER(lsc.key)) AS label
    FROM lead_status_config lsc
    WHERE lsc.is_null_row IS NOT TRUE
      AND lsc.stage = ANY(ARRAY[${STAGE_KEYS.map(k => `'${k}'`).join(',')}]::text[])
      AND LOWER(lsc.key) <> ''
    ON CONFLICT (stage_key, status_key) DO NOTHING
  `);

  // 2. Null-status (stage-default) rows — empty label so the slot is
  //    visible in the Card Actions tab but shows no action strip by default.
  const nullRows = STAGE_KEYS.map(k => `('${norm(k)}', '', '')`).join(',\n      ');
  pgm.sql(`
    INSERT INTO stage_action_labels (stage_key, status_key, label)
    VALUES
      ${nullRows}
    ON CONFLICT (stage_key, status_key) DO NOTHING
  `);
};

exports.down = pgm => {
  // Remove only the null-status rows that were seeded with an empty label
  // (admin-configured rows with non-empty labels are intentionally preserved).
  const stageList = STAGE_KEYS.map(k => `'${norm(k)}'`).join(', ');
  pgm.sql(`
    DELETE FROM stage_action_labels
    WHERE status_key = ''
      AND label      = ''
      AND stage_key  = ANY(ARRAY[${stageList}]::text[])
  `);
};
