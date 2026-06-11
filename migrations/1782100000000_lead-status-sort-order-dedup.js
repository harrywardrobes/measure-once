exports.up = (pgm) => {
  pgm.sql(`
    -- Reassign sort_order to strictly sequential values (0, 1, 2 …) for all
    -- non-null rows, ordered by the current sort_order ASC, key ASC — the
    -- same ordering used by syncLeadStatusesToHubSpot.
    WITH ranked AS (
      SELECT
        key,
        (ROW_NUMBER() OVER (ORDER BY sort_order ASC, key ASC) - 1)::int AS new_order
      FROM lead_status_config
      WHERE is_null_row IS NOT TRUE
    )
    UPDATE lead_status_config lsc
    SET sort_order = ranked.new_order
    FROM ranked
    WHERE lsc.key = ranked.key;

    -- Prevent duplicate sort_order values from being reintroduced for
    -- non-null rows.
    CREATE UNIQUE INDEX IF NOT EXISTS lead_status_config_sort_order_uniq
      ON lead_status_config (sort_order)
      WHERE is_null_row IS NOT TRUE;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS lead_status_config_sort_order_uniq;
  `);
};
