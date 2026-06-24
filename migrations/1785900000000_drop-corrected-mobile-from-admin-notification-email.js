'use strict';
// Strips the leftover {{correctedMobile}} placeholder from the persisted
// admin_notification email template. The corrected-email/mobile feature was
// removed (see drop-corrected-email-mobile), and the rendering code no longer
// supplies that variable, so the placeholder text rendered literally as
// "{{correctedMobile}}" in admin notification emails.
//
// The template table uses INSERT … ON CONFLICT DO NOTHING at boot, so existing
// rows (deployed environments) never lose stale placeholder text automatically.
// This migration performs a targeted in-place update using PostgreSQL's
// replace() function, touching only the exact legacy strings that need to
// change. Rows that no longer contain {{correctedMobile}} are left untouched,
// making the migration safe to re-run.
//
// body_text: removes the standalone {{correctedMobile}} line that sat between
//   {{contactPhone}} and Address.
// body_html: removes the standalone {{correctedMobile}} table-row slot that sat
//   between the {{contactPhone}} row and the Address row.
//
// Down: re-inserts the placeholder, restoring the prior shape.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    UPDATE email_templates
       SET body_text = replace(
             body_text,
             E'{{contactPhone}}\\n{{correctedMobile}}\\nAddress:      {{address}}',
             E'{{contactPhone}}\\nAddress:      {{address}}'
           ),
           body_html = replace(
             body_html,
             E'  {{contactPhone}}\\n  {{correctedMobile}}\\n  <tr><td><strong>Address</strong></td><td>{{address}}</td></tr>',
             E'  {{contactPhone}}\\n  <tr><td><strong>Address</strong></td><td>{{address}}</td></tr>'
           )
     WHERE key = 'admin_notification'
       AND body_text LIKE '%{{correctedMobile}}%'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    UPDATE email_templates
       SET body_text = replace(
             body_text,
             E'{{contactPhone}}\\nAddress:      {{address}}',
             E'{{contactPhone}}\\n{{correctedMobile}}\\nAddress:      {{address}}'
           ),
           body_html = replace(
             body_html,
             E'  {{contactPhone}}\\n  <tr><td><strong>Address</strong></td><td>{{address}}</td></tr>',
             E'  {{contactPhone}}\\n  {{correctedMobile}}\\n  <tr><td><strong>Address</strong></td><td>{{address}}</td></tr>'
           )
     WHERE key = 'admin_notification'
       AND body_text NOT LIKE '%{{correctedMobile}}%'
  `);
};
