'use strict';

exports.shorthands = undefined;

// ── GHOSTED lead status ──────────────────────────────────────────────────────
// The design "No answer — email sent" outcome moves the contact to GHOSTED
// (the customer ghosted us after we couldn't reach them). GHOSTED is
// excluded-from-sales so the card drops off the active sales list.
//
// Uses the same conditional INSERT as DECLINED_DEAL: only fire on databases that
// already have other seeded statuses. On a clean/fresh install the row is seeded
// by ensureLeadStatusTable() via DEFAULT_LEAD_STATUSES instead — inserting into an
// otherwise-empty table here would trip that function's `count > 0` early-exit
// and skip seeding the remaining statuses.
//
// Production note: GHOSTED already exists as an hs_lead_status option in HubSpot;
// this row only mirrors it into lead_status_config so the app's pipeline UI and
// the assertLeadStatusKey() guard recognise the key. ON CONFLICT DO NOTHING keeps
// it idempotent where HubSpot's seed already created the row.

exports.up = pgm => {
  pgm.sql(`
    INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
    SELECT 'GHOSTED', 'Ghosted', 9, TRUE, 'SALES'
    WHERE EXISTS (
      SELECT 1 FROM lead_status_config
      WHERE is_null_row IS NOT TRUE AND key != 'GHOSTED'
    )
    ON CONFLICT (key) DO NOTHING
  `);
};

exports.down = pgm => {
  pgm.sql(`DELETE FROM lead_status_config WHERE key = 'GHOSTED'`);
};
