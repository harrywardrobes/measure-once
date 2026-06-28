# Deploying: staging → production

This is the **routine deploy runbook** — how to ship a code change once the app
is already live on GCP. For environment concepts, see
[docs/environments.md](environments.md) and [docs/staging-handoff.md](staging-handoff.md).
This doc only covers the day-to-day path: build once, deploy to staging, verify,
then promote the **same image** to production.

There is no CI/CD pipeline — every step below is a manual `gcloud` command run
from a workstation authenticated as `harry@harrywardrobes.co.uk`
(`gcloud auth login`). The org blocks service-account keys, so there's no
alternative to running these by hand (or scripting them yourself).

---

## How it fits together

One Docker image is built from the repo and deployed, unchanged, to **two**
separate Cloud Run services. The image itself is environment-agnostic — Cloud
Run injects the differences via env vars and Secret Manager:

| | Service | Database | Bucket | URL |
|---|---|---|---|---|
| Staging | `measure-once-staging` | `measureonce_staging` | `wardrobes-bucket-staging` | `staging.harrywardrobes.co.uk` |
| Production | `measure-once` | `measureonce` | `wardrobes-bucket` | `measure.harrywardrobes.co.uk` |

Fixed values used throughout: project `harry-wardrobes`, region `europe-west2`,
Artifact Registry repo `measure-once`, runtime service account
`wardrobes-run@harry-wardrobes.iam.gserviceaccount.com`, Cloud SQL instance
`harry-wardrobes-db` (connection name
`harry-wardrobes:europe-west2:harry-wardrobes-db`).

**Database migrations never run at container boot** (`RUN_MIGRATIONS_ON_BOOT` is
intentionally unset). Migrating is always a separate, deliberate step you run
before deploying — for staging *and* production, every time.

> ⚠️ **Migrate the instance the app actually uses — `harry-wardrobes-db`.**
> A second Cloud SQL instance, `harry-wardrobes-instance` (the original cutover
> instance), still exists and *also* has `measureonce` / `measureonce_staging`
> databases, so the two look interchangeable but are **not**. Both app services
> read `harry-wardrobes-db` (confirm any time with
> `gcloud secrets versions access latest --secret=DATABASE_URL` → the `host=`
> param). On 2026-06-28 the password-reset migrations were applied through a
> proxy left pointing at `harry-wardrobes-instance`; they landed on a database
> the app never reads, so prod kept failing with `column "identity_uid" does
> not exist` even though the migrations "looked applied". **Before every
> `npm run db:migrate`, verify the proxy's target instance** — e.g. on Windows:
> `Get-CimInstance Win32_Process -Filter "Name LIKE '%cloud-sql-proxy%'" | Select CommandLine`
> — and make sure it says `…harry-wardrobes-db`, not `…harry-wardrobes-instance`.

---

## Step 1 — Build the image

From the repo root, on the commit you want to ship:

```powershell
$STAMP = Get-Date -Format "yyyyMMdd-HHmmss"
$IMAGE = "europe-west2-docker.pkg.dev/harry-wardrobes/measure-once/measure-once:$STAMP"
gcloud builds submit --tag $IMAGE .
```

This is the **only** image you'll deploy in this pass — to staging first, then
to production once it's verified. Keep `$IMAGE` around (or note the tag) for
step 4.

---

## Step 2 — Migrate the staging database

Through the Cloud SQL Auth Proxy on port `15432`. If it isn't running, start it
with ADC (preferred — credentials auto-refresh) rather than `--token` (expires
after ~1 hour and causes `ECONNRESET`):

```powershell
C:\Users\User\cloud-sql-proxy.exe --port 15432 harry-wardrobes:europe-west2:harry-wardrobes-db
```

> If a proxy is **already** listening on `15432`, do not assume it targets the
> right instance — check its command line (see the warning above) before
> migrating. The same `mo_db_password.txt` happens to authenticate the `app`
> user on both instances, so a wrong-instance proxy fails silently, not loudly.

See [docs/staging-handoff.md](staging-handoff.md) Part B2 for full proxy setup
including the ADC refresh step. Then run migrations:

```powershell
$pw = (Get-Content "$env:TEMP\mo_db_password.txt" -Raw).Trim()
$env:DATABASE_URL = "postgres://app:$pw@127.0.0.1:15432/measureonce_staging"
npm run db:migrate
```

Expect either the new migration(s) to apply, or `No migrations to run!` if
there's nothing pending.

---

## Step 3 — Deploy to staging

```powershell
gcloud run deploy measure-once-staging `
  --image=$IMAGE `
  --region=europe-west2 `
  --service-account="wardrobes-run@harry-wardrobes.iam.gserviceaccount.com" `
  --add-cloudsql-instances="harry-wardrobes:europe-west2:harry-wardrobes-db" `
  --allow-unauthenticated --cpu-boost `
  --cpu=1 --memory=512Mi --min-instances=0 --max-instances=2 `
  --set-env-vars="NODE_ENV=production,STORAGE_BACKEND=gcs,GCS_BUCKET=wardrobes-bucket-staging,ADMIN_EMAILS=harry@harrywardrobes.co.uk,APP_URL=https://staging.harrywardrobes.co.uk,APP_URL_PRODUCTION=https://measure.harrywardrobes.co.uk,IDENTITY_PROJECT_ID=harry-wardrobes,GOOGLE_REDIRECT_URI=https://staging.harrywardrobes.co.uk/auth/google/callback,QB_REDIRECT_URI=https://staging.harrywardrobes.co.uk/auth/quickbooks/callback" `
  --set-secrets="DATABASE_URL=DATABASE_URL_STAGING:latest,SESSION_SECRET=SESSION_SECRET_STAGING:latest,QB_TOKEN_ENCRYPTION_KEY=QB_TOKEN_ENCRYPTION_KEY_STAGING:latest,GOOGLE_TOKEN_ENCRYPTION_KEY=GOOGLE_TOKEN_ENCRYPTION_KEY_STAGING:latest,HUBSPOT_ACCESS_TOKEN=HUBSPOT_ACCESS_TOKEN:latest,HUBSPOT_APP_ID=HUBSPOT_APP_ID:latest,HUBSPOT_CLIENT_SECRET=HUBSPOT_CLIENT_SECRET:latest,IDENTITY_API_KEY=IDENTITY_API_KEY:latest,QB_CLIENT_ID=QB_CLIENT_ID:latest,QB_CLIENT_SECRET=QB_CLIENT_SECRET:latest,QB_ENVIRONMENT=QB_ENVIRONMENT:latest,GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest,GOOGLE_PLACES_API_KEY=GOOGLE_PLACES_API_KEY:latest,GOOGLE_SHARED_CALENDAR_ID=GOOGLE_SHARED_CALENDAR_ID:latest,SMTP_HOST=SMTP_HOST:latest,SMTP_PORT=SMTP_PORT:latest,SMTP_USER=SMTP_USER:latest,SMTP_PASS=SMTP_PASS:latest,SMTP_FROM=SMTP_FROM:latest,TURNSTILE_SITE_KEY=TURNSTILE_SITE_KEY:latest,TURNSTILE_SECRET_KEY=TURNSTILE_SECRET_KEY:latest"
```

### Verify on staging

Go to `https://staging.harrywardrobes.co.uk` and check:

- [ ] Login works.
- [ ] Admin panel shows **dev mode ON**, and only `hw_test_user=true` HubSpot
      contacts are visible.
- [ ] The change you shipped behaves as expected.
- [ ] No errors in the logs: `gcloud run services logs read measure-once-staging --region=europe-west2 --limit=100`

**Staging guardrails — don't skip these:**
1. Only act on the test contacts dev mode shows. Dev mode is a *display*
   filter, not a write guard — live SMTP / QuickBooks (sandbox) / HubSpot
   (live portal) all act for real.
2. **Never** open or register HubSpot webhooks from staging — the webhook
   target is a single shared setting and doing this repoints production's
   events at staging, breaking prod.
3. If anything looks wrong, fix it and repeat steps 1–3. Don't promote a build
   you haven't verified on staging.

---

## Step 4 — Migrate the production database

Point at the production database through the same proxy (or its own proxy
session), then run the identical migration command against prod:

```powershell
$env:DATABASE_URL = "postgres://app:$pw@127.0.0.1:15432/measureonce"
npm run db:migrate
```

> **After a Cloud SQL instance restore or export/import:** the restored
> `pgmigrations` table reflects the migration history of the *source* database
> at the time of export, which may be behind the current codebase. Running
> `npm run db:migrate` here will apply any missing migrations before the new
> image starts serving traffic. Skipping this step causes immediate 500 errors
> on the first request that touches a column or table added by the missing
> migration. The same applies to the staging database — run Step 2 first.

---

## Step 5 — Deploy the same image to production

Re-use `$IMAGE` from step 1 — do **not** rebuild. Re-pointing every secret to
its latest version avoids hand-listing them all:

```powershell
$secretNames = gcloud secrets list --format="value(name)" | Where-Object { $_ -notlike "*_STAGING" }
$setSecrets = (($secretNames | ForEach-Object { "$($_)=$($_):latest" }) -join ",")

gcloud run deploy measure-once `
  --image=$IMAGE `
  --region=europe-west2 `
  --service-account="wardrobes-run@harry-wardrobes.iam.gserviceaccount.com" `
  --add-cloudsql-instances="harry-wardrobes:europe-west2:harry-wardrobes-db" `
  --allow-unauthenticated `
  --port=8080 --cpu=1 --memory=512Mi --min-instances=0 --max-instances=4 `
  --set-env-vars="NODE_ENV=production,STORAGE_BACKEND=gcs,GCS_BUCKET=wardrobes-bucket,ADMIN_EMAILS=harry@harrywardrobes.co.uk,APP_URL=https://measure.harrywardrobes.co.uk,GOOGLE_REDIRECT_URI=https://measure.harrywardrobes.co.uk/auth/google/callback,QB_REDIRECT_URI=https://measure.harrywardrobes.co.uk/auth/quickbooks/callback" `
  --set-secrets=$setSecrets
```

### Verify on production

Go to `https://measure.harrywardrobes.co.uk` and check:

- [ ] Login works, dashboards load.
- [ ] Open a customer-info or design-visit photo (confirms it's reading from
      `wardrobes-bucket` via GCS).
- [ ] The change you shipped behaves as expected.
- [ ] Logs show **no boot-time migrations** and no errors:
      `gcloud run services logs read measure-once --region=europe-west2 --limit=100`

---

## Rollback

Cloud Run keeps prior revisions — you don't need to rebuild to roll back.

```powershell
gcloud run revisions list --service=measure-once --region=europe-west2
gcloud run services update-traffic measure-once --region=europe-west2 `
  --to-revisions=<previous-revision-name>=100
```

Same pattern for `measure-once-staging`. If the rollback also needs a schema
change reverted, see `npm run db:migrate:down` — but check first whether the
new code actually depends on the new schema before rolling the DB back too.

---

## Quick reference — the whole flow

```powershell
# 1. Build once
$STAMP = Get-Date -Format "yyyyMMdd-HHmmss"
$IMAGE = "europe-west2-docker.pkg.dev/harry-wardrobes/measure-once/measure-once:$STAMP"
gcloud builds submit --tag $IMAGE .

# 2. Migrate + deploy staging, then verify in the browser
$env:DATABASE_URL = "postgres://app:$pw@127.0.0.1:15432/measureonce_staging"; npm run db:migrate
gcloud run deploy measure-once-staging --image=$IMAGE ...   # full flags in Step 3

# 3. Once happy: migrate + deploy production, then verify in the browser
$env:DATABASE_URL = "postgres://app:$pw@127.0.0.1:15432/measureonce"; npm run db:migrate
gcloud run deploy measure-once --image=$IMAGE --set-secrets=$setSecrets ...   # full flags in Step 5
```
