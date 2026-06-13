#!/usr/bin/env node
/**
 * scripts/update-migration-baseline.mjs
 *
 * Keeps scripts/migration-name-baseline.json in sync with the current set of
 * migration files in migrations/.
 *
 * Run this whenever you:
 *   • Add a new migration file (so future renames of that file can be detected)
 *   • Rename a migration file + add the [old, new] entry to MIGRATION_RENAMES
 *     (so the new filename is registered in the baseline)
 *
 * After running, commit the updated scripts/migration-name-baseline.json
 * alongside your migration changes.
 *
 * Usage:
 *   npm run migration:update-baseline
 *
 * What it does:
 *   1. Reads the current baseline from scripts/migration-name-baseline.json.
 *   2. Reads every .js filename (without extension) from migrations/.
 *   3. Adds any filename not already in the baseline.
 *   4. Writes the result back, sorted.
 *   5. Prints a summary of added names.
 *
 * It does NOT remove names from the baseline.  Old names must stay so that
 * check E in check-migration-renames.mjs can detect missing MIGRATION_RENAMES
 * entries for previously-renamed files.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const ROOT         = resolve(__dirname, '..');
const MIGRATIONS   = resolve(ROOT, 'migrations');
const BASELINE_PATH = resolve(ROOT, 'scripts', 'migration-name-baseline.json');

// ── Read existing baseline ────────────────────────────────────────────────

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  if (!Array.isArray(baseline)) throw new Error('baseline is not a JSON array');
} catch {
  // File missing or corrupt — start fresh.
  baseline = [];
}

// ── Read current migration filenames ──────────────────────────────────────

const currentFiles = readdirSync(MIGRATIONS)
  .filter(f => f.endsWith('.js'))
  .map(f => basename(f, '.js'));

// ── Merge ─────────────────────────────────────────────────────────────────

const baselineSet = new Set(baseline);
const added = [];

for (const name of currentFiles) {
  if (!baselineSet.has(name)) {
    baselineSet.add(name);
    added.push(name);
  }
}

// Sort the resulting set for a stable, readable file.
const updated = [...baselineSet].sort();

// ── Write ─────────────────────────────────────────────────────────────────

writeFileSync(BASELINE_PATH, JSON.stringify(updated, null, 2) + '\n', 'utf8');

// ── Report ────────────────────────────────────────────────────────────────

if (added.length === 0) {
  console.log(
    `migration:update-baseline: baseline already up-to-date ` +
    `(${updated.length} names, no new files found)`
  );
} else {
  console.log(
    `migration:update-baseline: added ${added.length} new ` +
    `${added.length === 1 ? 'name' : 'names'} to baseline ` +
    `(now ${updated.length} total):`
  );
  for (const n of added) {
    console.log(`  + ${n}`);
  }
  console.log('\nCommit scripts/migration-name-baseline.json with your migration changes.');
}
