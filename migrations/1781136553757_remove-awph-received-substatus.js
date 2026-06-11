'use strict';

/**
 * Delete the orphaned AWAITING_PHOTOS / AWPH_RECEIVED row from lead_substatuses
 * if it is still present.
 *
 * Background: older customer-info form submissions upserted an AWPH_RECEIVED row
 * with action_label "Review Photos" to drive the now-removed hw_lead_substatus
 * HubSpot property.  The ensureSubstatusExists helper that wrote those rows was
 * removed from customer-info.js; this migration cleans up any row it left behind.
 *
 * The table itself is dropped by the earlier remove-substatuses migration, so this
 * uses a DO block to safely no-op when the table no longer exists.
 */

exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name   = 'lead_substatuses'
      ) THEN
        DELETE FROM lead_substatuses WHERE substatus_key = 'AWPH_RECEIVED';
      END IF;
    END $$;
  `);
};

exports.down = () => {
  // Intentionally a no-op — re-inserting a deprecated substatus row is not supported.
};
