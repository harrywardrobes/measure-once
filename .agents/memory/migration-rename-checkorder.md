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

## runNames is ordered by (run_on, id) — renaming is NOT always enough
`getRunMigrations` issues `SELECT name FROM pgmigrations ORDER BY run_on, id`. So `runNames` is the **application order**, not raw id order. When several rows share an identical `run_on` (e.g. a batch applied in one transaction), the `id` tiebreak decides — and that can disagree with the filename sort order even when every name is already correct.

**Symptom:** boot aborts with `Not run migration <A> is preceding already run migration <B>` where BOTH rows already exist in pgmigrations with correct names. Renaming can't fix this because the names are fine; the **run order** is wrong.

**This codebase's chosen remedy is to RENAME the file/record, not touch `run_on`.** When a migration was applied last (highest id / latest in run order) but its filename sorts earlier, bump its filename timestamp so file-sort order matches the actual run order, and add the rename pair to `MIGRATION_RENAMES`. Example: `contact-attempt-history-notes` was applied after the structured-address migrations, so its file was renamed `1782900000000 → 1782900000003` to sit after them.

Avoid hacking `run_on` to reorder rows — it competes with the file-rename approach and a later upstream rename can invert the two, re-breaking checkOrder. Keep one source of truth: filename order == run order, healed via `MIGRATION_RENAMES`.

## Reference
The `applyMigrationRenames` function in `db-migrate.js` runs idempotently before `runner()` — it uses `UPDATE … WHERE name = $1 AND NOT EXISTS (SELECT 1 … WHERE name = $2)` so double-boots are safe.

## Cross-task timestamp collision (dev DB emergency fix)
When two task agents independently pick timestamps, one can land a migration at e.g. `1782900000000` while another task agent (merged later) renames its files to `1782900000001`/`1782900000002`. The dev DB may have applied `1782900000000` after the 00001/00002 entries (different DB IDs), so the filename sort order disagrees with DB insertion order → checkOrder fails.

**Emergency dev-DB fix (no code change needed if MIGRATION_RENAMES already handles prod):**
1. Check which migrations are in DB but with a filename that now sorts in the wrong position relative to their DB ID.
2. If the out-of-order file is NOT YET RUN on prod (i.e. it's a dev-only issue), rename the file to a timestamp that puts it AFTER the already-applied ones, then update the pgmigrations name to match:
   ```
   UPDATE pgmigrations SET name = '<new_name>' WHERE name = '<old_name>';
   ```
3. If the file IS already tracked by `MIGRATION_RENAMES` in `db-migrate.js`, just update the dev DB row manually — the rename will self-heal on prod at boot.
4. Verify file-sort order matches DB insertion-id order before restarting.
