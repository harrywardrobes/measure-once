---
name: Schema migration parity vs legacy orphan schema
description: When verifying that node-pg-migrate baseline migrations match the old ensureXTable DDL, the dev/prod DB contains orphan tables/columns from removed code that must be excluded from parity checks.
---

# Schema migration parity check

The authoritative way to verify baseline migrations reproduce the old
`ensureXTable()` schema: dump the existing DB schema (built by the old ensure
funcs over prior boots) as the "golden" reference, build a fresh DB by running
the migrations, and diff `information_schema.columns` / `pg_indexes` /
`pg_constraint` (not just the pg_dump text).

**Why:** manual "verbatim copy" of DDL silently misses statements — e.g. the
auth bootstrap created `admin_audit_log`, `role_permissions`, `nav_role_configs`
(+seeds) and extra `users` columns far below the first CREATE block, which a
partial read missed.

**Legacy orphans — expected golden-only diffs, do NOT add to migrations:**
- Tables `db_editor_audit` and `migrations` (an old custom migration table; note
  node-pg-migrate uses `pgmigrations`, no collision) — created by removed
  features, zero references in current code.
- Column `app_settings.updated_at` — current source creates app_settings with
  only `key`+`value`; the column is a leftover from removed code.
- `nav_role_configs.primary_keys` default in golden is the stale
  `["home","calendar","trades"]`; current source uses
  `["home","customers","projects"]`. Migration matches current source; golden is
  stale because CREATE TABLE IF NOT EXISTS never alters an existing default.

**How to apply:** parity = "migrations produce what the CURRENT ensure code would
build on a fresh DB", not "match the dirty dev DB exactly". Exclude the orphans
above and the intended new sync additions (updated_at/version cols, triggers,
new indexes, pgmigrations table) when reading the diff.
