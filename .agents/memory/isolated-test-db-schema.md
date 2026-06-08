---
name: Isolated test DB schema + rate-limit warmup
description: What an isolated :ci temp database needs now that schema comes from migrations, not boot-time ensure* calls.
---

Schema is owned by `node-pg-migrate` files in `migrations/`; application code no
longer creates any tables at boot. Two consequences for the isolated `:ci` test
suites (those that create a throwaway DB via `scripts/with-test-db.js`):

1. **Migrations must be applied to the temp DB after `CREATE DATABASE`.**
   `with-test-db.js` calls `runMigrations({ databaseUrl: testDbUrl })`. Without
   it, harnesses that seed BEFORE spawning the server hit empty-schema errors,
   because there is no longer any boot-time `ensure*` to build tables.

2. **The `@acpr/rate-limit-postgresql` `rate_limit` schema must be warmed up
   before the server spawns.** Its store constructor fires `applyMigrations`
   asynchronously and un-awaited, so a login that races it 500s with
   `rate_limit.ind_increment does not exist` (and intermittently 401s).
   `with-test-db.js` constructs a `PostgresStoreIndividualIP` and polls
   `pg_proc` for `rate_limit.ind_increment` before continuing.

**Why:** moving schema bootstrap from scattered `ensure*` calls into migrations
removed the implicit schema-on-boot guarantee these suites silently relied on.

**How to apply:** any NEW isolated `:ci` suite gets both for free through
`with-test-db.js` — don't re-add boot-time table creation to "fix" a failing
temp-DB test.

## Design-visit member-ownership in tests
`design_visits.created_by` stores `String(claims.sub)` — the numeric user id, not
an email. The submit route lets a `member` submit only their own visit
(`created_by === String(userId)`); managers/admins may submit any. Tests that
seed a visit directly and submit it as a member must stamp `created_by` with that
member's seeded id (or log in as manager/admin), or the submit 403s.
