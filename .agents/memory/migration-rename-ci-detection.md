---
name: Migration rename CI detection
description: How the baseline manifest pattern catches missing MIGRATION_RENAMES entries in CI without DB access.
---

# Migration rename CI detection

## The rule
After adding or renaming any migration file, run `npm run migration:update-baseline` and commit `scripts/migration-name-baseline.json` alongside the change.

## Why
A missing MIGRATION_RENAMES entry for a renamed file causes a silent checkOrder crash at boot on any DB that recorded the old name. Static analysis alone can't detect this without historical knowledge of which names were ever in pgmigrations. The baseline manifest provides that history.

## How to apply
- `scripts/migration-name-baseline.json` — committed JSON array of every name that has ever been active in pgmigrations (current filenames + all old names from MIGRATION_RENAMES history).
- `scripts/check-migration-renames.mjs` — six checks (A–F); check E is the key one: a baseline name that's not a current file and not in MIGRATION_RENAMES fires immediately.
- `scripts/update-migration-baseline.mjs` — adds new filenames to baseline without removing old ones (old names must stay for check E to work).
- `test/migration-renames/run.js` — DB-backed probe via with-test-db.js; P2 simulates old-name rows, P3 verifies detection fires for an uncovered name.

## Constraint
The update-migration-baseline script silently resets to `[]` on baseline corruption. If the file is accidentally deleted, historical names are lost and check E can't fire for future renames. The code reviewer noted this as a reliability footgun — consider hardening if it becomes an issue.
