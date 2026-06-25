# Staging environment — handoff plan

Stand up `staging.harrywardrobes.co.uk`: a Cloud Run deployment of Measure Once
running the **live** HubSpot / QuickBooks / SMTP integrations, but against an
**isolated copy** of production data with the app's **dev mode ON** (so only
HubSpot test contacts — `hw_test_user='true'` — are touched).

Read [docs/environments.md](environments.md) for the concepts and the three
sharp edges. This document is the **executable runbook** with real values.

---

## Status

- [x] Repo groundwork: `scripts/staging-safety-reset.mjs` (+ `npm run
  staging:safety-reset`), `.env.staging.example`, `docs/environments.md`.
- [ ] Part A — manual browser steps (you) — **start now, the long pole**
- [ ] Part B — provisioning (operator w/ `gcloud` + Postgres client + proxy)
- [ ] Part C — DNS at Hostinger (you)
- [ ] Part D — first-boot config in staging admin (you)
- [ ] Verification

**Dependency order:** A1 (Search Console verification) gates B5 (domain mapping)
and C (DNS). Do A1 first — it can take minutes to hours to propagate. B1–B4 can
run in parallel with A. C needs the output of B5. D needs B4 live + C resolved.

---

## Fixed values (already confirmed live)

| Thing | Value |
|---|---|
| Project | `harry-wardrobes` |
| Region | `europe-west2` |
| Cloud SQL instance | `harry-wardrobes-instance` (Postgres 18) |
| …connection name | `harry-wardrobes:europe-west2:harry-wardrobes-instance` |
| Runtime service account | `wardrobes-run@harry-wardrobes.iam.gserviceaccount.com` |
| Reusable image (no rebuild) | `europe-west2-docker.pkg.dev/harry-wardrobes/measure-once/measure-once:20260625-021510` |
| Prod service / DB / bucket | `measure-once` / `measureonce` / `wardrobes-bucket` |
| **Staging** service / DB / bucket | `measure-once-staging` / `measureonce_staging` / `wardrobes-bucket-staging` |
| Domain | `staging.harrywardrobes.co.uk` |
| DB password (local file) | `%TEMP%\mo_db_password.txt` |

> The container listens on Cloud Run's default port (8080) — **do not** pass
> `--port`. The app reads `PORT` from the environment, which Cloud Run injects.

---

## Part A — manual browser steps (you) — start now

### A1. Verify domain ownership (BLOCKS the domain mapping)
> ✅ **Likely already done.** `gcloud domains list-user-verified` returns
> `harrywardrobes.co.uk` for this account, so the domain mapping in B5 should
> work without further verification. Confirm with that command; only do the steps
> below if it is *not* listed.

1. Go to [Google Search Console](https://search.google.com/search-console).
2. Add property → **Domain** → enter `harrywardrobes.co.uk`.
3. It gives you a `TXT` record. Add it at **Hostinger** (DNS zone for
   `harrywardrobes.co.uk`) and click **Verify**. Wait until it shows verified.
   - Use the same Google account as the Cloud project: `harry@harrywardrobes.co.uk`.

### A2. Register the staging OAuth redirect URIs
- **Google Cloud Console** → APIs & Services → Credentials → the OAuth 2.0
  client → **Authorized redirect URIs** → add:
  `https://staging.harrywardrobes.co.uk/auth/google/callback`
- **Intuit developer portal** ([developer.intuit.com](https://developer.intuit.com))
  → your QuickBooks app → **Keys & OAuth** → Redirect URIs → add:
  `https://staging.harrywardrobes.co.uk/auth/quickbooks/callback`
  (Add it to the **Production** keys, since staging uses live QuickBooks.)

### A3. Flag your HubSpot test contacts
In HubSpot, set `hw_test_user = true` on the contacts you'll test with. Use
email addresses **you** control — staging sends **real** email to them.

---

## Part B — provisioning (operator: gcloud + Postgres client + Cloud SQL proxy)

Run from any machine signed in as `harry@harrywardrobes.co.uk`
(`gcloud auth login`; ADC via `gcloud auth application-default login`). The org
blocks service-account keys — ADC only.

### B1. Create the staging bucket + grant the runtime SA
```powershell
gcloud storage buckets create gs://wardrobes-bucket-staging `
  --location=europe-west2 --uniform-bucket-level-access `
  --public-access-prevention=enforced
gcloud storage buckets update gs://wardrobes-bucket-staging --versioning
gcloud storage buckets add-iam-policy-binding gs://wardrobes-bucket-staging `
  --member="serviceAccount:wardrobes-run@harry-wardrobes.iam.gserviceaccount.com" `
  --role="roles/storage.objectAdmin"
```

### B2. Create + seed the staging database, then make it safe
```powershell
# Create the empty staging DB on the existing instance
gcloud sql databases create measureonce_staging --instance=harry-wardrobes-instance
```
Start the Cloud SQL Auth Proxy in a separate terminal. The binary lives at
`C:\Users\User\cloud-sql-proxy.exe` (download:
https://cloud.google.com/sql/docs/postgres/sql-proxy if missing).

> ⚠️ **Port:** this workstation runs **local** PostgreSQL servers on 5432, 5433,
> **and** 5434 (the EDB installers for PG16/17/18). Do **not** use 5432 — you'd
> dump/restore against a local DB, not Cloud SQL. Use a free high port (**15432**).

**Preferred — ADC (auto-refreshes, never expires):**
```powershell
# Refresh ADC first if it's been a while (opens browser once)
gcloud auth application-default login
# Then start the proxy — it auto-refreshes credentials, no token expiry
C:\Users\User\cloud-sql-proxy.exe --port 15432 harry-wardrobes:europe-west2:harry-wardrobes-instance
```

**Fallback — short-lived token (expires ~1 hour, causes ECONNRESET on expiry):**
```powershell
$tok = (gcloud auth print-access-token).Trim()
C:\Users\User\cloud-sql-proxy.exe --port 15432 --token $tok harry-wardrobes:europe-west2:harry-wardrobes-instance
```
> If you see `ECONNRESET` during a deploy, the token has expired. Kill the proxy,
> run the ADC preferred command above, then retry from the failed migration step.
Seed staging from the migrated `measureonce` copy (Postgres-18 client tools):
```powershell
$pw = (Get-Content "$env:TEMP\mo_db_password.txt" -Raw).Trim()
$env:PGSSLMODE = "disable"   # traffic is local to the proxy
pg_dump "postgres://app:$pw@127.0.0.1:15432/measureonce" --no-owner --no-privileges -Fc -f "$env:TEMP\seed.dump"
pg_restore --no-owner --no-privileges `
  --dbname="postgres://app:$pw@127.0.0.1:15432/measureonce_staging" "$env:TEMP\seed.dump"
```
Make the clone safe (dev mode ON; clear QB/Google tokens; clear sessions):
```powershell
$env:STAGING_DATABASE_URL = "postgres://app:$pw@127.0.0.1:15432/measureonce_staging"
npm run staging:safety-reset
```
Confirm migrations are already reconciled (should be a no-op — staging inherits
`measureonce`'s reconciled `pgmigrations`):
```powershell
$env:DATABASE_URL = "postgres://app:$pw@127.0.0.1:15432/measureonce_staging"
npm run db:migrate   # expect: "No migrations to run!"
```
Clean up the dump (contains live PII):
```powershell
Remove-Item "$env:TEMP\seed.dump"
```

### B3. Create the staging-specific secrets + grant access
Four secrets are staging-only; the rest are shared with prod (referenced as-is).
```powershell
$pw = (Get-Content "$env:TEMP\mo_db_password.txt" -Raw).Trim()
$conn = "harry-wardrobes:europe-west2:harry-wardrobes-instance"

# DATABASE_URL_STAGING — Cloud Run socket form
$dbUrl = "postgres://app:$pw@/measureonce_staging?host=/cloudsql/$conn"
$dbUrl | Out-File "$env:TEMP\s_db.txt" -NoNewline -Encoding ascii
gcloud secrets create DATABASE_URL_STAGING --data-file="$env:TEMP\s_db.txt"

# Fresh random values for the three key secrets (staging re-connects QB/Google)
foreach ($n in "SESSION_SECRET_STAGING","QB_TOKEN_ENCRYPTION_KEY_STAGING","GOOGLE_TOKEN_ENCRYPTION_KEY_STAGING") {
  $val = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  $val | Out-File "$env:TEMP\s_val.txt" -NoNewline -Encoding ascii
  gcloud secrets create $n --data-file="$env:TEMP\s_val.txt"
}
Remove-Item "$env:TEMP\s_db.txt","$env:TEMP\s_val.txt"

# Grant the runtime SA access to the four new secrets
foreach ($n in "DATABASE_URL_STAGING","SESSION_SECRET_STAGING","QB_TOKEN_ENCRYPTION_KEY_STAGING","GOOGLE_TOKEN_ENCRYPTION_KEY_STAGING") {
  gcloud secrets add-iam-policy-binding $n `
    --member="serviceAccount:wardrobes-run@harry-wardrobes.iam.gserviceaccount.com" `
    --role="roles/secretmanager.secretAccessor"
}
```

### B4. Deploy the staging Cloud Run service (reuses the prod image)
Mirrors prod, with staging DB/bucket/keys, `APP_URL` + redirect URIs set, and
`WEBHOOK_BASE_URL` deliberately **omitted**.
```powershell
gcloud run deploy measure-once-staging `
  --image="europe-west2-docker.pkg.dev/harry-wardrobes/measure-once/measure-once:20260625-021510" `
  --region=europe-west2 `
  --service-account="wardrobes-run@harry-wardrobes.iam.gserviceaccount.com" `
  --add-cloudsql-instances="harry-wardrobes:europe-west2:harry-wardrobes-instance" `
  --allow-unauthenticated --cpu-boost `
  --cpu=1 --memory=512Mi --min-instances=0 --max-instances=2 `
  --set-env-vars="NODE_ENV=production,STORAGE_BACKEND=gcs,GCS_BUCKET=wardrobes-bucket-staging,ADMIN_EMAILS=harry@harrywardrobes.co.uk,APP_URL=https://staging.harrywardrobes.co.uk,GOOGLE_REDIRECT_URI=https://staging.harrywardrobes.co.uk/auth/google/callback,QB_REDIRECT_URI=https://staging.harrywardrobes.co.uk/auth/quickbooks/callback" `
  --set-secrets="DATABASE_URL=DATABASE_URL_STAGING:latest,SESSION_SECRET=SESSION_SECRET_STAGING:latest,QB_TOKEN_ENCRYPTION_KEY=QB_TOKEN_ENCRYPTION_KEY_STAGING:latest,GOOGLE_TOKEN_ENCRYPTION_KEY=GOOGLE_TOKEN_ENCRYPTION_KEY_STAGING:latest,HUBSPOT_ACCESS_TOKEN=HUBSPOT_ACCESS_TOKEN:latest,QB_CLIENT_ID=QB_CLIENT_ID:latest,QB_CLIENT_SECRET=QB_CLIENT_SECRET:latest,QB_ENVIRONMENT=QB_ENVIRONMENT:latest,GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest,GOOGLE_PLACES_API_KEY=GOOGLE_PLACES_API_KEY:latest,GOOGLE_SHARED_CALENDAR_ID=GOOGLE_SHARED_CALENDAR_ID:latest,SMTP_HOST=SMTP_HOST:latest,SMTP_PORT=SMTP_PORT:latest,SMTP_USER=SMTP_USER:latest,SMTP_PASS=SMTP_PASS:latest,SMTP_FROM=SMTP_FROM:latest,TURNSTILE_SITE_KEY=TURNSTILE_SITE_KEY:latest,TURNSTILE_SECRET_KEY=TURNSTILE_SECRET_KEY:latest"
```
Smoke-test the raw URL it prints (`https://measure-once-staging-…run.app`):
log in, confirm dev mode is ON, confirm only test contacts show.

### B5. Front with an external HTTPS load balancer (DONE — domain mapping unavailable)
`gcloud run domain-mappings` returns **501 `UNIMPLEMENTED` in europe-west2**, so
the custom domain is served by an external HTTPS LB + Serverless NEG (Google-
managed cert). Built once (2026-06-25):
```powershell
gcloud compute addresses create staging-mo-ip --global
gcloud compute network-endpoint-groups create staging-mo-neg --region=europe-west2 `
  --network-endpoint-type=serverless --cloud-run-service=measure-once-staging
gcloud compute ssl-certificates create staging-mo-cert --global --domains=staging.harrywardrobes.co.uk
gcloud compute backend-services create staging-mo-backend --global --load-balancing-scheme=EXTERNAL_MANAGED
gcloud compute backend-services add-backend staging-mo-backend --global `
  --network-endpoint-group=staging-mo-neg --network-endpoint-group-region=europe-west2
gcloud compute url-maps create staging-mo-urlmap --default-service=staging-mo-backend
gcloud compute target-https-proxies create staging-mo-proxy --url-map=staging-mo-urlmap --ssl-certificates=staging-mo-cert
gcloud compute forwarding-rules create staging-mo-fr --global --address=staging-mo-ip --target-https-proxy=staging-mo-proxy --ports=443
```
**LB IP: `8.233.47.230`** → goes into Part C. The managed cert stays `PROVISIONING`
until the Part C DNS record resolves to this IP, then auto-issues (15–60 min).

> Public access also required overriding org policy `iam.allowedPolicyMemberDomains`
> (project-scoped `allValues: ALLOW`) + granting `allUsers` `run.invoker` — the org
> blocks public access by default. The same applies to the prod cutover.

---

## Part C — DNS at Hostinger (you)
Because staging is fronted by an HTTPS **load balancer** (not domain mapping), add
an **`A` record** (not a CNAME):
- Host/name: `staging`
- Type: `A`
- Value: **`8.233.47.230`**
- TTL: low (e.g. 300s) while testing

Wait for it to resolve, then for the managed cert to go `ACTIVE` (15–60 min after
DNS resolves). `https://staging.harrywardrobes.co.uk` then works. Check cert:
```powershell
gcloud compute ssl-certificates describe staging-mo-cert --global --format="value(managed.status)"
```

---

## Part D — first-boot config in the staging admin (you)
1. Log in at `https://staging.harrywardrobes.co.uk`.
2. Confirm **dev mode is ON** (Admin panel) — only `hw_test_user` contacts show.
3. **Connect QuickBooks** (its token was cleared) — completes the staging OAuth
   against the staging redirect URI.
4. **Connect Google** (its token was cleared) — same.
5. **Do NOT** open/register HubSpot webhooks here — it would repoint
   production's webhook URL.

---

## Verification checklist
- [ ] Staging loads; login works; only `hw_test_user` contacts appear.
- [ ] A test-contact photo displays (served from `wardrobes-bucket-staging`; old
      photos won't show — expected for a fresh bucket).
- [ ] QuickBooks connected on staging; a test-customer read succeeds.
- [ ] Google connected; calendar/Gmail read succeeds.
- [ ] One real email to a test contact arrives.
- [ ] **Production unaffected:** prod QuickBooks still connected, prod webhooks
      still firing.

---

## Ongoing operations

**Refresh staging data** (anytime, repeatable):
```powershell
# proxy running; $pw set as in B2
pg_dump "postgres://app:$pw@127.0.0.1:15432/measureonce" --no-owner --no-privileges -Fc -f "$env:TEMP\seed.dump"
psql "postgres://app:$pw@127.0.0.1:15432/postgres" -c "DROP DATABASE IF EXISTS measureonce_staging WITH (FORCE);" -c "CREATE DATABASE measureonce_staging OWNER app;"
pg_restore --no-owner --no-privileges --dbname="postgres://app:$pw@127.0.0.1:15432/measureonce_staging" "$env:TEMP\seed.dump"
$env:STAGING_DATABASE_URL = "postgres://app:$pw@127.0.0.1:15432/measureonce_staging"
npm run staging:safety-reset
Remove-Item "$env:TEMP\seed.dump"
# then re-connect QuickBooks + Google in the staging admin (Part D 3–4)
```

**Deploy new code to staging:** build a new image (`gcloud builds submit --tag
…/measure-once:staging-<stamp> .`), apply migrations to staging FIRST
(`DATABASE_URL=<staging socket> npm run db:migrate`), then re-run B4 with the new
image tag.

---

## Teardown / rollback (if you want to remove staging)
```powershell
# Load balancer (reverse order of creation)
gcloud compute forwarding-rules delete staging-mo-fr --global --quiet
gcloud compute target-https-proxies delete staging-mo-proxy --quiet
gcloud compute url-maps delete staging-mo-urlmap --quiet
gcloud compute backend-services delete staging-mo-backend --global --quiet
gcloud compute ssl-certificates delete staging-mo-cert --global --quiet
gcloud compute network-endpoint-groups delete staging-mo-neg --region=europe-west2 --quiet
gcloud compute addresses delete staging-mo-ip --global --quiet
gcloud run services delete measure-once-staging --region=europe-west2
gcloud sql databases delete measureonce_staging --instance=harry-wardrobes-instance
gcloud storage rm --recursive gs://wardrobes-bucket-staging
foreach ($n in "DATABASE_URL_STAGING","SESSION_SECRET_STAGING","QB_TOKEN_ENCRYPTION_KEY_STAGING","GOOGLE_TOKEN_ENCRYPTION_KEY_STAGING") { gcloud secrets delete $n }
```
Then remove the staging DNS record and OAuth redirect URIs. (None of this touches
production.)

---

## The three safety rules (don't skip)
1. **Only act on the test contacts dev mode shows.** Dev mode is a display
   filter, not a write guard — live SMTP/QB/HubSpot will act for real.
2. **Never register/modify HubSpot webhooks on staging** — breaks prod webhooks.
3. **Run `npm run staging:safety-reset` after every data clone** — keeps staging
   from rotating prod's QuickBooks token and from inheriting prod sessions.
