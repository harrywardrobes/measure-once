'use strict';
// Patches the persisted admin_notification email template to include the
// {{contactPhone}} placeholder that was added to the seed definition.
//
// The template table uses INSERT … ON CONFLICT DO NOTHING at boot, so existing
// rows (deployed environments) never receive new placeholder text automatically.
// This migration performs a targeted in-place update using PostgreSQL's
// replace() function, touching only the exact legacy strings that need to
// change.  Rows that already contain {{contactPhone}} are left untouched,
// making the migration safe to re-run.
//
// body_text: {{contactPhone}} is inserted as a new line between Email and
//   {{correctedMobile}}, matching the updated seed definition.
// body_html: {{contactPhone}} is inserted as a table-row slot between the
//   Email row and {{correctedMobile}}, matching the updated seed definition.
//
// Down: strips the placeholder back out, restoring the prior shape.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    UPDATE email_templates
       SET body_text = replace(
             body_text,
             E'Email:        {{customerEmail}}\\n{{correctedMobile}}\\nAddress:      {{address}}',
             E'Email:        {{customerEmail}}\\n{{contactPhone}}\\n{{correctedMobile}}\\nAddress:      {{address}}'
           ),
           body_html = replace(
             body_html,
             E'  <tr><td><strong>Email</strong></td><td>{{customerEmail}}</td></tr>\\n  {{correctedMobile}}\\n  <tr><td><strong>Address</strong></td><td>{{address}}</td></tr>',
             E'  <tr><td><strong>Email</strong></td><td>{{customerEmail}}</td></tr>\\n  {{contactPhone}}\\n  {{correctedMobile}}\\n  <tr><td><strong>Address</strong></td><td>{{address}}</td></tr>'
           )
     WHERE key = 'admin_notification'
       AND body_text NOT LIKE '%{{contactPhone}}%'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    UPDATE email_templates
       SET body_text = replace(
             body_text,
             E'Email:        {{customerEmail}}\\n{{contactPhone}}\\n{{correctedMobile}}\\nAddress:      {{address}}',
             E'Email:        {{customerEmail}}\\n{{correctedMobile}}\\nAddress:      {{address}}'
           ),
           body_html = replace(
             body_html,
             E'  <tr><td><strong>Email</strong></td><td>{{customerEmail}}</td></tr>\\n  {{contactPhone}}\\n  {{correctedMobile}}\\n  <tr><td><strong>Address</strong></td><td>{{address}}</td></tr>',
             E'  <tr><td><strong>Email</strong></td><td>{{customerEmail}}</td></tr>\\n  {{correctedMobile}}\\n  <tr><td><strong>Address</strong></td><td>{{address}}</td></tr>'
           )
     WHERE key = 'admin_notification'
       AND body_text LIKE '%{{contactPhone}}%'
  `);
};
