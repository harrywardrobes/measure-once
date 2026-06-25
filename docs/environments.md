# Environments: development → staging → production

Measure Once runs in three tiers. This document describes each, how they differ,
and the exact steps to stand up and refresh **staging**
(`staging.harrywardrobes.co.uk`).

| | **Development** | **Staging** | **Production** |
|---|---|---|---|
| URL | `localhost:5000` | `staging.harrywardrobes.co.uk` | `measure.harrywardrobes.co.uk` |
| Runs on | your machine (`npm run dev`) | **GCP Cloud Run** (`measure-once-staging`) | Replit *(today)* → Cloud Run *(after cutover)* |
| Database | local Postgres (seeded "pretend" data) | Cloud SQL **`measureonce_staging`** (isolated copy) | Neon *(today)* → Cloud SQL `measureonce` |
| `NODE_ENV` | `development` | `production` | `production` |
| Migrations | auto on boot | **deliberate** (`npm run db:migrate`), never on boot | deliberate, never on boot |
| HubSpot / SMTP | stubbed / off | **LIVE** (same portal/mailbox as prod) | LIVE |
| QuickBooks | stubbed / off | **sandbox** (`QB_ENVIRONMENT=sandbox`; app not yet prod-verified) | sandbox until prod-verified, then live |
| App "dev mode" | n/a | **ON** — confines contacts to `hw_test_user='true'` | OFF |
| Object storage | local / dev bucket | `wardrobes-bucket-staging` | `wardrobes-bucket` |

The point of staging: push the app, run it against a production-like copy of the
data, and exercise **real** HubSpot / email workflows (and **sandbox**
QuickBooks) — but only against **test contacts**, by keeping the app's dev mode ON.

---

## Object storage layout (identical in every bucket)

Photos live under two fixed top-level prefixes, split by who uploaded them:

| Prefix | Written by | Source flow |
|---|---|---|
| `customer-info-photos/` | **customers** | the customer-info upload form (upload-photos-info) |
| `visit-photos/` | **staff** | design **and** survey visit wizards |

The prefixes are constructed in code — `customer-info.js` → `customer-info-photos/`,
and `design-visit-uploads.js` (`STORAGE_PREFIX`) → `visit-photos/` (survey visits
reuse the same uploader). `storage.js` writes this same layout into **whichever**
bucket the environment points at (`wardrobes-bucket` for prod,
`wardrobes-bucket-staging` for staging), so the structure is identical across
environments. Only an opaque `obj:<id>.<ext>` key is stored in the DB; the prefix
is reconstructed on read/write. (The HTTP route `/api/design-visit-images/` is
internal plumbing, unrelated to the bucket folder name.)

Both prefixes exist in `wardrobes-bucket` and are mirrored in
`wardrobes-bucket-staging` as zero-byte folder placeholders, so the structure is
visible even before any photo is uploaded. Staging starts with **no** photos (the
seed clones the DB, not the bucket) — existing prod photos won't display in
staging, which is expected.

---

## ⚠️ Why staging needs care (live integrations, shared services)

Staging uses the **same live HubSpot portal, QuickBooks company, and SMTP
mailbox** as production. The isolation that keeps it safe is the **app dev-mode
filter plus its own database** — not sandboxing. Understand these sharp edges:

1. **Dev mode is a DISPLAY filter, not a write guard.** When
   `app_settings.dev_mode_enabled = 'true'`, the app only *shows* HubSpot
   contacts flagged `hw_test_user = 'true'`. It does **not** block writes. You
   stay safe by only initiating workflows on the test contacts it shows. Make
   sure your test contacts in HubSpot have `hw_test_user = true` and use email
   addresses **you** control (live SMTP will email them for real).

2. **Never register or modify HubSpot webhooks from staging.** The webhook
   target URL is a single setting on the shared HubSpot app. Registering it from
   staging repoints production's events at staging and **breaks production
   webhooks**. Leave `WEBHOOK_BASE_URL` unset and don't touch the webhook admin
   screen on staging.

3. **QuickBooks / Google tokens rotate — staging uses its OWN.** Tokens live in
   the DB (`qb_tokens`, `google_oauth_tokens`) and QuickBooks rotates its refresh
   token on every refresh. If staging reused prod's cloned token and refreshed
   it, Intuit would invalidate prod's copy and break production QuickBooks.
   `npm run staging:safety-reset` clears these so staging connects its own.

4. **Staging shares the DB only with its own copy.** Sessions, settings, and all
   writes go to `measureonce_staging`, never prod. The clone is a point-in-time
   copy; refresh it whenever you want fresh data.

---

## One-time setup

### Repo / cloud (operator — most done via `gcloud`, ADC)

Reuse the project parameters from [docs/gcp-cutover.md](gcp-cutover.md):
`PROJECT_ID=harry-wardrobes`, `REGION=europe-west2`,
`SQL_INSTANCE=harry-wardrobes-instance`, runtime SA
`wardrobes-run@harry-wardrobes.iam.gserviceaccount.com`.

1. **Create the staging database** on the existing Cloud SQL instance and seed it
   from the migrated `measureonce` copy (run through the Cloud SQL Auth Proxy):
   ```bash
   # Create empty staging DB
   psql "postgres://app:<pw>@127.0.0.1:5432/postgres" \
     -c "CREATE DATABASE measureonce_staging OWNER app;"

   # Seed it from the migrated prod copy
   pg_dump "postgres://app:<pw>@127.0.0.1:5432/measureonce" --no-owner --no-privileges -Fc -f /tmp/seed.dump
   pg_restore --no-owner --no-privileges \
     --dbname="postgres://app:<pw>@127.0.0.1:5432/measureonce_staging" /tmp/seed.dump
   ```

2. **Make the clone safe** (forces dev mode ON, clears QB/Google tokens, clears
   sessions):
   ```bash
   STAGING_DATABASE_URL="postgres://app:<pw>@127.0.0.1:5432/measureonce_staging" \
     npm run staging:safety-reset
   ```

3. **Staging secrets** in Secret Manager (separate from prod):
   - `DATABASE_URL_STAGING` — socket form:
     `postgres://app:<pw>@/measureonce_staging?host=/cloudsql/harry-wardrobes:europe-west2:harry-wardrobes-instance`
   - `SESSION_SECRET_STAGING`, `QB_TOKEN_ENCRYPTION_KEY_STAGING`,
     `GOOGLE_TOKEN_ENCRYPTION_KEY_STAGING` — each `openssl rand -hex 32`.
   - The live integration secrets (`HUBSPOT_TOKEN`, `QB_CLIENT_ID`,
     `QB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
     `GOOGLE_PLACES_API_KEY`, `SMTP_*`) are the SAME as prod — reference them.

4. **(Recommended) staging bucket** `wardrobes-bucket-staging` with the same
   uniform-access settings; grant the runtime SA `storage.objectAdmin` on it.

5. **Build & deploy** the Cloud Run staging service:
   ```bash
   export IMAGE="europe-west2-docker.pkg.dev/harry-wardrobes/<repo>/measure-once:staging-$(date +%Y%m%d-%H%M%S)"
   gcloud builds submit --tag "$IMAGE" .

   gcloud run deploy measure-once-staging \
     --image="$IMAGE" --region=europe-west2 \
     --service-account="wardrobes-run@harry-wardrobes.iam.gserviceaccount.com" \
     --add-cloudsql-instances="harry-wardrobes:europe-west2:harry-wardrobes-instance" \
     --allow-unauthenticated --port=5000 --cpu=1 --memory=512Mi \
     --min-instances=0 --max-instances=2 \
     --set-env-vars="NODE_ENV=production,APP_URL=https://staging.harrywardrobes.co.uk,STORAGE_BACKEND=gcs,GCS_BUCKET=wardrobes-bucket-staging,QB_REDIRECT_URI=https://staging.harrywardrobes.co.uk/auth/quickbooks/callback,GOOGLE_REDIRECT_URI=https://staging.harrywardrobes.co.uk/auth/google/callback" \
     # QB_ENVIRONMENT comes from the shared QB_ENVIRONMENT secret (sandbox) — do NOT hardcode production here \
     --set-secrets="DATABASE_URL=DATABASE_URL_STAGING:latest,SESSION_SECRET=SESSION_SECRET_STAGING:latest,QB_TOKEN_ENCRYPTION_KEY=QB_TOKEN_ENCRYPTION_KEY_STAGING:latest,GOOGLE_TOKEN_ENCRYPTION_KEY=GOOGLE_TOKEN_ENCRYPTION_KEY_STAGING:latest,HUBSPOT_ACCESS_TOKEN=HUBSPOT_TOKEN:latest,QB_CLIENT_ID=QB_CLIENT_ID:latest,QB_CLIENT_SECRET=QB_CLIENT_SECRET:latest,GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest,GOOGLE_PLACES_API_KEY=GOOGLE_PLACES_API_KEY:latest,SMTP_HOST=SMTP_HOST:latest,SMTP_USER=SMTP_USER:latest,SMTP_PASS=SMTP_PASS:latest"
   ```

6. **Map the domain** (prints the DNS records to add at Hostinger):
   ```bash
   gcloud beta run domain-mappings create \
     --service=measure-once-staging \
     --domain=staging.harrywardrobes.co.uk \
     --region=europe-west2
   ```

### Manual steps (you)

These cannot be done from the repo/CLI here:

1. **Verify domain ownership** of `harrywardrobes.co.uk` in
   [Google Search Console](https://search.google.com/search-console) (required
   before Cloud Run will activate the domain mapping).
2. **Add the DNS record at Hostinger** that step 6 prints — typically a `CNAME`
   for `staging` → `ghs.googlehosted.com.`.
3. **Register the staging OAuth redirect URIs:**
   - Google Cloud Console → the OAuth client → Authorized redirect URIs:
     `https://staging.harrywardrobes.co.uk/auth/google/callback`
   - Intuit developer portal → the QuickBooks app → Redirect URIs:
     `https://staging.harrywardrobes.co.uk/auth/quickbooks/callback`
4. **Flag your test contacts** in HubSpot with `hw_test_user = true`, using email
   addresses you control (live SMTP emails them for real).
5. **After first deploy, in the staging admin panel:** confirm dev mode is ON,
   then connect QuickBooks and connect Google (their tokens were cleared by the
   safety reset). **Do not** open/register HubSpot webhooks on staging.

---

## Refreshing staging data (repeat anytime)

```bash
# 1. Re-seed measureonce_staging from the current prod copy (drop & restore)
# 2. Make it safe again:
STAGING_DATABASE_URL="postgres://app:<pw>@127.0.0.1:5432/measureonce_staging" \
  npm run staging:safety-reset
# 3. Re-connect QuickBooks + Google in the staging admin panel.
```

## Deploying new code to staging

```bash
# Apply any new migrations to staging FIRST (never on boot):
DATABASE_URL="<staging socket URL>" npm run db:migrate
# Then build + deploy the new image to the staging service (same as setup step 5).
```

After cutover (when production moves to Cloud Run), production becomes a second
service against `measureonce` with live integrations and dev mode OFF — staging
stays exactly as documented here and becomes your permanent pre-prod.
