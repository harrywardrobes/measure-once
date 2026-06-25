---
name: deploy-runbook
description: This skill should be used when the user wants to deploy, ship, push, or promote Measure Once code to staging or production — phrases like "deploy this", "push to staging", "promote staging to prod", "ship this change", or "walk me through a deploy". Operationalizes docs/deploy.md as an interactive, checked walkthrough with explicit gates before anything touches production.
version: 1.0.0
---

# Deploy Runbook (interactive)

This skill turns `docs/deploy.md` into a step-by-step, checked walkthrough. It does
not replace that doc — **re-read `docs/deploy.md` (and
`.agents/memory/deploy-promote-vs-build.md`) at the start of every run**, since
they're the source of truth and may have changed since this skill was written.
If anything below ever conflicts with what those files currently say, follow the
docs and tell the user about the mismatch.

There is no CI/CD for this app. Every command is run by hand, authenticated as
`harry@harrywardrobes.co.uk`. Treat that as a feature, not a gap to work around —
the manual gates are what keeps production safe.

## Ground rules (apply throughout, not just once)

- Confirm the active `gcloud` account is `harry@harrywardrobes.co.uk`
  (`gcloud auth list`) before running anything. If it isn't, stop and tell the
  user to `gcloud auth login` first.
- **Never print secret values** (DB passwords, API keys/tokens) into the chat,
  even ones fetched for a command. It's fine to show secret *names*
  (`--set-secrets=DATABASE_URL=DATABASE_URL_STAGING:latest`) — never resolved
  values like the password itself.
- If a command errors or its output looks even slightly off, **stop**. Don't
  retry, don't "fix forward," don't proceed to the next step. Surface exactly
  what happened and wait for the user's decision.
- You cannot see a browser. Any checklist item that requires looking at the
  running app needs the user to actually look and answer — don't mark it done
  for them.
- Staging shares live HubSpot/SMTP/QuickBooks-sandbox with production. Remind
  the user, when relevant: only act on `hw_test_user=true` contacts, and never
  open/register HubSpot webhooks from staging (it repoints prod's webhook at
  staging and breaks prod).

## 1. Ask which flow, before doing anything else

Don't assume — ask:

- **A — Dev → Staging.** Build a fresh image from the current repo and ship it
  to staging only.
- **B — Staging → Production.** Promote an *already-verified* image from
  staging to production. No rebuild.
- **C — Full pipeline.** Do A, then — only once staging is verified — walk
  through the production gate (section 3) before doing B.

If B, ask which image/commit is being promoted (the one already verified on
staging — deploy.md Step 5 explicitly reuses the same image, never a rebuild).
If the user isn't sure, get the image currently serving staging:

```powershell
gcloud run services describe measure-once-staging --region=europe-west2 `
  --format="value(spec.template.spec.containers[0].image)"
```

## 2. Flow A — Dev → Staging (docs/deploy.md Steps 1–3)

**Pre-flight:**

1. `git status` and `git rev-parse HEAD`. `gcloud builds submit` uploads the
   working directory as-is — uncommitted changes WILL be included in the
   image. If there are uncommitted changes, tell the user explicitly and ask
   whether that's intended; if not, they should commit or stash first. Record
   the commit hash either way — it goes in the closing summary.
2. Confirm the Cloud SQL Auth Proxy is reachable on `127.0.0.1:15432` (see
   `docs/staging-handoff.md` Part B2). If it isn't running, start it and
   confirm it's listening before continuing:
   ```powershell
   $tok = (gcloud auth print-access-token).Trim()
   cloud-sql-proxy --port 15432 --token $tok harry-wardrobes:europe-west2:harry-wardrobes-instance
   ```

**Steps:**

3. **Build** — run Step 1's `gcloud builds submit`, capture `$IMAGE`. Wait for
   it to actually finish and confirm the final status is success, not just
   that the command returned.
4. **Migrate staging** — run Step 2's `npm run db:migrate` against
   `measureonce_staging`. The output must say either the migration(s) applied
   cleanly or `No migrations to run!`. Anything else — stop, don't deploy.
5. **Deploy to staging** — run Step 3's `gcloud run deploy
   measure-once-staging`. Confirm the new revision is serving 100% traffic.
6. **Verify on staging** — walk the checklist one item at a time, waiting for
   the user's confirmation on each:
   - [ ] Login works
   - [ ] Admin panel shows dev mode **ON**, only `hw_test_user=true` contacts
         visible
   - [ ] The shipped change behaves as expected
   - You check the logs yourself and report findings *before* asking the user
     anything: `gcloud run services logs read measure-once-staging --region=europe-west2 --limit=100`
7. If verification fails: fix, then repeat from whichever step is appropriate
   (rebuild if the code changed, or just redeploy). Never promote a build that
   hasn't passed verification.
8. If this is flow C, stop here. Present the production gate (section 3) as
   its own decision point — don't roll straight into production deploy in the
   same breath as a staging deploy.

## 3. The production gate

Walk through **every** item below explicitly, every time — including when the
user says "just push it" or seems in a hurry. This is what stands between a
mistake and live customer data, so treat skipping any item as equivalent in
risk to deleting the wrong database. Get an explicit answer to each; don't
assume one is already satisfied.

1. **Staging verification confirmed.** Ask: "Did you complete the staging
   checklist above (login, dev mode/test contacts, the change behaves, no
   errors in logs) for the exact image you're about to promote?" If no, go
   back and do it first.
2. **Clean / matching state check.** Run `git status` and `git log -1`
   yourself; show the user the commit being promoted and confirm it's the same
   one (same `$IMAGE`, no rebuild) they verified on staging. Flag any mismatch.
3. **Typed confirmation.** Ask the user to type exactly `DEPLOY TO PRODUCTION`
   in chat. Anything else — "yes", "go", "do it", a button click — does not
   count; ask again. This is deliberately frictional on purpose.

Only once all three are explicitly satisfied, continue to section 4.

## 4. Flow B — Staging → Production (docs/deploy.md Steps 4–5, plus a backup)

1. **On-demand backup first** (in addition to the instance's automated
   backups — this is the extra safety margin before touching the prod DB):
   ```powershell
   gcloud sql backups create --instance=harry-wardrobes-instance `
     --description="pre-deploy $(git rev-parse --short HEAD)"
   ```
   This command blocks until the backup operation finishes — confirm it
   reports success before continuing. Don't proceed on a pending/failed
   backup.
2. **Migrate production** — Step 4's `npm run db:migrate` against
   `measureonce` (not staging — double check `$env:DATABASE_URL` before
   running). Same bar as staging: clean success or `No migrations to run!`,
   nothing else.
3. **Deploy to production** — Step 5's `gcloud run deploy measure-once`,
   reusing `$IMAGE` from the staging build that was actually verified — never
   a fresh build here. Confirm the new revision serves 100% traffic.
4. **Verify on production** — ask the user to check login/dashboards, open a
   customer-info or design-visit photo (confirms it's reading from
   `wardrobes-bucket` via GCS), and that the shipped change behaves. You check
   the logs yourself for errors and confirm no boot-time migrations ran:
   ```powershell
   gcloud run services logs read measure-once --region=europe-west2 --limit=100
   ```
5. If anything looks wrong: don't fix forward silently. Offer the rollback
   procedure from `docs/deploy.md` (`gcloud run revisions list` /
   `update-traffic` back to the previous revision) and ask before running it.

## 5. Close out

Give the user a short, factual summary — not a celebration: commit hash, image
tag, what was deployed where, which checklist items passed, and (if production
was touched) the backup description/timestamp from step 4.1. This is their
deploy log.
