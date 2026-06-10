---
name: Rate-limit migrations table
description: public.migrations is used by @acpr/rate-limit-postgresql — must never be dropped; db-migrate.js self-heals it.
---

## Rule
Never drop or truncate `public.migrations`. It is **not** Replit's javascript_database tracker — it belongs to `@acpr/rate-limit-postgresql` (via the `postgres-migrations` library) and tracks which of the package's 7 internal SQL files have been applied.

**Why:** If the table is missing, `postgres-migrations` tries to re-run `1-init.sql` and crashes with "relation unique_session_key already exists", bringing the whole server down.

## How to apply
- App migrations that clean up "orphan" tables must explicitly exclude `public.migrations`.
- If it ever loses its records, `ensureRateLimitMigrations()` in `db-migrate.js` re-inserts them idempotently on every boot via `ON CONFLICT (id) DO NOTHING`.
- Hashes are `SHA1(fileName + fileContent)` per `postgres-migrations/dist/migration-file.js`. If `@acpr/rate-limit-postgresql` is upgraded, the hash list in `db-migrate.js` must be updated.
