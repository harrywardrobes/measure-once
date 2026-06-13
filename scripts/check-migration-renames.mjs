#!/usr/bin/env node
/**
 * scripts/check-migration-renames.mjs
 *
 * Static lint: validates that the MIGRATION_RENAMES array in db-migrate.js is
 * consistent with the actual migration filenames in migrations/, and that the
 * committed name baseline covers every historically-applied migration name so
 * silent rename omissions are caught before they reach a production DB.
 *
 * WHY THIS EXISTS
 * ───────────────
 * node-pg-migrate's checkOrder verifies that the order of migration files on
 * disk matches the order stored in the pgmigrations DB table.  When a
 * migration file is renamed, the MIGRATION_RENAMES array in db-migrate.js must
 * be updated with an [oldName, newName] pair so applyMigrationRenames() can
 * rewrite the DB rows before the order check runs.
 *
 * If someone renames a file but forgets to add the MIGRATION_RENAMES entry,
 * or adds an entry for a rename that was never applied to the file, the
 * mismatch is silent at development time and only surfaces as a boot-time
 * checkOrder crash in staging/production.
 *
 * HOW THE BASELINE CATCHES MISSING ENTRIES
 * ─────────────────────────────────────────
 * scripts/migration-name-baseline.json records every migration name that has
 * ever been the "active" name for a migration (i.e., what pgmigrations would
 * contain on a real database).  It is a committed file updated via:
 *
 *   npm run migration:update-baseline
 *
 * When a migration file is renamed (old → new):
 *   1. The old filename leaves the disk.
 *   2. The new filename appears on the disk.
 *   3. The developer adds [oldName, newName] to MIGRATION_RENAMES.
 *   4. npm run migration:update-baseline adds newName to the baseline.
 *
 * If step 3 is skipped, this check fires:
 *   "Baseline name <oldName> has no current file and is not covered by
 *    MIGRATION_RENAMES — add [<oldName>, <newName>] to db-migrate.js."
 *
 * CHECKS PERFORMED (all purely static — no DB connection needed)
 * ────────────────────────────────────────────────────────────────
 * Checks A–D validate existing MIGRATION_RENAMES entries:
 *
 * A. Missing new-name file (orphan entry)
 *    newName appears in MIGRATION_RENAMES but the corresponding .js file does
 *    not exist in migrations/.  Either the file was renamed again without
 *    updating MIGRATION_RENAMES, the entry was added prematurely, or the
 *    migration was deleted.
 *
 * B. Old name file still present (ghost entry)
 *    oldName appears in MIGRATION_RENAMES but the original .js file is still
 *    present in migrations/.  The file was never actually renamed, so the
 *    MIGRATION_RENAMES entry is misleading.
 *
 * C. Duplicate old names
 *    The same old name appears more than once.  The second entry is dead code.
 *
 * D. Duplicate new names
 *    Two different old names map to the same new name.  At most one can be
 *    correct.
 *
 * Check E validates the name baseline:
 *
 * E. Baseline name has no coverage (the primary failure mode)
 *    A name in migration-name-baseline.json does not match any current file
 *    in migrations/ AND is not listed as an oldName in MIGRATION_RENAMES.
 *    This means a migration was almost certainly renamed on disk without the
 *    required MIGRATION_RENAMES entry — which would cause a boot-time
 *    checkOrder crash against any database that recorded the old name.
 *
 * Check F guards the baseline against stale entries:
 *
 * F. Current migration file missing from baseline
 *    A .js file in migrations/ is not recorded in migration-name-baseline.json.
 *    Run `npm run migration:update-baseline` to add it, then commit the result.
 *    Without this, future renames of that file cannot be caught by check E.
 *
 * Usage:
 *   node scripts/check-migration-renames.mjs    # exits 1 on any violation
 *
 * Wired into CI via: npm run test:migration-renames
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT        = resolve(__dirname, '..');
const DB_MIGRATE  = resolve(ROOT, 'db-migrate.js');
const MIGRATIONS  = resolve(ROOT, 'migrations');
const BASELINE_PATH = resolve(ROOT, 'scripts', 'migration-name-baseline.json');

// ── Parse MIGRATION_RENAMES from db-migrate.js ────────────────────────────

const src = readFileSync(DB_MIGRATE, 'utf8');
const arrayMatch = src.match(/const MIGRATION_RENAMES\s*=\s*(\[[\s\S]*?\]);/);
if (!arrayMatch) {
  console.error(
    '❌  check-migration-renames: could not locate MIGRATION_RENAMES array ' +
    'in db-migrate.js.  Has the variable been renamed?'
  );
  process.exit(1);
}

const renames = [];
const pairRe  = /\[\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\]/g;
for (const m of arrayMatch[1].matchAll(pairRe)) {
  renames.push([m[1], m[2]]);
}

// ── Load name baseline ────────────────────────────────────────────────────

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  if (!Array.isArray(baseline)) throw new Error('baseline is not a JSON array');
} catch (err) {
  console.error(
    '❌  check-migration-renames: failed to read scripts/migration-name-baseline.json:\n' +
    `    ${err.message}\n` +
    '    Run `npm run migration:update-baseline` to create or repair it.'
  );
  process.exit(1);
}

// ── Build file set ────────────────────────────────────────────────────────

const migrationFiles = new Set(
  readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.js'))
    .map(f => basename(f, '.js'))
);

// ── Run checks ────────────────────────────────────────────────────────────

const violations = [];

const seenOld = new Map(); // oldName → index
const seenNew = new Map(); // newName → index

// Checks A–D: validate existing MIGRATION_RENAMES entries.

for (let i = 0; i < renames.length; i++) {
  const entry = renames[i];

  if (!Array.isArray(entry) || entry.length !== 2 ||
      typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
    violations.push(
      `  [A] Entry ${i}: malformed — expected [oldName, newName] string pair, ` +
      `got: ${JSON.stringify(entry)}`
    );
    continue;
  }

  const [oldName, newName] = entry;

  // Check A: newName file must exist in migrations/
  if (!migrationFiles.has(newName)) {
    violations.push(
      `  [A] Entry ${i} (${oldName} → ${newName}):\n` +
      `      New file "migrations/${newName}.js" does not exist.\n` +
      `      Either the file was renamed again without updating MIGRATION_RENAMES,\n` +
      `      or this entry is stale and should be removed.`
    );
  }

  // Check B: oldName file must NOT exist in migrations/ (rename must be complete)
  if (migrationFiles.has(oldName)) {
    violations.push(
      `  [B] Entry ${i} (${oldName} → ${newName}):\n` +
      `      Old file "migrations/${oldName}.js" still exists.\n` +
      `      Either rename the file on disk or remove this MIGRATION_RENAMES entry.`
    );
  }

  // Check C: duplicate old names
  if (seenOld.has(oldName)) {
    violations.push(
      `  [C] Entry ${i} (${oldName} → ${newName}):\n` +
      `      Duplicate old name "${oldName}" — also appears at entry ${seenOld.get(oldName)}.\n` +
      `      Only one MIGRATION_RENAMES entry per old name is valid.`
    );
  } else {
    seenOld.set(oldName, i);
  }

  // Check D: duplicate new names
  if (seenNew.has(newName)) {
    violations.push(
      `  [D] Entry ${i} (${oldName} → ${newName}):\n` +
      `      Duplicate new name "${newName}" — also targeted by entry ${seenNew.get(newName)}.\n` +
      `      At most one old name can map to a given new name.`
    );
  } else {
    seenNew.set(newName, i);
  }
}

// Check E: baseline name without coverage.
//
// Every name in the baseline that is NOT a current file must appear as an
// oldName in MIGRATION_RENAMES.  A gap here means a file was renamed on disk
// without the required MIGRATION_RENAMES entry.

const oldNameSet = new Set(renames.map(([old]) => old));

for (const name of baseline) {
  if (migrationFiles.has(name)) continue;  // still a current file → fine
  if (oldNameSet.has(name)) continue;       // covered by a rename entry → fine
  violations.push(
    `  [E] Baseline name "${name}" is not a current migration file and has no\n` +
    `      MIGRATION_RENAMES entry covering it.\n` +
    `      Was "migrations/${name}.js" renamed without updating MIGRATION_RENAMES?\n` +
    `      If so, add ["${name}", "<new_filename_without_ext>"] to MIGRATION_RENAMES\n` +
    `      in db-migrate.js, then run: npm run migration:update-baseline`
  );
}

// Check F: current migration file missing from baseline.
//
// Every file in migrations/ should be in the baseline so future renames can
// be caught by check E.  Run `npm run migration:update-baseline` to fix this.

const baselineSet = new Set(baseline);

for (const name of migrationFiles) {
  // A file counts as "known" even if it's only reachable as a newName in
  // MIGRATION_RENAMES (e.g. a freshly-committed renamed file before the
  // developer has run update-baseline).
  if (baselineSet.has(name)) continue;
  violations.push(
    `  [F] Migration file "migrations/${name}.js" is not in the name baseline.\n` +
    `      Run: npm run migration:update-baseline\n` +
    `      Then commit the updated scripts/migration-name-baseline.json.`
  );
}

// ── Report ────────────────────────────────────────────────────────────────

const fileCount    = migrationFiles.size;
const entryCount   = renames.length;
const baselineSize = baseline.length;

console.log(
  `check-migration-renames: ${entryCount} MIGRATION_RENAMES ${entryCount === 1 ? 'entry' : 'entries'}, ` +
  `${fileCount} migration files, ${baselineSize} baseline names\n`
);

if (violations.length === 0) {
  console.log(
    `✓ All checks passed.\n` +
    `  • Every MIGRATION_RENAMES newName file exists; no oldName file lingers; no duplicates.\n` +
    `  • Every baseline name is either a current file or covered by MIGRATION_RENAMES.\n` +
    `  • Every migration file is registered in the baseline.`
  );
  process.exit(0);
}

console.error(`✗ ${violations.length} ${violations.length === 1 ? 'violation' : 'violations'} found:\n`);
for (const v of violations) {
  console.error(v + '\n');
}
console.error(
  'See the script header for details on each check (A–F).\n' +
  'After fixing MIGRATION_RENAMES, run: npm run migration:update-baseline\n' +
  'and commit the updated scripts/migration-name-baseline.json.'
);
process.exit(1);
