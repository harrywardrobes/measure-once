---
name: Boot migrations vs Replit publish-diff flow
description: Why prod migrations are now skipped at boot, and what the Replit publish-time diff owns.
---

# Boot-time migrations — production is now skipped

## Resolved: `NODE_ENV === 'production'` gates `runMigrations()` in `server.js`

`runMigrations()` is now guarded with `if (process.env.NODE_ENV !== 'production')`.
In production the schema is owned exclusively by Replit's publish-time dev→prod schema diff.

**Why the guard was added:**
- Production `pgmigrations` was always **empty** (Replit provisions schema externally, not via node-pg-migrate).
- Every prod boot re-ran all 42 migrations against an already-provisioned schema.
- node-pg-migrate dropped columns/constraints (e.g. `DROP COLUMN IF EXISTS substatus_id` cascades the FK) BEFORE Replit's schema diff ran.
- Replit's diff then tried a bare `ALTER TABLE … DROP CONSTRAINT card_action_handler_bindings_substatus_id_fkey` (no IF EXISTS) — constraint was already gone → publish failed.
- Skipping migrations at boot removes the race entirely.

## What Replit's publish diff does

When the user clicks Publish, Replit:
1. Snapshots dev schema and prod schema.
2. Computes a SQL diff (additive + destructive DDL, but WITHOUT data-migration statements).
3. Applies the diff to the production database **before** the new app version starts.
4. Deploys the new app — which boots without running migrations.

Replit's diff handles: CREATE/DROP TABLE, ADD/DROP COLUMN, CREATE/DROP INDEX, ADD/DROP CONSTRAINT.

Replit's diff does NOT handle: INSERT/UPDATE/DELETE data seeding, custom trigger installs, or migration-order-dependent logic.

## How to apply going forward

- **New migrations in dev** → run normally via node-pg-migrate (which only runs in dev/test).
  On next Publish, Replit's diff picks up the structural change and applies it to prod.
- **Data migrations** (INSERT … ON CONFLICT DO NOTHING, UPDATE backfills, etc.):
  These will NOT run automatically in prod. Either:
  a) Accept that prod data is already seeded from the original setup, OR
  b) Make the migration a no-op on an already-seeded DB (ON CONFLICT DO NOTHING is safe).
  New seed data inserted by migrations will be absent in prod until the next time prod DB is reset.
- **Never re-introduce `runMigrations()` in production** without first resolving the race
  with Replit's schema diff.

## Diagnosing prod schema state

Use `executeSql({ environment: 'production' })` (read-only) to inspect the prod schema.
Key indicators seen historically:
- `pgmigrations` empty → schema provisioned by Replit, not node-pg-migrate
- `lead_substatuses` present → remove-substatuses migration never committed
- `contact_attempt_tracking` missing → migrations 16+ never committed

## Dev/test behavior unchanged

In dev (`NODE_ENV=development`) and test (`NODE_ENV=test` or unset), `runMigrations()`
still runs on boot exactly as before.
