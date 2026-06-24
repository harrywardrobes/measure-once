#!/usr/bin/env node
// scripts/migrate-objects.mjs
//
// One-off migration script: mirrors every object in the live object-storage
// bucket (read through storage.js's default Replit backend) into a destination
// Google Cloud Storage bucket, preserving object names exactly. Part of the
// GCP stand-up that runs *alongside* the existing Replit deployment — it never
// touches production, never mutates the source, and performs no DB access.
//
// Usage:
//   DEST_GCS_BUCKET=my-bucket node scripts/migrate-objects.mjs
//   DEST_GCS_BUCKET=my-bucket node scripts/migrate-objects.mjs --prefix=design-visit-images/
//   node scripts/migrate-objects.mjs --dry-run
//   DEST_GCS_BUCKET=my-bucket node scripts/migrate-objects.mjs --dry-run
//
// Options:
//   --dry-run      List what would be copied; write nothing. DEST_GCS_BUCKET is
//                  not required in this mode.
//   --prefix=<p>   Scope the run to object names starting with <p>.
//
// Environment:
//   DEST_GCS_BUCKET    (required unless --dry-run) destination GCS bucket name.
//   COPY_CONCURRENCY   parallel copy workers (default 8).
//   STORAGE_BACKEND    must be unset or 'replit'. The script reads the SOURCE
//                      through storage.js's default Replit backend; running with
//                      STORAGE_BACKEND=gcs would point the source at GCS too and
//                      risk reading and writing the same bucket, so it refuses.
//
// Run environment:
//   The SOURCE bucket is wired in automatically when this runs in the Replit
//   shell (the default `replit` backend reads it from .replit). The DESTINATION
//   uses Google Cloud Application Default Credentials (ADC) — run
//   `gcloud auth application-default login` (or attach a service account) and
//   set DEST_GCS_BUCKET before invoking. No key files, no hardcoded secrets.
//
// Idempotent / resumable:
//   For each object the destination is checked via getMetadata(); an object is
//   skipped when its name AND byte size already match. A re-run therefore only
//   copies objects that are missing or whose size differs. Source objects are
//   never deleted or mutated.

import process from 'process';

const DRY_RUN = process.argv.includes('--dry-run');
const PREFIX_ARG = process.argv.find(a => a.startsWith('--prefix='));
const PREFIX = PREFIX_ARG ? PREFIX_ARG.slice('--prefix='.length) : undefined;
const CONCURRENCY = Math.max(1, parseInt(process.env.COPY_CONCURRENCY || '8', 10) || 8);

const LOG = '[migrate-objects]';

// ── Guards ────────────────────────────────────────────────────────────────────

function assertReplitSourceBackend() {
  const backend = (process.env.STORAGE_BACKEND || 'replit').toLowerCase();
  if (backend !== 'replit' && backend !== '') {
    console.error(
      `${LOG} STORAGE_BACKEND=${process.env.STORAGE_BACKEND} — refusing to run. ` +
      'This script reads the SOURCE through the default Replit backend; with ' +
      'STORAGE_BACKEND=gcs it could read and write the same GCS bucket. Unset ' +
      'STORAGE_BACKEND (or set it to "replit") and retry.'
    );
    process.exit(1);
  }
}

// ── Destination (GCS) ─────────────────────────────────────────────────────────

async function getDestBucket() {
  const bucketName = process.env.DEST_GCS_BUCKET;
  if (!bucketName) {
    // Only reached in non-dry-run mode (callers guard dry-run separately).
    console.error(`${LOG} DEST_GCS_BUCKET is not set`);
    process.exit(1);
  }
  const { Storage } = await import('@google-cloud/storage');
  // Application Default Credentials only — no key files.
  const gcs = new Storage();
  return gcs.bucket(bucketName);
}

function isGcsNotFound(e) {
  const code = e && (e.code ?? e.statusCode);
  return code === 404 || code === '404';
}

// Returns the destination object byte size, or null if it does not exist.
async function destSize(bucket, name) {
  try {
    const [meta] = await bucket.file(name).getMetadata();
    const size = meta && meta.size != null ? Number(meta.size) : null;
    return Number.isFinite(size) ? size : null;
  } catch (e) {
    if (isGcsNotFound(e)) return null;
    throw e;
  }
}

// ── Per-object copy ─────────────────────────────────────────────────────────

// Returns 'skipped' | 'copied'. Throws on failure.
async function handleOne(storage, bucket, name) {
  // Idempotency: probe the destination FIRST. When it already holds an object
  // of identical byte size, skip without ever downloading from source. In
  // dry-run with a DEST_GCS_BUCKET set we still probe so the plan reflects true
  // would-copy vs would-skip; without a dest bucket (pure listing dry-run) we
  // treat everything as a would-copy.
  if (bucket) {
    const existing = await destSize(bucket, name);
    if (existing != null) {
      // Sizes can only be compared by reading the source, so download once here
      // and reuse the buffer below if a copy turns out to be needed.
      const probe = await storage.downloadBytes(name);
      if (probe == null) {
        throw new Error('source object disappeared or returned no bytes');
      }
      if (existing === probe.length) {
        if (DRY_RUN) console.log(`${LOG} DRY RUN would skip (match): ${name} (${probe.length} bytes)`);
        return 'skipped';
      }
      if (DRY_RUN) {
        console.log(`${LOG} DRY RUN would copy (size differs): ${name} (${probe.length} bytes)`);
        return 'copied';
      }
      await bucket.file(name).save(probe, { resumable: false });
      const w = await destSize(bucket, name);
      if (w !== probe.length) {
        throw new Error(`size mismatch after copy: source=${probe.length} dest=${w == null ? 'missing' : w}`);
      }
      console.log(`${LOG} copied: ${name} (${probe.length} bytes)`);
      return 'copied';
    }
  }

  const buf = await storage.downloadBytes(name);
  if (buf == null) {
    throw new Error('source object disappeared or returned no bytes');
  }
  const srcSize = buf.length;

  if (DRY_RUN) {
    console.log(`${LOG} DRY RUN would copy: ${name} (${srcSize} bytes)`);
    return 'copied';
  }

  await bucket.file(name).save(buf, { resumable: false });

  const written = await destSize(bucket, name);
  if (written !== srcSize) {
    throw new Error(
      `size mismatch after copy: source=${srcSize} dest=${written == null ? 'missing' : written}`
    );
  }
  console.log(`${LOG} copied: ${name} (${srcSize} bytes)`);
  return 'copied';
}

// ── Concurrency runner ────────────────────────────────────────────────────────

async function runPool(items, limit, worker) {
  let index = 0;
  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    runners.push((async () => {
      while (index < items.length) {
        const myIndex = index++;
        await worker(items[myIndex]);
      }
    })());
  }
  await Promise.all(runners);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `${LOG} starting${DRY_RUN ? ' (DRY RUN)' : ''}` +
    `${PREFIX ? ` prefix=${PREFIX}` : ''} concurrency=${CONCURRENCY}`
  );

  assertReplitSourceBackend();

  // Source storage abstraction (default Replit backend).
  let storage;
  try {
    const mod = await import('../storage.js');
    storage = mod.default ?? mod;
  } catch (e) {
    console.error(`${LOG} source Object Storage unavailable:`, e.message);
    process.exit(1);
  }

  // Destination bucket (skipped entirely in dry-run so it needs no credentials).
  let bucket = null;
  if (!DRY_RUN) {
    bucket = await getDestBucket();
  }

  console.log(`${LOG} listing source objects…`);
  const names = await storage.list(PREFIX);
  console.log(`${LOG} ${names.length} source object(s)${PREFIX ? ` under ${PREFIX}` : ''}`);

  let copied = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];

  await runPool(names, CONCURRENCY, async (name) => {
    try {
      const result = await handleOne(storage, bucket, name);
      if (result === 'copied') copied++;
      else skipped++;
    } catch (e) {
      failed++;
      failures.push(name);
      console.warn(`${LOG} FAILED ${name}: ${e.message}`);
    }
  });

  console.log(
    `${LOG} ${DRY_RUN ? 'dry run ' : ''}summary — ` +
    `total=${names.length} copied=${copied} skipped=${skipped} failed=${failed}`
  );
  if (failures.length) {
    console.log(`${LOG} failed objects:`);
    for (const n of failures) console.log(`${LOG}   ${n}`);
  }

  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(`${LOG} fatal:`, e.message);
  process.exit(1);
});
