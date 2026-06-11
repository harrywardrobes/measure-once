exports.up = (pgm) => {
  // This data migration references substatus_id. If it is re-run against a
  // schema where a later migration (1749200000019_remove-substatuses) or an
  // external schema sync has already dropped substatus_id, skip it entirely —
  // the global-binding consolidation is handled column-free by the later
  // 1781130509174_migrate-global-handler-binding migration.
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'card_action_handler_bindings'
          AND column_name = 'substatus_id'
      ) THEN
        RETURN;
      END IF;

      -- Step 1: Collapse duplicates within sales/(NULL or '').
      -- Because Postgres UNIQUE indexes treat NULLs as distinct, multiple rows
      -- with (stage_key='sales', status_key IS NULL, substatus_id IS NULL) can
      -- coexist. Keep the lowest-id row; delete the rest.
      DELETE FROM card_action_handler_bindings
      WHERE stage_key = 'sales'
        AND (status_key IS NULL OR status_key = '')
        AND substatus_id IS NULL
        AND id NOT IN (
          SELECT MIN(id)
          FROM card_action_handler_bindings
          WHERE stage_key = 'sales'
            AND (status_key IS NULL OR status_key = '')
            AND substatus_id IS NULL
        );

      -- Step 2: If a __global__/(NULL or '') binding already exists, the one
      -- remaining sales/'' row is redundant — delete it to avoid a unique-index
      -- conflict on the subsequent UPDATE.
      DELETE FROM card_action_handler_bindings
      WHERE stage_key = 'sales'
        AND (status_key IS NULL OR status_key = '')
        AND substatus_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM card_action_handler_bindings g
          WHERE g.stage_key    = '__global__'
            AND (g.status_key IS NULL OR g.status_key = '')
            AND g.substatus_id IS NULL
        );

      -- Step 3: Re-point any surviving sales/'' row to the canonical global slot.
      UPDATE card_action_handler_bindings
      SET stage_key  = '__global__',
          status_key = ''
      WHERE stage_key = 'sales'
        AND (status_key IS NULL OR status_key = '')
        AND substatus_id IS NULL;
    END $$;
  `);
};

exports.down = (pgm) => {
  // There is no safe automatic reversal: collapsed duplicate rows are gone and
  // the original stage/status provenance of migrated rows is lost.
  // Roll back manually if needed.
  pgm.sql(`SELECT 1`);
};
