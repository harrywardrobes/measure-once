'use strict';

exports.shorthands = undefined;

// Rename the email_templates key 'customer_invite' → 'photo_review_invite'
// to clarify that this template is specifically for the photo-review invite flow.
// On a fresh DB the UPDATE is a no-op (0 rows); ensureEmailTemplatesTable()
// seeds the 'photo_review_invite' row on first boot.
exports.up = pgm => {
  pgm.sql(`UPDATE email_templates SET key = 'photo_review_invite' WHERE key = 'customer_invite'`);
};

exports.down = pgm => {
  pgm.sql(`UPDATE email_templates SET key = 'customer_invite' WHERE key = 'photo_review_invite'`);
};
