#!/usr/bin/env node
/**
 * One-time backfill: apply title-case to ec_first_name / ec_last_name in
 * the allowed_emails.metadata JSONB column, matching the logic added to the
 * admin PATCH handler in auth.js (~line 1665).
 *
 * Usage:
 *   node scripts/backfill-ec-name-casing.js
 *
 * Reads DATABASE_URL from the environment (same as the main app).
 * Dry-run by default — pass --apply to commit changes.
 */

'use strict';

const { Pool } = require('pg');

const DRY_RUN = !process.argv.includes('--apply');

function titleCaseFirst(raw) {
  const tok = (raw || '').trim().split(/\s+/).filter(Boolean)[0] || '';
  return tok ? tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase() : null;
}

function titleCaseLast(raw) {
  const tokens = (raw || '').trim().split(/\s+/).filter(Boolean);
  const tok = tokens[tokens.length - 1] || '';
  return tok ? tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase() : null;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    const { rows } = await client.query(`
      SELECT email, metadata
      FROM allowed_emails
      WHERE metadata ? 'ec_first_name'
         OR metadata ? 'ec_last_name'
    `);

    console.log(`Found ${rows.length} row(s) with ec_first_name or ec_last_name.`);
    if (DRY_RUN) {
      console.log('Dry-run mode — pass --apply to commit changes.\n');
    }

    let updated = 0;

    for (const row of rows) {
      const meta = row.metadata || {};
      const newMeta = { ...meta };
      let changed = false;

      if (meta.ec_first_name != null) {
        const fixed = titleCaseFirst(meta.ec_first_name);
        if (fixed !== meta.ec_first_name) {
          console.log(`  ${row.email}: ec_first_name  "${meta.ec_first_name}" → "${fixed}"`);
          if (fixed) newMeta.ec_first_name = fixed; else delete newMeta.ec_first_name;
          changed = true;
        }
      }

      if (meta.ec_last_name != null) {
        const fixed = titleCaseLast(meta.ec_last_name);
        if (fixed !== meta.ec_last_name) {
          console.log(`  ${row.email}: ec_last_name   "${meta.ec_last_name}" → "${fixed}"`);
          if (fixed) newMeta.ec_last_name = fixed; else delete newMeta.ec_last_name;
          changed = true;
        }
      }

      if (changed) {
        updated++;
        if (!DRY_RUN) {
          await client.query(
            `UPDATE allowed_emails SET metadata = $1::jsonb WHERE email = $2`,
            [JSON.stringify(newMeta), row.email]
          );
        }
      }
    }

    if (DRY_RUN) {
      console.log(`\nDry run complete. ${updated} row(s) would be updated.`);
    } else {
      console.log(`\nBackfill complete. ${updated} row(s) updated.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
