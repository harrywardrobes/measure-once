---
name: Boot migrations vs Replit publish-diff flow
description: Why prod can crash-loop on boot-time node-pg-migrate, and why every migration must survive a full re-run.
---

# Boot-time migrations conflict with Replit's publish-time schema diff

This app runs `runMigrations()` (node-pg-migrate, `singleTransaction`) on every
server boot (`db-migrate.js`). Replit ALSO manages the production schema via its
publish-time dev→prod schema-diff flow. These two systems fight each other.

## The failure signature
- Production `pgmigrations` tracker is **empty** while the schema is already
  provisioned (by the publish diff) and frozen at an OLD point (whatever dev's
  schema was at the last publish — not necessarily HEAD).
- Because the tracker is empty, every boot re-runs the ENTIRE migration set
  against an already-populated schema. Any non-idempotent statement aborts the
  single transaction → port never opens → healthcheck fails → restart loop.
- Real instance: a migration's `ADD CONSTRAINT ... UNIQUE` collided with a
  pre-existing same-named index (`relation "..." already exists`) because its
  guard only checked `table_constraints`, not the index relation.

**Why:** prod was frozen mid-history (e.g. substatus columns still present
because the migration that drops them keeps rolling back). The read replica
(read-only, `executeSql environment:"production"`) is the way to learn prod's
true current schema state before reasoning about what the next boot will do.

## How to apply
- Treat EVERY migration as potentially re-run from scratch against an existing
  schema at an arbitrary historical point. Use `IF [NOT] EXISTS`, promote
  existing indexes via `ADD CONSTRAINT ... USING INDEX` (scope the lookup to the
  target table + unique + non-partial), and guard column-dependent statements on
  `information_schema.columns` so a column dropped by a LATER migration doesn't
  crash an EARLIER one on replay.
- Editing already-merged migrations is justified ONLY when they never succeeded
  on prod and a new migration can't help (the batch aborts before reaching it).
  Such edits are inert on dev (recorded by name, never re-run).
- Verify by simulating prod: build a temp DB to the suspected prod state, then
  `TRUNCATE pgmigrations` and run the full set forward (`scripts/with-test-db.js`
  pattern). Cannot write to prod — fix lands only on next publish/deploy.
- The skill `database/references/database-migrations-on-publish.md` says the
  "right" answer is re-publish and that boot-time self-heal DDL is an
  anti-pattern. This codebase is architecturally committed to boot migrations,
  so the durable fix is to reconcile that conflict (baseline `pgmigrations`, or
  stop schema migrations at boot in prod) — not more idempotency whack-a-mole.
