#!/usr/bin/env node
// scripts/gc-design-visit-photos.mjs
//
// One-off admin GC script: finds opaque cloud-storage keys under the
// `design-visit-images/` namespace that are no longer referenced by any row
// in `design_visit_room_images` and deletes them from the bucket.
//
// Usage:
//   node scripts/gc-design-visit-photos.mjs [--dry-run]
//
// Options:
//   --dry-run   List orphaned keys without deleting them.
//
// Requirements:
//   DATABASE_URL (or DATABASE_URL_TEST) must be set in the environment.
//   The active storage backend (see STORAGE_BACKEND in storage.js) must be
//   provisioned. On the default `replit` backend the Object Storage bucket is
//   wired in via .replit automatically; under STORAGE_BACKEND=gcs the script
//   auto-targets Google Cloud Storage instead.
//
// Safety:
//   The script only touches objects whose name starts with
//   `design-visit-images/` and whose filename matches the opaque key pattern
//   `obj:<id>.<ext>` minted by design-visit-uploads.js. It will never touch
//   other bucket namespaces.

import process from 'process';

const DRY_RUN = process.argv.includes('--dry-run');

// ── Helpers ──────────────────────────────────────────────────────────────────

function opaqueKeyFromObjectName(name) {
  const m = name.match(/^design-visit-images\/([A-Za-z0-9_-]{16,}\.[a-z0-9]{1,8})$/);
  if (!m) return null;
  return `obj:${m[1]}`;
}

// ── DB: collect referenced keys ───────────────────────────────────────────────

async function getReferencedKeys(db) {
  const res = await db.query(
    `SELECT DISTINCT storage_key FROM design_visit_room_images WHERE storage_key LIKE 'obj:%'`
  );
  return new Set(res.rows.map(r => r.storage_key));
}

// ── Bucket: list all design-visit-images objects ──────────────────────────────

async function listBucketKeys(storage) {
  const names = await storage.list('design-visit-images/');
  const keys = [];
  for (const name of names) {
    if (typeof name === 'string') {
      const opaqueKey = opaqueKeyFromObjectName(name);
      if (opaqueKey) keys.push({ name, opaqueKey });
    }
  }
  return keys;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[gc-design-visit-photos] starting${DRY_RUN ? ' (DRY RUN)' : ''}`);

  // DB
  const { default: pg } = await import('pg');
  const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_URL_TEST;
  if (!dbUrl) {
    console.error('[gc-design-visit-photos] DATABASE_URL is not set');
    process.exit(1);
  }
  const db = new pg.Pool({ connectionString: dbUrl, max: 1 });

  // Storage abstraction (auto-selects the backend from STORAGE_BACKEND).
  let storage;
  try {
    const mod = await import('../storage.js');
    storage = mod.default ?? mod;
  } catch (e) {
    console.error('[gc-design-visit-photos] Object Storage unavailable:', e.message);
    await db.end();
    process.exit(1);
  }

  try {
    console.log('[gc-design-visit-photos] fetching referenced keys from DB…');
    const referenced = await getReferencedKeys(db);
    console.log(`[gc-design-visit-photos] ${referenced.size} key(s) referenced in DB`);

    console.log('[gc-design-visit-photos] listing bucket objects…');
    const bucketObjects = await listBucketKeys(storage);
    console.log(`[gc-design-visit-photos] ${bucketObjects.length} opaque object(s) in bucket`);

    const orphans = bucketObjects.filter(o => !referenced.has(o.opaqueKey));
    console.log(`[gc-design-visit-photos] ${orphans.length} orphaned object(s) found`);

    if (orphans.length === 0) {
      console.log('[gc-design-visit-photos] nothing to clean up');
      return;
    }

    let deleted = 0;
    let failed = 0;
    for (const o of orphans) {
      if (DRY_RUN) {
        console.log(`[gc-design-visit-photos] DRY RUN would delete: ${o.name}`);
      } else {
        try {
          await storage.deleteObject(o.name, { ignoreNotFound: true });
          console.log(`[gc-design-visit-photos] deleted: ${o.name}`);
          deleted++;
        } catch (e) {
          console.warn(`[gc-design-visit-photos] failed to delete ${o.name}: ${e.message}`);
          failed++;
        }
      }
    }

    if (!DRY_RUN) {
      console.log(`[gc-design-visit-photos] done — deleted=${deleted} failed=${failed}`);
    } else {
      console.log(`[gc-design-visit-photos] dry run complete — ${orphans.length} would be deleted`);
    }
  } finally {
    await db.end();
  }
}

main().catch(e => {
  console.error('[gc-design-visit-photos] fatal:', e.message);
  process.exit(1);
});
