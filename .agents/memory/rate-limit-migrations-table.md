---
name: Rate-limit migrations table
description: public.migrations is used by @acpr/rate-limit-postgresql — must never be dropped; db-migrate.js self-heals it on every boot including production.
---

## Rule
Never drop or truncate `public.migrations`. It is **not** Replit's javascript_database tracker — it belongs to `@acpr/rate-limit-postgresql` (via the `postgres-migrations` library) and tracks which of the package's 7 internal SQL files have been applied.

**Why:** Replit's publish-time schema diff recreates `public.migrations` with only the `create-migrations-table` sentinel row. On the next boot, `postgres-migrations` sees rows 1-7 as unapplied and tries to re-run `1-init.sql`, crashing with "relation unique_session_key already exists".

## How to apply
- App migrations that clean up "orphan" tables must explicitly exclude `public.migrations`.
- `ensureRateLimitMigrations()` in `db-migrate.js` re-inserts the 7 rows idempotently (`ON CONFLICT (id) DO NOTHING`) on every boot — **including production**. In production, it is called directly in the `else` branch of the boot sequence in `server.js` (the branch that skips node-pg-migrate). In dev it is called from inside `runMigrations()`.
- Hashes are `SHA1(fileName + fileContent)` per `postgres-migrations/dist/migration-file.js`. If `@acpr/rate-limit-postgresql` is upgraded, the hash list in `db-migrate.js` must be updated.
