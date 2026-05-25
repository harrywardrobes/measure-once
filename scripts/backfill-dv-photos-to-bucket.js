#!/usr/bin/env node
/**
 * One-time backfill: move legacy `data:image/*;base64,...` blobs in
 * `design_visit_room_images.storage_key` into Replit Object Storage via
 * `design-visit-uploads.uploadFromDataUrl`, and rewrite each row's
 * `storage_key` (and `mime_type`) to the new opaque `obj:<uuid>.<ext>` shape.
 *
 * Idempotent: only rows whose `storage_key` literally starts with `data:`
 * are touched. Re-running after a partial run picks up where it left off.
 *
 * Usage:
 *   node scripts/backfill-dv-photos-to-bucket.js            # dry run
 *   node scripts/backfill-dv-photos-to-bucket.js --apply    # commit changes
 *
 * Reads DATABASE_URL from the environment (same as the main app). Object
 * Storage must be provisioned (the `@replit/object-storage` client is
 * auto-configured from `.replit`).
 */

'use strict';

const { Pool } = require('pg');
const dvUploads = require('../design-visit-uploads');

const APPLY = process.argv.includes('--apply');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let processed = 0;
  let migrated  = 0;
  let skipped   = 0;
  let failed    = 0;

  try {
    const countR = await pool.query(
      `SELECT COUNT(*)::int AS n FROM design_visit_room_images WHERE storage_key LIKE 'data:%'`
    );
    const total = countR.rows[0].n;
    console.log(`[backfill] Found ${total} legacy data: row(s).${APPLY ? '' : ' (dry run — pass --apply to commit)'}`);
    if (!total) {
      await pool.end();
      return;
    }

    const BATCH = 50;
    let lastId = 0;
    // Stream in id-ordered batches so a partial run can resume on re-invocation.
    /* eslint-disable no-constant-condition */
    while (true) {
      const r = await pool.query(
        `SELECT id, room_id, storage_key, mime_type
           FROM design_visit_room_images
          WHERE storage_key LIKE 'data:%' AND id > $1
          ORDER BY id ASC
          LIMIT $2`,
        [lastId, BATCH]
      );
      if (!r.rows.length) break;

      for (const row of r.rows) {
        processed++;
        lastId = row.id;
        try {
          if (!APPLY) {
            const approxBytes = Math.floor((row.storage_key.length - row.storage_key.indexOf(',') - 1) * 3 / 4);
            console.log(`[backfill] [dry-run] id=${row.id} room=${row.room_id} mime=${row.mime_type || '?'} ~${approxBytes}B`);
            skipped++;
            continue;
          }
          const { storageKey, mimeType, byteLength } = await dvUploads.uploadFromDataUrl(row.storage_key);
          await pool.query(
            `UPDATE design_visit_room_images
                SET storage_key = $1, mime_type = $2
              WHERE id = $3 AND storage_key LIKE 'data:%'`,
            [storageKey, mimeType, row.id]
          );
          migrated++;
          console.log(`[backfill] id=${row.id} room=${row.room_id} → ${storageKey} (${byteLength}B)`);
        } catch (e) {
          failed++;
          console.error(`[backfill] id=${row.id} FAILED: ${e.message}`);
        }
      }
    }
    /* eslint-enable no-constant-condition */

    console.log(`[backfill] Done. processed=${processed} migrated=${migrated} skipped=${skipped} failed=${failed}`);
    if (failed) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch(e => {
  console.error('[backfill] Fatal:', e);
  process.exit(1);
});
