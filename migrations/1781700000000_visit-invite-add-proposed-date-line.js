'use strict';

exports.shorthands = undefined;

// One-off backfill: any customised visit_invite template that was saved before
// {{proposedDateLine}} was added to the seed body gets the placeholder inserted.
// Strategy:
//   - If the body contains "Please reply" (the line immediately after the
//     placeholder in the seed), insert "{{proposedDateLine}}" right before it
//     so the custom body matches the intended layout.
//   - Otherwise (heavily customised body where the phrase isn't present),
//     append "{{proposedDateLine}}" at the end so it is at least present.
// The WHERE clause makes the UPDATE idempotent — rows that already contain
// {{proposedDateLine}} are untouched.
// updated_at / updated_by are left unchanged to reflect that this is a
// system-applied structural fix, not an admin edit.
exports.up = pgm => {
  pgm.sql(`
    UPDATE email_templates
    SET body_text = CASE
      WHEN body_text LIKE '%Please reply%'
        THEN regexp_replace(
          body_text,
          'Please reply',
          '{{proposedDateLine}}Please reply'
        )
      ELSE body_text || E'\\n\\n{{proposedDateLine}}'
    END
    WHERE key = 'visit_invite'
      AND body_text NOT LIKE '%{{proposedDateLine}}%'
  `);
};

// Reverses the backfill by stripping {{proposedDateLine}} from any visit_invite
// body that contains it, removing the trailing-newline variant too.
exports.down = pgm => {
  pgm.sql(`
    UPDATE email_templates
    SET body_text = regexp_replace(
      regexp_replace(
        body_text,
        E'\\n\\n\\{\\{proposedDateLine\\}\\}',
        '',
        'g'
      ),
      '\\{\\{proposedDateLine\\}\\}',
      '',
      'g'
    )
    WHERE key = 'visit_invite'
      AND body_text LIKE '%{{proposedDateLine}}%'
  `);
};
