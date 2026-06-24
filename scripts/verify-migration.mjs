#!/usr/bin/env node
// scripts/verify-migration.mjs
//
// Read-only source-vs-destination parity checker for the Replit → Google Cloud
// migration. It NEVER writes, updates, or deletes anything — it only counts and
// compares. Run it during the parallel-run window and again at cutover to prove
// the Cloud SQL database and the GCS media bucket match the live Replit source
// before any traffic is flipped over. See docs/gcp-cutover.md.
//
// Usage:
//   SOURCE_DATABASE_URL=... \
//   DEST_DATABASE_URL=... \
//   DEST_GCS_BUCKET=my-bucket \
//   npm run verify:migration
//
// Environment (all required — the script exits non-zero if any is missing):
//   SOURCE_DATABASE_URL   connection string for the live Replit Postgres source.
//   DEST_DATABASE_URL     connection string for the destination Cloud SQL DB
//                         (e.g. through the Cloud SQL Auth Proxy).
//   DEST_GCS_BUCKET       destination Google Cloud Storage bucket name.
//   STORAGE_BACKEND       must be unset or 'replit'. The SOURCE object count is
//                         read through storage.js's default Replit backend; with
//                         STORAGE_BACKEND=gcs the "source" would point at GCS and
//                         the comparison would be meaningless, so it refuses.
//
// Run environment:
//   Run from the Replit shell so the SOURCE bucket is wired in automatically via
//   .replit (the default `replit` backend). The DESTINATION bucket count uses
//   Google Cloud Application Default Credentials (ADC) — run
//   `gcloud auth application-default login` (or impersonate the runtime service
//   account) before invoking. No key files, no hardcoded secrets.
//
// Exit status:
//   0   every section reported PASS.
//   1   a required env var was missing, a DB table-count mismatched, or a
//       section could not complete.
//
// Strictly read-only: the only DB statements issued are `SELECT count(*)` and a
// read of the pgmigrations name list; the only storage calls are list/getFiles.

import process from 'process';
import { readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const LOG = '[verify-migration]';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// Fixed list of key tables to compare row counts on. These are the real table
// names in the current schema (confirmed against migrations/). `public.migrations`
// is the rate-limit bookkeeping table owned by @acpr/rate-limit-postgresql;
// `pgmigrations` is owned by node-pg-migrate.
const KEY_TABLES = [
  'users',
  'sessions',
  'password_set_tokens',
  'design_visits',
  'customer_info_submissions',
  'photo_review_outcomes',
  'qb_tokens',
  'pgmigrations',
  'public.migrations',
];

// ── Env guards ────────────────────────────────────────────────────────────────

function requireEnv() {
  const missing = [];
  for (const name of ['SOURCE_DATABASE_URL', 'DEST_DATABASE_URL', 'DEST_GCS_BUCKET']) {
    if (!process.env[name]) missing.push(name);
  }
  if (missing.length) {
    console.error(`${LOG} missing required env var(s): ${missing.join(', ')}`);
    process.exit(1);
  }
}

function assertReplitSourceBackend() {
  const backend = (process.env.STORAGE_BACKEND || 'replit').toLowerCase();
  if (backend !== 'replit' && backend !== '') {
    console.error(
      `${LOG} STORAGE_BACKEND=${process.env.STORAGE_BACKEND} — refusing to run. ` +
      'The SOURCE object count is read through the default Replit backend; with ' +
      'STORAGE_BACKEND=gcs the "source" would point at GCS and the comparison ' +
      'would be meaningless. Unset STORAGE_BACKEND (or set it to "replit").'
    );
    process.exit(1);
  }
}

// ── Section 1: DB row-count parity ─────────────────────────────────────────────

// Safe to interpolate: table names come ONLY from the hardcoded KEY_TABLES list
// above, never from user input. Each name may be schema-qualified (a.b).
function quoteQualified(name) {
  return name
    .split('.')
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join('.');
}

async function countTable(pool, table) {
  const res = await pool.query(`SELECT count(*)::bigint AS n FROM ${quoteQualified(table)}`);
  return res.rows[0].n; // bigint comes back as a string; compared as a string.
}

async function checkDbParity(pg) {
  console.log(`${LOG} ── Section 1: DB row-count parity ──`);
  const sourcePool = new pg.Pool({ connectionString: process.env.SOURCE_DATABASE_URL, max: 1 });
  const destPool = new pg.Pool({ connectionString: process.env.DEST_DATABASE_URL, max: 1 });

  let mismatches = 0;
  try {
    for (const table of KEY_TABLES) {
      let srcCount = null;
      let dstCount = null;
      let srcErr = null;
      let dstErr = null;
      try { srcCount = await countTable(sourcePool, table); } catch (e) { srcErr = e.message; }
      try { dstCount = await countTable(destPool, table); } catch (e) { dstErr = e.message; }

      if (srcErr || dstErr) {
        mismatches++;
        console.log(
          `${LOG}   FAIL ${table}: ` +
          `source=${srcErr ? `ERROR(${srcErr})` : srcCount} ` +
          `dest=${dstErr ? `ERROR(${dstErr})` : dstCount}`
        );
        continue;
      }

      if (srcCount === dstCount) {
        console.log(`${LOG}   OK   ${table}: ${srcCount}`);
      } else {
        mismatches++;
        console.log(`${LOG}   FAIL ${table}: source=${srcCount} dest=${dstCount}`);
      }
    }
  } finally {
    await sourcePool.end();
    await destPool.end();
  }

  const pass = mismatches === 0;
  console.log(`${LOG} Section 1 ${pass ? 'PASS' : 'FAIL'} — ${mismatches} mismatch(es) across ${KEY_TABLES.length} table(s)`);
  return pass;
}

// ── Section 2: object-count parity ─────────────────────────────────────────────

async function countSourceObjects(storage) {
  // Full bucket listing through the default Replit backend (no prefix).
  const names = await storage.list();
  return names.length;
}

async function countDestObjects(bucketName) {
  const { Storage } = await import('@google-cloud/storage');
  // Application Default Credentials only — no key files.
  const gcs = new Storage();
  const bucket = gcs.bucket(bucketName);
  let total = 0;
  let pageToken;
  do {
    const [files, nextQuery] = await bucket.getFiles({
      autoPaginate: false,
      maxResults: 1000,
      pageToken,
    });
    total += files.length;
    pageToken = nextQuery && nextQuery.pageToken;
  } while (pageToken);
  return total;
}

async function checkObjectParity(storage) {
  console.log(`${LOG} ── Section 2: object-count parity ──`);
  let srcCount = null;
  let dstCount = null;
  try {
    srcCount = await countSourceObjects(storage);
  } catch (e) {
    console.log(`${LOG}   FAIL source listing: ${e.message}`);
    console.log(`${LOG} Section 2 FAIL`);
    return false;
  }
  try {
    dstCount = await countDestObjects(process.env.DEST_GCS_BUCKET);
  } catch (e) {
    console.log(`${LOG}   FAIL destination listing: ${e.message}`);
    console.log(`${LOG} Section 2 FAIL`);
    return false;
  }

  console.log(`${LOG}   source (Replit) objects:        ${srcCount}`);
  console.log(`${LOG}   dest   (gs://${process.env.DEST_GCS_BUCKET}) objects: ${dstCount}`);

  const pass = srcCount === dstCount;
  if (!pass) {
    console.log(`${LOG}   note: counts differ by ${Math.abs(srcCount - dstCount)} — re-run migrate:objects to resolve.`);
  }
  console.log(`${LOG} Section 2 ${pass ? 'PASS' : 'FAIL'} — source=${srcCount} dest=${dstCount}`);
  return pass;
}

// ── Section 3: migration-bookkeeping drift ─────────────────────────────────────

async function listMigrationFileNames() {
  const entries = await readdir(MIGRATIONS_DIR);
  // node-pg-migrate records migration names without the file extension.
  return entries
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.replace(/\.js$/, ''))
    .sort();
}

async function listDestAppliedMigrations(pg) {
  const pool = new pg.Pool({ connectionString: process.env.DEST_DATABASE_URL, max: 1 });
  try {
    // Fail closed if the table is absent — that itself is drift worth reporting.
    const { rows: reg } = await pool.query(`SELECT to_regclass('public.pgmigrations'::text) AS tbl`);
    if (!reg[0].tbl) return null;
    const { rows } = await pool.query(`SELECT name FROM pgmigrations`);
    return new Set(rows.map((r) => r.name));
  } finally {
    await pool.end();
  }
}

async function checkMigrationDrift(pg) {
  console.log(`${LOG} ── Section 3: migration-bookkeeping drift ──`);
  const files = await listMigrationFileNames();
  const applied = await listDestAppliedMigrations(pg);

  if (applied === null) {
    console.log(`${LOG}   FAIL pgmigrations table is missing in DEST — restore did not bring it across.`);
    console.log(`${LOG} Section 3 FAIL`);
    return false;
  }

  const notApplied = files.filter((name) => !applied.has(name));
  console.log(`${LOG}   ${files.length} migration file(s) in migrations/`);
  console.log(`${LOG}   ${applied.size} migration row(s) recorded in DEST pgmigrations`);

  if (notApplied.length === 0) {
    console.log(`${LOG}   OK — every migration file is recorded as applied in DEST.`);
    console.log(`${LOG} Section 3 PASS`);
    return true;
  }

  console.log(`${LOG}   ${notApplied.length} migration file(s) NOT recorded as applied in DEST:`);
  for (const name of notApplied) console.log(`${LOG}     - ${name}`);
  console.log(`${LOG}   See the pgmigrations pre-flight in docs/gcp-cutover.md before running db:migrate.`);
  console.log(`${LOG} Section 3 FAIL`);
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${LOG} starting (read-only)`);
  requireEnv();
  assertReplitSourceBackend();

  const { default: pg } = await import('pg');

  let storage;
  try {
    const mod = await import('../storage.js');
    storage = mod.default ?? mod;
  } catch (e) {
    console.error(`${LOG} source Object Storage unavailable: ${e.message}`);
    process.exit(1);
  }

  const dbPass = await checkDbParity(pg);
  const objPass = await checkObjectParity(storage);
  const migPass = await checkMigrationDrift(pg);

  console.log(`${LOG} ── Summary ──`);
  console.log(`${LOG}   Section 1 (DB row counts):        ${dbPass ? 'PASS' : 'FAIL'}`);
  console.log(`${LOG}   Section 2 (object counts):        ${objPass ? 'PASS' : 'FAIL'}`);
  console.log(`${LOG}   Section 3 (migration bookkeeping): ${migPass ? 'PASS' : 'FAIL'}`);

  // Exit non-zero on any DB table-count mismatch (the contract). Sections 2 and 3
  // also fail the run so the operator cannot miss object or bookkeeping drift.
  const allPass = dbPass && objPass && migPass;
  console.log(`${LOG} ${allPass ? 'ALL CHECKS PASSED' : 'CHECKS FAILED — do not cut over'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(`${LOG} fatal:`, e.message);
  process.exit(1);
});
