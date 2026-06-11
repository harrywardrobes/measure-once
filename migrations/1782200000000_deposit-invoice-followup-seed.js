'use strict';

exports.shorthands = undefined;

// Seeds:
//   1. email_templates row for deposit_invoice_payment_reminder
//   2. card_action_handlers row for deposit_invoice_followup
//   3. card_action_handler_bindings row for DEPOSIT_INVOICE status

exports.up = pgm => {
  pgm.sql(`
    INSERT INTO email_templates (key, subject, body_text, body_html, footer_text)
    VALUES (
      'deposit_invoice_payment_reminder',
      'Reminder: your deposit invoice',
      E'Hi {{firstName}},\n\nI just wanted to follow up regarding your deposit invoice{{invoiceDocNum}} — we haven''t received payment yet.\n\nOutstanding balance: {{balanceAmount}}\n{{invoiceLink}}\nIf you have any questions or would like to discuss payment, please don''t hesitate to get in touch.',
      E'<p>Hi {{firstName}},</p>\n<p>I just wanted to follow up regarding your deposit invoice{{invoiceDocNum}} — we haven''t received payment yet.</p>\n<p><strong>Outstanding balance: {{balanceAmount}}</strong></p>\n{{invoiceLink}}\n<p>If you have any questions or would like to discuss payment, please don''t hesitate to get in touch.</p>',
      E'Warm regards,\nThe team'
    )
    ON CONFLICT (key) DO NOTHING
  `);

  pgm.sql(`
    WITH ins AS (
      INSERT INTO card_action_handlers (name, type, config)
      SELECT 'Deposit invoice follow-up', 'deposit_invoice_followup', '{}'::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM card_action_handlers WHERE type = 'deposit_invoice_followup'
      )
      RETURNING id
    )
    INSERT INTO card_action_handler_bindings (handler_id, stage_key, status_key)
    SELECT ins.id, 'sales', 'deposit_invoice'
    FROM ins
    WHERE NOT EXISTS (
      SELECT 1 FROM card_action_handler_bindings
      WHERE stage_key = 'sales' AND status_key = 'deposit_invoice'
    )
  `);
};

exports.down = pgm => {
  pgm.sql(`
    DELETE FROM card_action_handler_bindings
    WHERE stage_key = 'sales' AND status_key = 'deposit_invoice'
      AND handler_id IN (
        SELECT id FROM card_action_handlers WHERE type = 'deposit_invoice_followup'
      )
  `);
  pgm.sql(`DELETE FROM card_action_handlers WHERE type = 'deposit_invoice_followup'`);
  pgm.sql(`DELETE FROM email_templates WHERE key = 'deposit_invoice_payment_reminder'`);
};
