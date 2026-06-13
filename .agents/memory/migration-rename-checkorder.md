---
name: Migration rename + checkOrder constraint
description: How node-pg-migrate checkOrder works and how to fix name/timestamp collisions using MIGRATION_RENAMES in db-migrate.js
---

# node-pg-migrate checkOrder and MIGRATION_RENAMES

## Mandatory rule — apply before finishing any migration rename

**Whenever a migration file is renamed (timestamp or slug changed), you MUST add an entry to the `MIGRATION_RENAMES` array in `db-migrate.js` (lines ~23–60).** Skipping this causes a `checkOrder` boot failure on every database that applied the migration under the old name (dev, CI, and prod).

### Entry format

```js
// MIGRATION_RENAMES in db-migrate.js
const MIGRATION_RENAMES = [
  // One sentence explaining why this rename happened.
  ['old_timestamp_old-slug', 'new_timestamp_new-slug'],
];
```

- The first element is the **exact name stored in `pgmigrations`** (filename without `.js`).
- The second element is the **new filename** (also without `.js`).
- Add a one-line comment above each pair describing *why* the rename was necessary.
- The `applyMigrationRenames` function runs this idempotently before `runner()` — safe on repeated boots.

## Why checkOrder fails without this fix

`checkOrder` does a **positional comparison**:

```js
for (let i = 0; i < Math.min(runNames.length, migrations.length); i++) {
  if (runNames[i] !== migrations[i].name) throw Error(...)
}
```

- `runNames` = migrations already in the DB, **in DB insertion/id order** (fixed after first apply).
- `migrations` = all migration files, sorted **lexicographically by filename** (timestamp-first).

If a file is renamed to a different timestamp, DB insertion order can diverge from filename sort order, causing a permanent positional mismatch at boot.

## Cascade: rename ALL affected siblings

If one migration's timestamp is bumped UP, every migration that was DB-inserted AFTER it but has a LOWER file-sort timestamp must also be bumped past it — otherwise they still mismatch positionally.

**Steps for a cascade rename:**
1. Identify the "anchor" rename (the file whose timestamp jumped up).
2. Query DB: `SELECT id, name FROM pgmigrations WHERE id > <anchor_id> ORDER BY id` — these are the at-risk siblings.
3. For each sibling whose filename-sort position would now come BEFORE the anchor, bump its timestamp to be AFTER the anchor.
4. Rename (or recreate with IF NOT EXISTS guards) the migration files accordingly.
5. Delete old migration files.
6. Add **all** rename pairs (anchor + siblings) to `MIGRATION_RENAMES`.

## runNames is ordered by (run_on, id) — renaming is NOT always enough
`getRunMigrations` issues `SELECT name FROM pgmigrations ORDER BY run_on, id`. So `runNames` is the **application order**, not raw id order. When several rows share an identical `run_on` (e.g. a batch applied in one transaction), the `id` tiebreak decides — and that can disagree with the filename sort order even when every name is already correct.

**Symptom:** boot aborts with `Not run migration <A> is preceding already run migration <B>` where BOTH rows already exist in pgmigrations with correct names. Renaming can't fix this because the names are fine; the **run order** is wrong.

**This codebase's chosen remedy is to RENAME the file/record, not touch `run_on`.** When a migration was applied last (highest id / latest in run order) but its filename sorts earlier, bump its filename timestamp so file-sort order matches the actual run order, and add the rename pair to `MIGRATION_RENAMES`. Example: `contact-attempt-history-notes` was applied after the structured-address migrations, so its file was renamed `1782900000000 → 1782900000003` to sit after them.

Avoid hacking `run_on` to reorder rows — it competes with the file-rename approach and a later upstream rename can invert the two, re-breaking checkOrder. Keep one source of truth: filename order == run order, healed via `MIGRATION_RENAMES`.

**Why:** DB insertion `id` is fixed. A sibling with a lower filename sort but a higher DB `id` than the anchor will always fail the positional check.

## Reference
The `applyMigrationRenames` function in `db-migrate.js` runs idempotently before `runner()` — it uses `UPDATE … WHERE name = $1 AND NOT EXISTS (SELECT 1 … WHERE name = $2)` so double-boots are safe.

## Cross-task timestamp collision (dev DB emergency fix)

When two task agents independently pick the same timestamp, one can land at e.g. `1782900000000` while another renames its files to `1782900000001`/`1782900000002`. The dev DB may have applied `1782900000000` after the 00001/00002 entries → checkOrder fails.

**Emergency dev-DB fix (no code change needed if MIGRATION_RENAMES already handles prod):**
1. Identify the out-of-order row in `pgmigrations`.
2. If the file is NOT yet applied on prod, rename the file to a timestamp after the already-applied ones, then update the dev DB row manually:
   ```sql
   UPDATE pgmigrations SET name = '<new_name>' WHERE name = '<old_name>';
   ```
3. If it IS tracked by `MIGRATION_RENAMES`, just fix the dev DB row — prod self-heals on boot.
4. Verify filename-sort order matches DB insertion-id order before restarting.

## Reference

- `MIGRATION_RENAMES` array: `db-migrate.js` lines ~23–60
- `applyMigrationRenames` function: `db-migrate.js` lines ~67–95
