---
name: deploy-runbook
description: This skill should be used when the user wants to deploy, ship, push, or promote Measure Once code to staging or production — phrases like "deploy this", "push to staging", "promote staging to prod", "ship this change", or "walk me through a deploy". Operationalizes docs/deploy.md as an interactive, checked walkthrough with explicit gates before anything touches production.
version: 1.1.0
---

# Deploy Runbook (interactive)

This skill turns `docs/deploy.md` into a step-by-step, checked walkthrough. It does
not replace that doc — **re-read `docs/deploy.md` (and
`docs/staging-handoff.md`) at the start of every run**, since they're the source
of truth and may have changed since this skill was written. If anything below
ever conflicts with what those files currently say, follow the docs and tell the
user about the mismatch.

There is no CI/CD for this app. Every command is run by Claude, authenticated as
`harry@harrywardrobes.co.uk`. The manual gates are what keeps production safe.

## Ground rules (apply throughout, not just once)

- **Run ALL commands yourself** — never ask the user to open a terminal or run
  a command. The only things the user needs to provide are:
  - Auth codes from `--no-launch-browser` login flows (browser-based, one code)
  - Visual confirmation of staging/production after deploy (browser checks)
  - The typed `DEPLOY TO PRODUCTION` confirmation before a production push
- **Auth failures:** if `gcloud auth list` shows no active account, or any
  gcloud command fails with a reauth error, use the browser automation tools
  (`mcp__claude-in-chrome__*`) to complete the login flow automatically:
  1. Run the named-pipe helper to get the auth URL (see helper script at
     `%TEMP%\mo_gcloud_auth_helper.ps1` — launch it, poll for
     `%TEMP%\mo_gcloud_url.txt`, then navigate Chrome to that URL).
  2. In Chrome: click the `harry@harrywardrobes.co.uk` account in the
     chooser. Google will show a password field for re-verification —
     **stop here and ask the user for the password** (never store or
     auto-fill it). Once they confirm they've entered the password in the
     browser themselves and clicked Next, read the auth code from
     `https://sdk.cloud.google.com/authcode.html` using `read_page`.
  3. Write the code to `%TEMP%\mo_gcloud_code.txt` and wait for
     `%TEMP%\mo_gcloud_done.txt` to contain `exit:0`.
  The helper script (`mo_gcloud_auth_helper.ps1`) handles the named-pipe
  stdin exchange with the gcloud process — do not re-implement it manually.
- **ADC failures** (Cloud SQL proxy fails to start): run
  `gcloud auth application-default login --no-launch-browser`, capture the
  URL from the output, navigate Chrome to it, complete sign-in, paste the
  code back — same browser-automation flow as above.
- **Never print secret values** (DB passwords, API keys/tokens) into the chat,
  even ones fetched for a command. Secret *names* are fine
  (`--set-secrets=DATABASE_URL=DATABASE_URL_STAGING:latest`) — never the resolved
  values.
- If a command errors or its output looks even slightly off, **stop**. Don't
  retry, don't "fix forward," don't proceed to the next step. Surface exactly
  what happened and wait for the user's decision.
- You cannot see a browser. Any checklist item that requires looking at the
  running app needs the user to actually look and answer — don't mark it done
  for them.
- Staging shares live HubSpot/SMTP/QuickBooks-sandbox with production. Remind
  the user when relevant: only act on `hw_test_user=true` contacts, and never
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

If B, ask which image/commit is being promoted. If the user isn't sure, get
the image currently serving staging yourself:

```powershell
gcloud run services describe measure-once-staging --region=europe-west2 `
  --format="value(spec.template.spec.containers[0].image)"
```

## 2. Flow A — Dev → Staging (docs/deploy.md Steps 1–3)

**Pre-flight:**

1. Run `git status` and `git rev-parse HEAD` yourself. `gcloud builds submit`
   uploads the working directory as-is — uncommitted changes WILL be included.
   If there are uncommitted changes, tell the user and ask whether that's
   intended; if not, ask them to commit or stash first. Record the commit hash
   — it goes in the closing summary.

2. Check if the Cloud SQL Auth Proxy is running on `127.0.0.1:15432`:
   ```powershell
   Test-NetConnection -ComputerName 127.0.0.1 -Port 15432 -WarningAction SilentlyContinue | Select-Object TcpTestSucceeded
   ```
   If not running, start it yourself in the background using ADC (preferred —
   auto-refreshes, never expires). The binary lives at
   `C:\Users\User\cloud-sql-proxy.exe`:
   ```powershell
   C:\Users\User\cloud-sql-proxy.exe --port 15432 harry-wardrobes:europe-west2:harry-wardrobes-instance
   ```
   Run this in the background, then re-check the port after a few seconds.
   If the proxy fails because ADC credentials are missing or expired, run:
   ```powershell
   gcloud auth application-default login --no-launch-browser
   ```
   Show the user the URL, ask for the code, then retry the proxy.
   **Do not use `--token`** — it expires after ~1 hour and causes `ECONNRESET`
   mid-migration.

**Steps:**

3. **Build** — run Step 1 of deploy.md (`gcloud builds submit`), capture
   `$IMAGE`. Wait for it to actually finish and confirm the final status is
   success, not just that the command returned:
   ```powershell
   $STAMP = Get-Date -Format "yyyyMMdd-HHmmss"
   $IMAGE = "europe-west2-docker.pkg.dev/harry-wardrobes/measure-once/measure-once:$STAMP"
   gcloud builds submit --tag $IMAGE .
   ```

4. **Migrate staging** — run Step 2's `npm run db:migrate` against
   `measureonce_staging`. Read the DB password from the local file (never print
   it to chat):
   ```powershell
   $pw = (Get-Content "$env:TEMP\mo_db_password.txt" -Raw).Trim()
   $env:DATABASE_URL = "postgres://app:$pw@127.0.0.1:15432/measureonce_staging"
   npm run db:migrate
   ```
   The output must say either the migration(s) applied cleanly or
   `No migrations to run!`. Anything else — stop, don't deploy.

5. **Deploy to staging** — run Step 3's `gcloud run deploy measure-once-staging`
   with `$IMAGE`. Confirm the new revision is serving 100% traffic.

6. **Verify on staging** — check the logs yourself first and report findings:
   ```powershell
   gcloud run services logs read measure-once-staging --region=europe-west2 --limit=100
   ```
   Then walk the checklist one item at a time, waiting for the user's browser
   confirmation on each:
   - [ ] Login works
   - [ ] Admin panel shows dev mode **ON**, only `hw_test_user=true` contacts visible
   - [ ] The shipped change behaves as expected

7. If verification fails: fix, then repeat from whichever step is appropriate
   (rebuild if the code changed, or just redeploy). Never promote a build that
   hasn't passed verification.

8. If this is flow C, stop here. Present the production gate (section 3) as
   its own decision point — don't roll straight into production deploy.

## 3. The production gate

Walk through **every** item below explicitly, every time — including when the
user says "just push it" or seems in a hurry. This is what stands between a
mistake and live customer data. Get an explicit answer to each; don't assume
one is already satisfied.

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

1. **On-demand backup first** (extra safety margin before touching the prod DB):
   ```powershell
   gcloud sql backups create --instance=harry-wardrobes-instance `
     --description="pre-deploy $(git rev-parse --short HEAD)"
   ```
   This command blocks until the backup finishes — confirm it reports success.
   Don't proceed on a pending or failed backup.

2. **Migrate production** — Step 4's `npm run db:migrate` against `measureonce`
   (not staging — double-check `$env:DATABASE_URL` before running):
   ```powershell
   $pw = (Get-Content "$env:TEMP\mo_db_password.txt" -Raw).Trim()
   $env:DATABASE_URL = "postgres://app:$pw@127.0.0.1:15432/measureonce"
   npm run db:migrate
   ```
   Same bar: clean success or `No migrations to run!`, nothing else.

3. **Deploy to production** — Step 5's `gcloud run deploy measure-once`,
   reusing `$IMAGE` from the staging build that was actually verified — never a
   fresh build here. Confirm the new revision serves 100% traffic.

4. **Verify on production** — check the logs yourself for errors and confirm
   no boot-time migrations ran:
   ```powershell
   gcloud run services logs read measure-once --region=europe-west2 --limit=100
   ```
   Then ask the user to check login/dashboards and that the shipped change
   behaves as expected.

5. If anything looks wrong: don't fix forward silently. Offer the rollback
   procedure from `docs/deploy.md` (`gcloud run revisions list` /
   `update-traffic` back to the previous revision) and ask before running it.

## 5. Close out

Give the user a short, factual summary — not a celebration: commit hash, image
tag, what was deployed where, which checklist items passed, and (if production
was touched) the backup description/timestamp from step 4.1. This is their
deploy log.
