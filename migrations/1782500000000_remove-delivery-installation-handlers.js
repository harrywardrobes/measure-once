'use strict';

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    DELETE FROM card_action_handlers
      WHERE type IN ('schedule_delivery_window', 'schedule_installation_slot');

    UPDATE card_action_handlers
      SET type   = 'schedule_visit',
          config = COALESCE(config, '{}')::jsonb || '{"visitType":"design"}'::jsonb
      WHERE type = 'add_design_visit_to_calendar';

    UPDATE card_action_handlers
      SET config = config || '{"visitType":"design"}'::jsonb
      WHERE type = 'schedule_visit'
        AND config->>'visitType' IS NULL;
  `);
};

exports.down = false;
