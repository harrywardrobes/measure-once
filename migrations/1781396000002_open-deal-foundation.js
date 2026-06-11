'use strict';

exports.shorthands = undefined;

// ── DECLINED_DEAL lead status ────────────────────────────────────────────────
// Uses a conditional INSERT so this only fires on already-seeded databases
// (where lead_status_config already has other rows).  On a clean/fresh install
// the row is instead seeded by ensureLeadStatusTable() via DEFAULT_LEAD_STATUSES,
// which avoids triggering that function's early-exit guard.

// ── New email templates ──────────────────────────────────────────────────────
// Inserts seed rows for the two Open Deal email templates.  The boot-time
// ensureEmailTemplatesTable() uses ON CONFLICT DO NOTHING so these rows are
// never overwritten by code defaults.

exports.up = pgm => {
  // DECLINED_DEAL — only insert if the table already has other statuses
  pgm.sql(`
    INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales, stage)
    SELECT 'DECLINED_DEAL', 'Declined Deal', 100, TRUE, 'SALES'
    WHERE EXISTS (
      SELECT 1 FROM lead_status_config
      WHERE is_null_row IS NOT TRUE AND key != 'DECLINED_DEAL'
    )
    ON CONFLICT (key) DO NOTHING
  `);

  // Email template: open_deal_deposit_invoice_sent
  pgm.sql(`
    INSERT INTO email_templates (key, subject, body_text, body_html, footer_text)
    VALUES (
      'open_deal_deposit_invoice_sent',
      'Your deposit invoice',
      E'Hi {{firstName}},\n\nI''ve sent over the {{depositPercent}}% deposit invoice — please let me know if you haven''t received it.\n\nOnce received, we can then book in a survey visit to confirm the final measurements and design choices.',
      E'<p>Hi {{firstName}},</p>\n<p>I''ve sent over the <strong>{{depositPercent}}% deposit invoice</strong> — please let me know if you haven''t received it.</p>\n<p>Once received, we can then book in a survey visit to confirm the final measurements and design choices.</p>',
      E'Warm regards,\nThe team'
    )
    ON CONFLICT (key) DO NOTHING
  `);

  // Email template: open_deal_declined_thank_you
  pgm.sql(`
    INSERT INTO email_templates (key, subject, body_text, body_html, footer_text)
    VALUES (
      'open_deal_declined_thank_you',
      'Thank you',
      E'Hi {{firstName}},\n\nThank you for your time — please feel free to get in touch if you have any questions regarding wardrobes.',
      E'<p>Hi {{firstName}},</p>\n<p>Thank you for your time — please feel free to get in touch if you have any questions regarding wardrobes.</p>',
      E'Warm regards,\nThe team'
    )
    ON CONFLICT (key) DO NOTHING
  `);
};

exports.down = pgm => {
  pgm.sql(`DELETE FROM lead_status_config WHERE key = 'DECLINED_DEAL'`);
  pgm.sql(`DELETE FROM email_templates WHERE key IN ('open_deal_deposit_invoice_sent', 'open_deal_declined_thank_you')`);
};
