---
name: Migration rename + checkOrder constraint
description: How node-pg-migrate checkOrder works and how to fix name/timestamp collisions using MIGRATION_RENAMES in db-migrate.js
---

# node-pg-migrate checkOrder and MIGRATION_RENAMES

## The rule
`checkOrder` in node-pg-migrate does a **positional comparison**:

```js
for (let i = 0; i < Math.min(runNames.length, migrations.length); i++) {
  if (runNames[i] !== migrations[i].name) throw Error(...)
}
```

`runNames` = migrations already in the DB, **in DB insertion/id order**.
`migrations` = all migration files, sorted by **filename** (lexicographic, which is timestamp-first).

These two lists must match position-for-position. Any time a migration file is renamed to a different timestamp, DB insertion order can diverge from filename sort order, causing a permanent mismatch.

## The fix pattern: MIGRATION_RENAMES
`db-migrate.js` exposes a `MIGRATION_RENAMES` array. Each entry `[oldName, newName]` causes an `UPDATE pgmigrations SET name = newName WHERE name = oldName` before `runner()` is called.

When a file is renamed (timestamp changed), add an entry here so the DB record is updated to match the new filename before checkOrder runs.

## Critical: rename ALL affected siblings
If one migration's file is renamed to a HIGHER timestamp, every migration that was DB-inserted AFTER it but has a LOWER file-sort timestamp must also be renamed to a timestamp HIGHER than the renamed one. Otherwise they'll still mismatch positionally.

**Why:** DB insertion order (id) is fixed. If file-A has id=122 (inserted first) but filename-sort puts it LAST, and files B–F have ids 123–127 but filename-sort puts them BEFORE file-A, the positional check will fail for all B–F vs their DB positions.

**How to apply:**
1. Identify the "anchor" rename (the file whose timestamp jumped up).
2. Query DB for all pgmigrations rows with id > anchor's id.
3. Rename every row/file whose new file-sort position would come BEFORE the anchor to a timestamp AFTER the anchor.
4. Create new migration files at the renamed timestamps (use IF NOT EXISTS guards so re-runs on prod are safe).
5. Delete old migration files.
6. Add all rename pairs to `MIGRATION_RENAMES` in `db-migrate.js`.

## Reference
The `applyMigrationRenames` function in `db-migrate.js` runs idempotently before `runner()` — it uses `UPDATE … WHERE name = $1 AND NOT EXISTS (SELECT 1 … WHERE name = $2)` so double-boots are safe.
