---
name: Deploy publish "failed" after successful build
description: How to tell a promote/health-check failure from a build-command failure on this app, and the prod-boot migration replay that causes it.
---

# "Publish failed" but the build actually succeeded

**Symptom:** a deployment build shows `status: failed`, but the build logs show
`build:react` + `build:storybook` completing (`✓ built`, bundle report, image
layers "Pushed ... manifest"). That means the **build phase succeeded** and the
failure is in the **promote / health-check phase**: the app crashed on boot, so
port 5000 never opened and the startup probe (`GET /` must return 200) failed.
Deployment target is `vm`, run `node server.js`.

**Do not** chase build-log warnings (e.g. Storybook MDX `<Canvas of={...}>`
referencing a removed story export) — those are non-fatal; Storybook still
builds. They are red herrings for a promote failure.

## The actual cause on this app: migration replay on boot
Prod's `pgmigrations` tracker is **empty**, but Replit's publish-diff provisions
the prod schema to **HEAD**. So `runMigrations()` on boot re-runs *every*
migration against an already-complete schema in one transaction — any
non-idempotent statement crashes the whole batch and the app never starts.

**Why:** Replit's publish-flow applies a dev→prod schema diff but does NOT
populate node-pg-migrate's tracker; the app's own `runMigrations()` then sees a
clean tracker and replays all migrations.

**How to apply / verify before telling the user to re-publish:**
1. Confirm prod state via read replica: `executeSql({environment:"production", sqlQuery:"SELECT name FROM pgmigrations ORDER BY id"})` (empty) and check a known
   HEAD-only object exists.
2. Reproduce on a throwaway temp DB: apply all migrations → `TRUNCATE pgmigrations`
   → apply all again. If pass 2 runs clean, current HEAD boots fine on prod.
3. Confirm `node server.js` boots and `GET /` returns 200 locally.
4. Then `suggestDeploy()` — every migration must be idempotent against a HEAD schema.
