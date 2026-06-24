#!/usr/bin/env node
// scripts/verify-objects.mjs
//
// Opt-in, READ-ONLY verification harness for the GCS object migration. The
// copy script (scripts/migrate-objects.mjs) proves each object was written with
// a matching byte size; this script proves the application can actually *serve*
// those objects back through its own storage abstraction (storage.js) once the
// GCS backend is active — catching content/key-format regressions that a pure
// size check would miss.
//
// What it does:
//   1. Reads the DESTINATION (GCS) through storage.js with STORAGE_BACKEND=gcs —
//      the exact path the running app uses to serve photos.
//   2. Reads the SOURCE (live Replit bucket) through a direct
//      @replit/object-storage client (storage.js is locked to the GCS backend
//      in this process, so the source needs its own client).
//   3. Samples a random subset of object names per namespace and confirms the
//      bytes returned from GCS are byte-for-byte identical (SHA-256 + length) to
//      the same name read from Replit.
//
// It samples both namespaces by default so the two distinct key formats are
// each exercised:
//   - customer-info-photos/   (customer-info submission photos)
//   - design-visit-images/    (design-visit room images)
//
// This is the concrete check behind Phase 6/7 verification in
// docs/gcp-migration.md — richer than a `gcloud storage hash` spot-check because
// it goes through storage.js end-to-end.
//
// Usage (from the Replit shell, where the SOURCE bucket is wired in via .replit):
//   STORAGE_BACKEND=gcs GCS_BUCKET=my-bucket npm run verify:objects
//   STORAGE_BACKEND=gcs GCS_BUCKET=my-bucket node scripts/verify-objects.mjs --sample=25
//   STORAGE_BACKEND=gcs GCS_BUCKET=my-bucket node scripts/verify-objects.mjs --prefix=customer-info-photos/
//
// Options:
//   --sample=<n>     Objects to verify PER namespace (default 10). With
//                    --prefix it is the total sample for that single prefix.
//   --prefix=<p>     Restrict verification to one namespace/prefix instead of
//                    the built-in customer-info-photos/ + design-visit-images/.
//   --seed=<n>       Deterministic sampling (same seed → same picks).
//
// Environment:
//   STORAGE_BACKEND  MUST be 'gcs'. This is the whole point: storage.js must be
//                    pointed at the GCS destination so we verify the served path.
//                    The script refuses to run otherwise.
//   GCS_BUCKET       (required) destination GCS bucket name (read by storage.js).
//   Application Default Credentials must be available for GCS reads
//   (`gcloud auth application-default login` or an attached service account).
//
// Safety: read-only. It downloads objects from both buckets and compares them;
// it never uploads, deletes, or mutates anything in either bucket, and does no
// DB access. Exits non-zero if any sampled object is missing from GCS or differs.

import process from 'process';
import crypto from 'crypto';

const LOG = '[verify-objects]';

const DEFAULT_NAMESPACES = ['customer-info-photos/', 'design-visit-images/'];

// ── Args ───────────────────────────────────────────────────────────────────
const SAMPLE_ARG = process.argv.find(a => a.startsWith('--sample='));
const SAMPLE = SAMPLE_ARG ? Math.max(1, parseInt(SAMPLE_ARG.slice('--sample='.length), 10) || 0) : 10;

const PREFIX_ARG = process.argv.find(a => a.startsWith('--prefix='));
const PREFIX = PREFIX_ARG ? PREFIX_ARG.slice('--prefix='.length) : undefined;

const SEED_ARG = process.argv.find(a => a.startsWith('--seed='));
const SEED = SEED_ARG ? (parseInt(SEED_ARG.slice('--seed='.length), 10) || 0) : null;

// ── Guards ───────────────────────────────────────────────────────────────────
function assertGcsBackend() {
  const backend = (process.env.STORAGE_BACKEND || 'replit').toLowerCase();
  if (backend !== 'gcs') {
    console.error(
      `${LOG} STORAGE_BACKEND=${process.env.STORAGE_BACKEND || '(unset)'} — refusing to run. ` +
      'This harness must read the DESTINATION through storage.js with the GCS ' +
      'backend active. Set STORAGE_BACKEND=gcs and GCS_BUCKET=<dest bucket> and retry.'
    );
    process.exit(1);
  }
  if (!process.env.GCS_BUCKET) {
    console.error(`${LOG} GCS_BUCKET is not set — required so storage.js can read the destination.`);
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

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── Direct Replit SOURCE client ──────────────────────────────────────────────
// storage.js is locked to the GCS backend in this process (STORAGE_BACKEND=gcs),
// so the source needs its own Replit client. Mirrors storage.js's replit logic.
async function makeReplitSource() {
  let Client;
  try {
    ({ Client } = await import('@replit/object-storage'));
  } catch (e) {
    console.error(`${LOG} source Object Storage unavailable: ${e.message}`);
    process.exit(1);
  }
  const client = new Client();

  function is404(code, message) {
    return code === 404 || /not\s*found/i.test(String(message || ''));
  }

  return {
    async downloadBytes(name) {
      const res = await client.downloadAsBytes(name);
      if (res && res.ok === false) {
        if (is404(res.error?.statusCode || res.error?.code, res.error?.message)) return null;
        throw new Error('source download failed: ' + (res.error?.message || 'unknown'));
      }
      const value = res?.value;
      const buf = Array.isArray(value) ? value[0] : value;
      return buf || null;
    },
    async list(prefix) {
      const names = [];
      let cursor;
      do {
        const opts = {};
        if (prefix) opts.prefix = prefix;
        if (cursor) opts.cursor = cursor;
        const res = await client.list(opts);
        if (res && res.ok === false) {
          throw new Error('source list failed: ' + (res.error?.message || 'unknown'));
        }
        const objects = res?.value ?? res?.objects ?? [];
        for (const obj of objects) {
          const n = obj.name ?? obj.key ?? obj;
          if (typeof n === 'string') names.push(n);
        }
        cursor = res?.cursor ?? res?.nextCursor ?? null;
      } while (cursor);
      return names;
    },
  };
}

// ── Per-namespace verification ───────────────────────────────────────────────
async function verifyNamespace(label, prefix, source, gcs, rng) {
  console.log(`${LOG} listing source objects under ${prefix || '(all)'}…`);
  const all = await source.list(prefix);
  console.log(`${LOG} ${label}: ${all.length} source object(s)`);

  if (all.length === 0) {
    console.log(`${LOG} ${label}: nothing to verify (no source objects).`);
    return { label, total: 0, checked: 0, ok: 0, mismatch: 0, missing: 0, failures: [] };
  }

  const picks = sampleNames(all, SAMPLE, rng);
  console.log(`${LOG} ${label}: verifying ${picks.length} sampled object(s) via storage.js (gcs)…`);

  let ok = 0, mismatch = 0, missing = 0;
  const failures = [];

  for (const name of picks) {
    let srcBuf, dstBuf;
    try {
      srcBuf = await source.downloadBytes(name);
    } catch (e) {
      failures.push({ name, reason: `source read error: ${e.message}` });
      mismatch++;
      continue;
    }
    if (srcBuf == null) {
      // Source vanished between list and read (object deleted mid-run). Skip it.
      console.warn(`${LOG} ${label}: source object disappeared, skipping: ${name}`);
      continue;
    }

    try {
      dstBuf = await gcs.downloadBytes(name);
    } catch (e) {
      failures.push({ name, reason: `gcs read error: ${e.message}` });
      mismatch++;
      continue;
    }
    if (dstBuf == null) {
      missing++;
      failures.push({ name, reason: 'missing in GCS (storage.js returned null)' });
      continue;
    }

    if (srcBuf.length !== dstBuf.length) {
      mismatch++;
      failures.push({ name, reason: `size differs: source=${srcBuf.length} gcs=${dstBuf.length}` });
      continue;
    }
    const srcHash = sha256(srcBuf);
    const dstHash = sha256(dstBuf);
    if (srcHash !== dstHash) {
      mismatch++;
      failures.push({ name, reason: `content differs: source sha256=${srcHash} gcs sha256=${dstHash}` });
      continue;
    }
    ok++;
    console.log(`${LOG} ${label}: OK ${name} (${srcBuf.length} bytes, sha256 ${srcHash.slice(0, 12)}…)`);
  }

  return { label, total: all.length, checked: picks.length, ok, mismatch, missing, failures };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  assertGcsBackend();

  console.log(
    `${LOG} starting — backend=gcs bucket=${process.env.GCS_BUCKET} ` +
    `sample=${SAMPLE}/namespace${PREFIX ? ` prefix=${PREFIX}` : ''}${SEED != null ? ` seed=${SEED}` : ''}`
  );

  const rng = makeRng(SEED);

  // DESTINATION read path — through storage.js (the app's abstraction, gcs backend).
  let gcs;
  try {
    const mod = await import('../storage.js');
    gcs = mod.default ?? mod;
  } catch (e) {
    console.error(`${LOG} storage.js (gcs) unavailable: ${e.message}`);
    process.exit(1);
  }

  // SOURCE read path — direct Replit client.
  const source = await makeReplitSource();

  const namespaces = PREFIX ? [{ label: PREFIX, prefix: PREFIX }]
    : DEFAULT_NAMESPACES.map(p => ({ label: p, prefix: p }));

  const results = [];
  for (const ns of namespaces) {
    results.push(await verifyNamespace(ns.label, ns.prefix, source, gcs, rng));
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  let totalChecked = 0, totalOk = 0, totalMismatch = 0, totalMissing = 0;
  console.log(`${LOG} ────────── summary ──────────`);
  for (const r of results) {
    totalChecked += r.checked; totalOk += r.ok; totalMismatch += r.mismatch; totalMissing += r.missing;
    console.log(
      `${LOG} ${r.label}: source=${r.total} checked=${r.checked} ` +
      `ok=${r.ok} missing=${r.missing} mismatch=${r.mismatch}`
    );
  }
  console.log(
    `${LOG} TOTAL: checked=${totalChecked} ok=${totalOk} ` +
    `missing=${totalMissing} mismatch=${totalMismatch}`
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
  if (totalMissing > 0 || totalMismatch > 0) {
    console.error(`${LOG} VERIFICATION FAILED — ${totalMissing} missing, ${totalMismatch} mismatched.`);
    process.exit(1);
  }
  console.log(`${LOG} VERIFICATION PASSED — all ${totalOk} sampled objects served from GCS match the Replit source.`);
}

main().catch(e => {
  console.error(`${LOG} fatal:`, e.message);
  process.exit(1);
});
