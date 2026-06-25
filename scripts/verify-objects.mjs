#!/usr/bin/env node
// scripts/verify-objects.mjs
//
// Opt-in, READ-ONLY spot-check that objects in the configured GCS bucket are
// present and actually servable through the app's storage abstraction
// (storage.js) — catching content/key-format regressions or bucket
// misconfiguration that a simple "object exists" check would miss.
//
// What it does: samples a random subset of object names per namespace and
// confirms each one downloads successfully and has non-zero length.
//
//   - customer-info-photos/   (customer-info submission photos)
//   - visit-photos/           (design + survey visit room images)
//
// Usage:
//   GCS_BUCKET=my-bucket npm run verify:objects
//   GCS_BUCKET=my-bucket node scripts/verify-objects.mjs --sample=25
//   GCS_BUCKET=my-bucket node scripts/verify-objects.mjs --prefix=customer-info-photos/
//
// Options:
//   --sample=<n>     Objects to verify PER namespace (default 10). With
//                    --prefix it is the total sample for that single prefix.
//   --prefix=<p>     Restrict verification to one namespace/prefix instead of
//                    the built-in customer-info-photos/ + visit-photos/.
//   --seed=<n>       Deterministic sampling (same seed → same picks).
//
// Environment:
//   GCS_BUCKET       (required) GCS bucket name (read by storage.js).
//   Application Default Credentials must be available for GCS reads
//   (`gcloud auth application-default login` or an attached service account).
//
// Safety: read-only. It downloads objects to verify them; it never uploads,
// deletes, or mutates anything in the bucket, and does no DB access. Exits
// non-zero if any sampled object is missing or empty.

import process from 'process';

const LOG = '[verify-objects]';

const DEFAULT_NAMESPACES = ['customer-info-photos/', 'visit-photos/'];

// ── Args ───────────────────────────────────────────────────────────────────
const SAMPLE_ARG = process.argv.find(a => a.startsWith('--sample='));
const SAMPLE = SAMPLE_ARG ? Math.max(1, parseInt(SAMPLE_ARG.slice('--sample='.length), 10) || 0) : 10;

const PREFIX_ARG = process.argv.find(a => a.startsWith('--prefix='));
const PREFIX = PREFIX_ARG ? PREFIX_ARG.slice('--prefix='.length) : undefined;

const SEED_ARG = process.argv.find(a => a.startsWith('--seed='));
const SEED = SEED_ARG ? (parseInt(SEED_ARG.slice('--seed='.length), 10) || 0) : null;

// ── Guards ───────────────────────────────────────────────────────────────────
function assertConfigured() {
  if (!process.env.GCS_BUCKET) {
    console.error(`${LOG} GCS_BUCKET is not set — required so storage.js can read the bucket.`);
    process.exit(1);
  }
}

// ── Deterministic RNG (mulberry32) for --seed ────────────────────────────────
function makeRng(seed) {
  if (seed == null) return Math.random;
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleNames(names, count, rng) {
  if (names.length <= count) return names.slice();
  // Fisher–Yates partial shuffle.
  const arr = names.slice();
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rng() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, count);
}

// ── Per-namespace verification ───────────────────────────────────────────────
async function verifyNamespace(label, prefix, gcs, rng) {
  console.log(`${LOG} listing objects under ${prefix || '(all)'}…`);
  const all = await gcs.list(prefix);
  console.log(`${LOG} ${label}: ${all.length} object(s)`);

  if (all.length === 0) {
    console.log(`${LOG} ${label}: nothing to verify (no objects).`);
    return { label, total: 0, checked: 0, ok: 0, empty: 0, missing: 0, failures: [] };
  }

  const picks = sampleNames(all, SAMPLE, rng);
  console.log(`${LOG} ${label}: verifying ${picks.length} sampled object(s) via storage.js…`);

  let ok = 0, empty = 0, missing = 0;
  const failures = [];

  for (const name of picks) {
    let buf;
    try {
      buf = await gcs.downloadBytes(name);
    } catch (e) {
      failures.push({ name, reason: `read error: ${e.message}` });
      missing++;
      continue;
    }
    if (buf == null) {
      missing++;
      failures.push({ name, reason: 'missing (storage.js returned null)' });
      continue;
    }
    if (buf.length === 0) {
      empty++;
      failures.push({ name, reason: 'zero-length object' });
      continue;
    }
    ok++;
    console.log(`${LOG} ${label}: OK ${name} (${buf.length} bytes)`);
  }

  return { label, total: all.length, checked: picks.length, ok, empty, missing, failures };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  assertConfigured();

  console.log(
    `${LOG} starting — bucket=${process.env.GCS_BUCKET} ` +
    `sample=${SAMPLE}/namespace${PREFIX ? ` prefix=${PREFIX}` : ''}${SEED != null ? ` seed=${SEED}` : ''}`
  );

  const rng = makeRng(SEED);

  let gcs;
  try {
    const mod = await import('../storage.js');
    gcs = mod.default ?? mod;
  } catch (e) {
    console.error(`${LOG} storage.js unavailable: ${e.message}`);
    process.exit(1);
  }

  const namespaces = PREFIX ? [{ label: PREFIX, prefix: PREFIX }]
    : DEFAULT_NAMESPACES.map(p => ({ label: p, prefix: p }));

  const results = [];
  for (const ns of namespaces) {
    results.push(await verifyNamespace(ns.label, ns.prefix, gcs, rng));
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  let totalChecked = 0, totalOk = 0, totalEmpty = 0, totalMissing = 0;
  console.log(`${LOG} ────────── summary ──────────`);
  for (const r of results) {
    totalChecked += r.checked; totalOk += r.ok; totalEmpty += r.empty; totalMissing += r.missing;
    console.log(
      `${LOG} ${r.label}: total=${r.total} checked=${r.checked} ` +
      `ok=${r.ok} missing=${r.missing} empty=${r.empty}`
    );
  }
  console.log(
    `${LOG} TOTAL: checked=${totalChecked} ok=${totalOk} ` +
    `missing=${totalMissing} empty=${totalEmpty}`
  );

  const allFailures = results.flatMap(r => r.failures);
  if (allFailures.length) {
    console.log(`${LOG} failures:`);
    for (const f of allFailures) console.log(`${LOG}   ${f.name} — ${f.reason}`);
  }

  if (totalChecked === 0) {
    console.error(`${LOG} no objects were checked — nothing in the sampled namespaces. Treating as failure.`);
    process.exit(1);
  }
  if (totalMissing > 0 || totalEmpty > 0) {
    console.error(`${LOG} VERIFICATION FAILED — ${totalMissing} missing, ${totalEmpty} empty.`);
    process.exit(1);
  }
  console.log(`${LOG} VERIFICATION PASSED — all ${totalOk} sampled objects are present and readable.`);
}

main().catch(e => {
  console.error(`${LOG} fatal:`, e.message);
  process.exit(1);
});
