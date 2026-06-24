# GCP migration runbook

Stand up Measure Once on Google Cloud **alongside** the existing Replit
deployment. Nothing in this runbook cuts over production: it provisions a
parallel GCP environment, copies data into it, and verifies it. Replit stays
authoritative throughout. The cutover (DNS, Cloud Run deploy, final delta sync,
the `RUN_MIGRATIONS_ON_BOOT` decision) is a **separate later step** and is not
covered here.

The `gcloud` / Cloud SQL / IAM commands below are written for a human to run
from a workstation with the Cloud SDK installed and authenticated
(`gcloud auth login`). They are not executed by any script in this repo. The
only automated piece is the object-copy script in [Phase 6](#phase-6--object-migration).

> **Safety first — read [the safety section](#safety) before running anything.**
> This environment holds live customer PII. Keep dumps encrypted, never commit
> dumps or secret values, and match the PostgreSQL major version (16).

---

## Parameters

UK data residency. Set these in your shell so the commands below can be copied
verbatim. Pick a globally-unique suffix for the bucket name.

```bash
export PROJECT_ID=measure-once-prod
export REGION=europe-west2            # London
export SQL_INSTANCE=measure-once-pg
export DB_NAME=measureonce
export DB_USER=app
export GCS_BUCKET=measure-once-media-<unique-suffix>
export RUN_SA=measure-once-run        # runtime service account (short name)
```

`SQL_INSTANCE` must be **`POSTGRES_16`** to match the Replit Postgres 16 source
(`pg_dump`/`pg_restore` require the same major version).

---

## Phase 0 — Project & APIs

```bash
gcloud config set project "$PROJECT_ID"

gcloud services enable \
  sqladmin.googleapis.com \
  storage.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  run.googleapis.com \
  compute.googleapis.com
```

(`run.googleapis.com` and `compute.googleapis.com` are enabled now so the later
cutover step has nothing to wait on; no Cloud Run service is deployed here.)

---

## Phase 1 — Cloud SQL (PostgreSQL 16)

Create the instance, database, and application user. Enable automated backups
and point-in-time recovery (PITR).

```bash
# Instance — Postgres 16, regional, with backups + PITR.
gcloud sql instances create "$SQL_INSTANCE" \
  --database-version=POSTGRES_16 \
  --region="$REGION" \
  --tier=db-custom-2-7680 \
  --storage-auto-increase \
  --backup-start-time=02:00 \
  --enable-point-in-time-recovery \
  --availability-type=ZONAL

# Application database.
gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE"

# Application user. Generate a strong password and store it in Secret Manager
# (Phase 4) — do NOT paste a real password into committed files or shell history.
DB_PASSWORD="$(openssl rand -base64 30)"
gcloud sql users create "$DB_USER" \
  --instance="$SQL_INSTANCE" \
  --password="$DB_PASSWORD"
```

### Connectivity

Prefer the **Cloud SQL Auth Proxy** (or private IP) over a public IP with
authorized networks. The Auth Proxy gives an encrypted, IAM-authenticated
tunnel with no broad network exposure.

- For migration from your workstation, run the proxy locally:

  ```bash
  # Download the proxy, then:
  ./cloud-sql-proxy "$PROJECT_ID:$REGION:$SQL_INSTANCE" &
  # App connects to 127.0.0.1:5432 through the tunnel.
  ```

- For the eventual Cloud Run service (later cutover step), attach the instance
  via `--add-cloudsql-instances` and connect over the Unix socket, or use
  private IP + Serverless VPC connector. Decide at cutover, not here.

The runtime `DATABASE_URL` is built from these parameters and stored in Secret
Manager (Phase 4), e.g.
`postgres://app:<password>@/<DB_NAME>?host=/cloudsql/$PROJECT_ID:$REGION:$SQL_INSTANCE`
for the socket form, or `postgres://app:<password>@127.0.0.1:5432/<DB_NAME>`
through the local proxy.

---

## Phase 2 — GCS bucket

Create the media bucket with **uniform bucket-level access** (no per-object
ACLs) and **public-access prevention** enforced. Object names are preserved
exactly by the copy script — do not enable any name transformation.

```bash
gcloud storage buckets create "gs://$GCS_BUCKET" \
  --project="$PROJECT_ID" \
  --location="$REGION" \
  --uniform-bucket-level-access \
  --public-access-prevention

# Optional but recommended: keep deleted/overwritten objects recoverable
# during the parallel-run window.
gcloud storage buckets update "gs://$GCS_BUCKET" \
  --versioning
```

This is the bucket the application reads/writes when running with
`STORAGE_BACKEND=gcs` and `GCS_BUCKET=$GCS_BUCKET` (see `storage.js`). It is the
**destination** for the object copy in Phase 6.

---

## Phase 3 — Least-privilege IAM

Create a dedicated runtime service account and grant only what the app needs:
Cloud SQL client (project binding) and object admin on the **one** media bucket
(bucket binding, not project-wide). Use Application Default Credentials — **no
exported key files**.

```bash
gcloud iam service-accounts create "$RUN_SA" \
  --display-name="Measure Once runtime"

RUN_SA_EMAIL="$RUN_SA@$PROJECT_ID.iam.gserviceaccount.com"

# Cloud SQL connectivity (project-level role, scoped to this project's instances).
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$RUN_SA_EMAIL" \
  --role="roles/cloudsql.client"

# Object read/write on the single media bucket only (bucket-scoped binding).
gcloud storage buckets add-iam-policy-binding "gs://$GCS_BUCKET" \
  --member="serviceAccount:$RUN_SA_EMAIL" \
  --role="roles/storage.objectAdmin"

# Secret access is granted per-secret in Phase 4 (roles/secretmanager.secretAccessor).
```

At cutover the Cloud Run service runs **as** this service account
(`--service-account=$RUN_SA_EMAIL`), so ADC resolves to it automatically with
no key material on disk. For local verification (Phase 7) use
`gcloud auth application-default login` or impersonation
(`--impersonate-service-account=$RUN_SA_EMAIL`).

---

## Phase 4 — Secret Manager

Store every runtime secret as a Secret Manager secret. **Never commit values**;
create secrets from files you delete afterwards or from a secure prompt. Grant
the runtime service account `secretAccessor` on each.

Secrets the app needs at runtime:

- `DATABASE_URL`
- `SESSION_SECRET`
- `HUBSPOT_TOKEN`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (and any other `GOOGLE_*` OAuth values)
- `GOOGLE_PLACES_API_KEY`
- `QB_CLIENT_ID`, `QB_CLIENT_SECRET` (and any other `QB_*` values)
- Token-encryption key(s) used to encrypt stored Google/QuickBooks tokens

```bash
# Example for one secret. Repeat per secret above.
printf '%s' "$DATABASE_URL" | gcloud secrets create DATABASE_URL \
  --replication-policy="user-managed" --locations="$REGION" \
  --data-file=-

# Grant the runtime SA read access to that secret.
gcloud secrets add-iam-policy-binding DATABASE_URL \
  --member="serviceAccount:$RUN_SA_EMAIL" \
  --role="roles/secretmanager.secretAccessor"
```

At cutover, wire each secret into the Cloud Run service with
`--set-secrets=NAME=SECRET:latest`. Do not bake secret values into images or
config.

---

## Phase 5 — Database migration

Move the schema **and data** from the Replit Postgres 16 source into Cloud SQL
using a custom-format dump. Use `--no-owner --no-privileges` so objects restore
under the Cloud SQL `app` user regardless of source ownership.

```bash
# 1. Dump the source (Replit) DB. Run where SOURCE DATABASE_URL is available.
pg_dump "$SOURCE_DATABASE_URL" \
  --no-owner --no-privileges -Fc \
  -f measureonce.dump

# 2. Restore into Cloud SQL (through the Auth Proxy from Phase 1).
pg_restore \
  --no-owner --no-privileges \
  --dbname="postgres://$DB_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME" \
  measureonce.dump
```

### Bookkeeping tables must come across

Both migration-bookkeeping tables must be present in the destination after the
restore, or the app re-runs migrations on first boot:

- `pgmigrations` — owned by `node-pg-migrate` (this repo's migrations).
- `public.migrations` — owned by `@acpr/rate-limit-postgresql` (rate-limit
  bookkeeping; see `db-migrate.js`). **Never drop it.**

A full `pg_dump` includes both. Confirm they restored before trusting the copy.

### Row-count verification

Record source counts before the dump and destination counts after the restore,
then compare. Any mismatch means stop and investigate.

```sql
SELECT 'users'                       AS t, count(*) FROM users
UNION ALL SELECT 'sessions',                 count(*) FROM sessions
UNION ALL SELECT 'design_visits',            count(*) FROM design_visits
UNION ALL SELECT 'customer_info_submissions',count(*) FROM customer_info_submissions
UNION ALL SELECT 'quickbooks_tokens',        count(*) FROM quickbooks_tokens
UNION ALL SELECT 'pgmigrations',             count(*) FROM pgmigrations
UNION ALL SELECT 'public.migrations',        count(*) FROM public.migrations;
```

(Adjust the `quickbooks_tokens` table name to the actual QuickBooks token table
if it differs in the current schema.)

---

## Phase 6 — Object migration

Mirror every object from the live Replit bucket into `$GCS_BUCKET` using the
repo's idempotent, resumable copy script, `scripts/migrate-objects.mjs`.

**Run environment:** run this from the **Replit shell** so the *source* bucket
is wired in automatically via `.replit` (the default `replit` backend). The
*destination* uses GCP Application Default Credentials — authenticate with
`gcloud auth application-default login` (or impersonate `$RUN_SA_EMAIL`) and set
`DEST_GCS_BUCKET` to `$GCS_BUCKET`. The script **refuses to run with
`STORAGE_BACKEND=gcs`** so it can never read and write the same GCS bucket;
leave `STORAGE_BACKEND` unset (or `replit`).

```bash
# 1. Dry run — lists what would copy, writes nothing (no DEST needed for listing,
#    but pass it so the output matches the real run).
DEST_GCS_BUCKET="$GCS_BUCKET" npm run migrate:objects:dry-run

# 2. Real copy.
DEST_GCS_BUCKET="$GCS_BUCKET" npm run migrate:objects

# Optional: scope to a namespace, or tune parallelism.
DEST_GCS_BUCKET="$GCS_BUCKET" node scripts/migrate-objects.mjs --prefix=customer-info-photos/
COPY_CONCURRENCY=16 DEST_GCS_BUCKET="$GCS_BUCKET" npm run migrate:objects
```

**Idempotency:** the script checks each destination object via `getMetadata()`
and skips it when the name and byte size already match, so a re-run only copies
what is missing or changed. It never deletes or mutates source objects and does
no DB access. The final line is a `total / copied / skipped / failed` summary;
it lists any failed object names and exits non-zero if anything failed — re-run
to resume.

### Verify the copy

```bash
# Object count at destination.
gcloud storage ls "gs://$GCS_BUCKET/**" | wc -l

# Spot-check sizes / checksums on a sample of objects. The dry-run output lists
# source byte sizes; compare a handful against the destination:
gcloud storage ls -l "gs://$GCS_BUCKET/<some-object-name>"

# Or compare CRC32C/MD5 of a sample:
gcloud storage hash "gs://$GCS_BUCKET/<some-object-name>"
```

Confirm the destination object count matches the source listing and that
sampled byte sizes/checksums agree before trusting the copy.

### End-to-end retrieval check (through `storage.js`)

The `gcloud storage hash` spot-checks above prove the bytes landed in the
bucket, but **not** that the application can serve them back through its own
storage abstraction once the GCS backend is active — that path can still break
on a key-format mismatch or content/metadata regression a size check would miss.
Run the read-only verification harness, `scripts/verify-objects.mjs`, to close
that gap. It reads the **destination through `storage.js` with the GCS backend
active** (exactly how the running app serves photos) and compares a random
sample, byte-for-byte (SHA-256 + length), against the same object names read
from the live Replit source.

Run it from the **Replit shell** (so the *source* bucket is wired in via
`.replit`). Point `storage.js` at the destination with `STORAGE_BACKEND=gcs` and
`GCS_BUCKET=$GCS_BUCKET`; GCS reads use Application Default Credentials
(`gcloud auth application-default login` or `$RUN_SA_EMAIL` impersonation).

```bash
# Verify a random sample from BOTH namespaces (customer-info-photos/ and
# design-visit-images/ — the two distinct key formats), 10 objects each:
STORAGE_BACKEND=gcs GCS_BUCKET="$GCS_BUCKET" npm run verify:objects

# Larger sample per namespace, or scope to one namespace, or make it repeatable:
STORAGE_BACKEND=gcs GCS_BUCKET="$GCS_BUCKET" node scripts/verify-objects.mjs --sample=25
STORAGE_BACKEND=gcs GCS_BUCKET="$GCS_BUCKET" node scripts/verify-objects.mjs --prefix=customer-info-photos/
STORAGE_BACKEND=gcs GCS_BUCKET="$GCS_BUCKET" node scripts/verify-objects.mjs --seed=42
```

The harness is **read-only** — it downloads from both buckets and compares; it
never uploads, deletes, or mutates either bucket and does no DB access. It
refuses to run unless `STORAGE_BACKEND=gcs` (the whole point is to exercise the
GCS-served path) and exits non-zero if any sampled object is missing from GCS or
differs from the source. The final line is a `checked / ok / missing / mismatch`
summary per namespace plus a total. Treat a clean `VERIFICATION PASSED` across
both namespaces as the concrete sign-off for object retrieval — richer than a
`gcloud storage hash` spot-check because it goes through `storage.js`
end-to-end.

---

## Phase 7 — Verification (no cutover)

Optionally exercise the new stack **without** taking any production traffic.
Replit stays authoritative; this only proves the GCP environment is wired
correctly.

- Run the container/app **locally** pointed at Cloud SQL (through the Auth
  Proxy) and `$GCS_BUCKET`:

  ```bash
  STORAGE_BACKEND=gcs \
  GCS_BUCKET="$GCS_BUCKET" \
  DATABASE_URL="postgres://$DB_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME" \
  NODE_ENV=production \
  node server.js
  ```

- Use **safe / sandbox values** for outbound integrations so verification never
  emails customers or mutates real third-party records: a sandbox/blackhole SMTP
  target, HubSpot sandbox or read-only token, QuickBooks sandbox credentials.

- Sanity-check: log in, load dashboards, open a design visit, view a
  customer-info submission photo (served from `$GCS_BUCKET`), and confirm no
  boot-time migrations ran (because `pgmigrations` / `public.migrations` came
  across in Phase 5).

- Do **not** change DNS, deploy a public Cloud Run service, or run a final delta
  sync — those belong to the separate cutover step.

---

## Safety

- **Live customer PII.** The database dump and the media objects contain real
  customer data. Keep the `pg_dump` file encrypted at rest, transfer it only
  over secure channels, and **delete it after a verified restore**.
- **Never commit dumps or secrets.** No `*.dump`, no secret values, no bucket
  contents, no `DATABASE_URL` with credentials in any committed file or shell
  history that gets committed. Secrets live only in Secret Manager.
- **Preserve object names.** The opaque-key format and object-name layout are
  load-bearing (the app reconstructs keys from names). The copy script keeps
  names byte-for-byte identical — do not rename or re-prefix objects.
- **Match the Postgres major version (16).** `pg_dump`/`pg_restore` across major
  versions can fail or silently differ. Cloud SQL must be `POSTGRES_16`.
- **Least privilege.** The runtime service account gets `cloudsql.client`
  (project) and `storage.objectAdmin` on the single media bucket only, plus
  per-secret `secretAccessor`. No key files — ADC only.
- **Everything is reversible.** GCP is stood up in parallel; Replit remains the
  source of truth. Nothing here is destructive to production, and the cutover is
  a separate, later, explicitly-decided step.
