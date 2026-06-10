'use strict';
// Wrapper for `node-pg-migrate create` that guarantees unique migration
// timestamps even when called multiple times within the same millisecond.
//
// node-pg-migrate's built-in `create` action stamps each file with the current
// wall-clock millisecond, so two rapid invocations can produce identical
// prefixes and collide.  This script:
//   1. Derives the desired timestamp from Date.now().
//   2. Scans migrations/ for any existing file that starts with that value.
//   3. Increments by 1 ms until it finds a slot with no collision.
//   4. Creates the migration file directly using the same minimal template
//      that node-pg-migrate would produce.
//
// Usage (via npm scripts only):
//   node scripts/create-migration.js <migration-name> [--force]
//
// --force   Skip the duplicate-name guard and create the file even if a
//           migration with the same descriptive name already exists.  Use this
//           only when you intentionally need a second migration with the same
//           base name (e.g. a follow-up fix to an already-applied migration).

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

function pickTimestamp() {
  const existing = fs.readdirSync(MIGRATIONS_DIR);
  let ts = Date.now();
  while (existing.some((f) => f.startsWith(String(ts) + '_'))) {
    ts += 1;
  }
  return ts;
}

function createFileExclusive(filepath, content) {
  let ts = pickTimestamp();
  const name = path.basename(filepath).replace(/^\d+_/, '');
  for (;;) {
    const candidate = path.join(MIGRATIONS_DIR, `${ts}_${name}`);
    try {
      fs.writeFileSync(candidate, content, { flag: 'wx', encoding: 'utf8' });
      return candidate;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      ts += 1;
    }
  }
}

function toKebab(name) {
  return name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const args = process.argv.slice(2);
const forceFlag = args.includes('--force');
const rawName = args.filter((a) => a !== '--force').join(' ');
if (!rawName) {
  console.error('Usage: npm run db:migrate:create -- <migration-name> [--force]');
  process.exit(1);
}

const name = toKebab(rawName);

// Sanity-check: warn and abort if a migration with the same descriptive name
// already exists, regardless of its timestamp prefix.  Pass --force to skip.
const existingWithSameName = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(`_${name}.js`));
if (existingWithSameName.length > 0) {
  if (forceFlag) {
    console.warn(
      `Warning: a migration named "${name}" already exists:\n` +
        existingWithSameName.map((f) => `  migrations/${f}`).join('\n') +
        '\nProceeding anyway because --force was passed.'
    );
  } else {
    console.error(
      `Error: a migration named "${name}" already exists:\n` +
        existingWithSameName.map((f) => `  migrations/${f}`).join('\n') +
        '\nRename your migration or pass --force to create it anyway.'
    );
    process.exit(1);
  }
}

const template = `'use strict';

exports.shorthands = undefined;

exports.up = (pgm) => {

};

exports.down = false;
`;

const created = createFileExclusive(
  path.join(MIGRATIONS_DIR, `0_${name}.js`),
  template
);
console.log(`Created migration: migrations/${path.basename(created)}`);
