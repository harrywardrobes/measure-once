# GCP cutover runbook

This is the **production cutover** for moving Measure Once off Replit onto
Google Cloud (Cloud Run + Cloud SQL + GCS). Unlike the parallel stand-up in
[docs/gcp-migration.md](gcp-migration.md) — which copies data into a GCP
environment **without** touching production — this runbook *flips production
over*. It has a real freeze window with customer-facing downtime and limited
reversibility, so execute it deliberately, in order, and do not skip the
verification gates.

This document is for a **human operator** with the Cloud SDK installed and
authenticated. No script in this repo runs `gcloud`, changes DNS, or performs
the cutover. Replit stays authoritative until the operator finishes Phase C and
flips DNS.

**Prerequisites:** [docs/gcp-migration.md](gcp-migration.md) Phases 0–4 are
already done — the project, Cloud SQL instance, GCS bucket, IAM service account,
and Secret Manager secrets exist and have been verified in a rehearsal run.

> **Safety first — read [the safety section](#safety) before running anything.**
> This holds live customer PII. Keep dumps encrypted, never commit dumps or
> secret values, match the PostgreSQL major version (16), and keep Replit
> stopped-but-intact as a warm rollback through the soak period.

---

## ⚠️ CRITICAL — pgmigrations pre-flight reconciliation (read first)

**This is the single most dangerous step in the cutover. Get it wrong and the
new server either crash-loops on boot or silently re-applies migrations against
a schema that already has them.**

### Why this is a trap on this app

In Replit **production**, `node-pg-migrate` was **never run at boot** — the
production schema has been maintained by Replit's publish-time dev→prod diff,
not by this repo's migration runner (see `replit.md` → "Stack"). That means the
live production `pgmigrations` table **may not list migrations whose schema
changes are already present in the database.** It can be empty, partial, or
stale even though the schema is fully up to date.

If you restore that database into Cloud SQL and then run `npm run db:migrate`,
node-pg-migrate will look at `pgmigrations`, conclude those "missing" migrations
have not run, and **try to apply them again** against a schema that already has
the columns/tables/constraints. With `singleTransaction: true` (see
`db-migrate.js`) the whole run aborts on the first `already exists` error and
nothing changes — but you are now stuck and cannot deploy.

> **Note on `public.migrations`:** this is a *separate* bookkeeping table owned
> by `@acpr/rate-limit-postgresql`, not node-pg-migrate. A full `pg_dump` brings
> it across, and `db-migrate.js` self-heals it on boot via
> `ensureRateLimitMigrations()`. Do not confuse it with `pgmigrations` and never
> drop it.

### Decide which branch you are in

After the restore (Phase C step 4), inspect the destination `pgmigrations`
table and compare it against the files in `migrations/`:

```bash
# Files this repo expects to be applied (names node-pg-migrate records, no .js):
ls migrations/*.js | sed 's#.*/##; s#\.js$##' | sort > /tmp/files.txt

# Names already recorded as applied in the restored DEST database:
psql "$DEST_DATABASE_URL" -At -c \
  "SELECT name FROM pgmigrations ORDER BY name" | sort > /tmp/applied.txt

# Files NOT recorded as applied in DEST (the reconciliation candidates):
comm -23 /tmp/files.txt /tmp/applied.txt
```

`scripts/verify-migration.mjs` Section 3 reports exactly this list too — use
either.

#### Branch (a) — pgmigrations already matches `migrations/`

`comm -23` prints nothing (or only genuinely **new** migration files added
since the schema was last updated).

1. Restore is done (Phase C step 4).
2. Run the migrator — it is a no-op, or applies only the genuinely new files:
   ```bash
   DATABASE_URL="$DEST_DATABASE_URL" npm run db:migrate
   ```
3. Confirm zero pending afterwards (re-run; it should report nothing to run).
4. Proceed with the cutover.

#### Branch (b) — pgmigrations incomplete while the schema is current (the likely Replit case)

`comm -23` prints migration files **whose changes are already in the schema**
(because Replit applied them via its dev→prod diff, not via node-pg-migrate).

**Do NOT run `npm run db:migrate` to "catch up" — it will try to re-apply
already-applied migrations and fail.** Instead, reconcile `pgmigrations` so it
**records every already-applied file as applied, WITHOUT running it**:

1. Insert one `pgmigrations` row per already-applied migration file, with
   `run_on = now()`. node-pg-migrate's table is `(id serial, name text, run_on
   timestamp)`; only `name` and `run_on` matter.

   ```bash
   # For EACH name printed by `comm -23 /tmp/files.txt /tmp/applied.txt`
   # whose schema change you have CONFIRMED is already present in DEST:
   psql "$DEST_DATABASE_URL" -c \
     "INSERT INTO pgmigrations (name, run_on)
        SELECT '<migration_name>', now()
      WHERE NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name = '<migration_name>')"
   ```

   > Confirm the schema change is genuinely present before inserting its row.
   > Marking a migration applied when its change is *not* in the schema would
   > skip a real change at boot. If any listed file is a **genuinely new**
   > migration whose change is NOT yet in the schema, leave it out here and let
   > step 3 apply it.

2. Do **not** run pending migrations as part of the cutover freeze. The freeze
   window is for data sync and the DNS flip, not schema churn.

3. Verify reconciliation succeeded — `db:migrate` must now report **zero
   pending** (or apply only the genuinely-new files you intentionally left out
   of step 1):
   ```bash
   DATABASE_URL="$DEST_DATABASE_URL" npm run db:migrate
   # Expect: "No migrations to run!" (or only the genuinely-new files).
   ```
   Re-run `scripts/verify-migration.mjs` and confirm **Section 3 = PASS**.

### Going forward on Cloud Run

- Keep **`RUN_MIGRATIONS_ON_BOOT` unset** on Cloud Run. Boot-time migration is a
  fail-closed convenience for development; in production it risks a crash-loop on
  a bad migration during an autoscale event.
- Apply **future** migrations with the pre-deploy step `npm run db:migrate`
  against the production `DATABASE_URL`, then deploy the new image. The migrator
  has no dev-only guards, so this works against prod directly.

---

## Parameters

Reuse the same parameters as the stand-up runbook (UK data residency). Set them
in your shell so the commands below copy verbatim.

```bash
export PROJECT_ID=measure-once-prod
export REGION=europe-west2            # London
export SQL_INSTANCE=measure-once-pg
export DB_NAME=measureonce
export DB_USER=app
export GCS_BUCKET=measure-once-media-<unique-suffix>
export RUN_SA=measure-once-run
export RUN_SA_EMAIL="$RUN_SA@$PROJECT_ID.iam.gserviceaccount.com"
export AR_REPO=measure-once           # Artifact Registry repo
export SERVICE=measure-once           # Cloud Run service name
export DOMAIN=measure.harrywardrobes.co.uk
```

Cloud SQL **must** be `POSTGRES_16` to match the Replit Postgres 16 source —
`pg_dump`/`pg_restore` require the same major version.

---

## Phase A — Build & push the image to Artifact Registry

Build the production container and push it to Artifact Registry. No traffic is
affected.

```bash
# One-time: create the Artifact Registry Docker repo (skip if it exists).
gcloud artifacts repositories create "$AR_REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --description="Measure Once container images"

# Configure Docker auth for Artifact Registry.
gcloud auth configure-docker "$REGION-docker.pkg.dev"

# Build and push. Cloud Build keeps the build off your workstation:
export IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO/$SERVICE:$(date +%Y%m%d-%H%M%S)"
gcloud builds submit --tag "$IMAGE" .
```

The image must run `node server.js` and contain a production React build (the
repo's build step is `npm run build:react && npm run build:storybook` — ensure
the Dockerfile runs it, since `public/react/` and `public/storybook/` are
gitignored build artifacts). Record the exact `$IMAGE` tag — Phases B and C
deploy it.

---

## Phase B — Deploy to Cloud Run against rehearsal data (no DNS)

Deploy the image to Cloud Run pointed at the **rehearsal** Cloud SQL data from
the stand-up runbook, with **no domain mapping**. This proves the image, secrets,
Cloud SQL socket, and GCS wiring all work before the real freeze.

```bash
gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --region="$REGION" \
  --service-account="$RUN_SA_EMAIL" \
  --add-cloudsql-instances="$PROJECT_ID:$REGION:$SQL_INSTANCE" \
  --no-allow-unauthenticated \
  --port=5000 \
  --cpu=1 --memory=512Mi \
  --min-instances=0 --max-instances=4 \
  --set-env-vars="NODE_ENV=production,STORAGE_BACKEND=gcs,GCS_BUCKET=$GCS_BUCKET" \
  --set-secrets="\
DATABASE_URL=DATABASE_URL:latest,\
SESSION_SECRET=SESSION_SECRET:latest,\
HUBSPOT_TOKEN=HUBSPOT_TOKEN:latest,\
GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,\
GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest,\
GOOGLE_PLACES_API_KEY=GOOGLE_PLACES_API_KEY:latest,\
QB_CLIENT_ID=QB_CLIENT_ID:latest,\
QB_CLIENT_SECRET=QB_CLIENT_SECRET:latest"
```

- The Cloud SQL **unix-socket** `DATABASE_URL` form (stored in Secret Manager):
  ```
  postgres://app:<password>@/measureonce?host=/cloudsql/measure-once-prod:europe-west2:measure-once-pg
  ```
  i.e. `postgres://$DB_USER:<password>@/$DB_NAME?host=/cloudsql/$PROJECT_ID:$REGION:$SQL_INSTANCE`.
  Cloud Run mounts the socket at `/cloudsql/...` because of
  `--add-cloudsql-instances`.
- Keep `RUN_MIGRATIONS_ON_BOOT` **unset** (see the pre-flight section).

### Smoke test (rehearsal, safe integrations)

Use **safe / sandbox values** for every outbound integration so the rehearsal
never emails customers or mutates real third-party records — a blackhole/sandbox
SMTP target, a HubSpot sandbox or read-only token, QuickBooks sandbox
credentials. Reach the service through its `*.run.app` URL (use a proxied/
identity-token request since it is `--no-allow-unauthenticated`).

- Log in, load the dashboards, open a design visit.
- Open a customer-info submission photo (served from `$GCS_BUCKET` via
  `STORAGE_BACKEND=gcs`).
- Confirm the logs show **no boot-time migrations ran** (because `pgmigrations`
  came across in the restore and was reconciled).

Fix any wiring problems here, while it is still a rehearsal with zero customer
impact. Do not proceed to Phase C until Phase B is clean.

---

## Phase C — Cutover window (production freeze)

This is the only step with customer-facing downtime. Work through it without
pausing once the freeze begins; total freeze is typically well under an hour.

1. **Announce** the maintenance window to staff (and customers if appropriate)
   with a start time and expected duration. Lower the DNS TTL on `$DOMAIN` to a
   small value (e.g. 60s) **at least 24h ahead** so the later flip propagates
   fast.

2. **Freeze writes — take Replit offline.** Stop the Replit deployment so no new
   data can be written to the Replit database or bucket while you take the final
   dump. (Stop the deployment; do not delete it — it is your rollback.) From
   this moment the app is down for users.

3. **Fresh `pg_dump` of the live Replit source.** Run where
   `$SOURCE_DATABASE_URL` is available (Postgres 16, custom format,
   `--no-owner --no-privileges`):
   ```bash
   pg_dump "$SOURCE_DATABASE_URL" --no-owner --no-privileges -Fc -f cutover.dump
   ```

4. **Restore into a clean Cloud SQL database.** Drop/recreate the production
   database (or restore into a fresh one) so there is no rehearsal leftover, then
   restore:
   ```bash
   # Recreate a clean DB (through the Cloud SQL Auth Proxy on 127.0.0.1:5432).
   psql "postgres://$DB_USER:<password>@127.0.0.1:5432/postgres" \
     -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" \
     -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"

   pg_restore --no-owner --no-privileges \
     --dbname="postgres://$DB_USER:<password>@127.0.0.1:5432/$DB_NAME" \
     cutover.dump
   ```

5. **Run the pgmigrations reconciliation branch** from the
   [CRITICAL pre-flight](#️-critical--pgmigrations-pre-flight-reconciliation-read-first)
   above (almost certainly **branch (b)** for this app). Then confirm **zero
   pending**:
   ```bash
   DATABASE_URL="$DEST_DATABASE_URL" npm run db:migrate   # expect: No migrations to run!
   ```

6. **Re-run the object copy for the delta.** Most objects were copied during the
   parallel run; this catches anything written since. It is idempotent — only
   missing/changed objects copy:
   ```bash
   DEST_GCS_BUCKET="$GCS_BUCKET" npm run migrate:objects
   ```

7. **Verify parity — hard gate.** Run the read-only checker against the final
   data:
   ```bash
   SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
   DEST_DATABASE_URL="$DEST_DATABASE_URL" \
   DEST_GCS_BUCKET="$GCS_BUCKET" \
   npm run verify:migration
   ```
   **All three sections must report PASS.** If any DB table count mismatches,
   objects differ, or a migration file is unrecorded, **stop and resolve it
   before flipping DNS.** This is the point of no easy return.

8. **Deploy production to Cloud Run** (same `$IMAGE` as Phase A/B) now pointed at
   the freshly-restored production data, then **create the domain mapping** and
   **flip DNS**:
   ```bash
   # If the service should be publicly reachable, allow unauthenticated and map the domain.
   gcloud run services update "$SERVICE" --region="$REGION" --allow-unauthenticated

   gcloud beta run domain-mappings create \
     --service="$SERVICE" \
     --domain="$DOMAIN" \
     --region="$REGION"
   ```
   The command prints the DNS records to add. Update the `$DOMAIN` records at
   your DNS provider to point at Cloud Run (the TTL you lowered in step 1 makes
   this propagate quickly).

9. **Switch sandbox integrations to production values.** Update the relevant
   Secret Manager secrets (HUBSPOT_TOKEN, QB_* , SMTP, Google OAuth redirect)
   from sandbox to **production** values and roll the service so it picks them up:
   ```bash
   gcloud run services update "$SERVICE" --region="$REGION" \
     --set-secrets="HUBSPOT_TOKEN=HUBSPOT_TOKEN:latest,QB_CLIENT_ID=QB_CLIENT_ID:latest,QB_CLIENT_SECRET=QB_CLIENT_SECRET:latest"
   ```
   Ensure the Google/QuickBooks OAuth **redirect URIs** for the production domain
   are registered in their respective consoles before relying on those flows.

10. **Smoke-test the production domain.** Once DNS resolves to Cloud Run, hit
    `https://$DOMAIN`: log in, load dashboards, open a design visit, open a
    customer photo (from `$GCS_BUCKET`), send one real test email to an internal
    address, confirm a HubSpot read and a QuickBooks read succeed. The freeze
    ends when this passes.

---

## Phase D — Post-cutover verification & soak

1. **Re-run `verify:migration`** against the now-live data to confirm parity held
   through the flip:
   ```bash
   SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
   DEST_DATABASE_URL="$DEST_DATABASE_URL" \
   DEST_GCS_BUCKET="$GCS_BUCKET" \
   npm run verify:migration
   ```

2. **Watch Cloud Run logs** for errors, restart loops, or unhandled rejections:
   ```bash
   gcloud run services logs read "$SERVICE" --region="$REGION" --limit=200
   ```

3. **Confirm the critical flows on the live domain:** login/session, photo
   signing & display (GCS), outbound email, HubSpot read+write, QuickBooks
   read+write. Exercise one real-but-low-impact write of each integration.

4. **Keep Replit stopped-but-intact as a warm rollback** for a defined soak
   period (e.g. **7 days**). Do **not** decommission Replit, delete the source
   database, or delete the source bucket until the soak completes clean. The
   `cutover.dump` file stays encrypted and is deleted only after the soak.

5. After a clean soak, decommissioning Replit is a **separate, explicitly
   decided** step — out of scope for this runbook.

---

## Rollback plan

Rollback is **only clean if you do it before customers write meaningful data to
Cloud Run.** The longer the new stack serves traffic, the more data you would
lose by reverting.

1. **Flip DNS back to Replit.** Point `$DOMAIN` back at the Replit deployment
   (fast because the TTL is already low).
2. **Restart the Replit deployment** (it has been stopped-but-intact since
   Phase C step 2). It still holds the database and bucket exactly as they were
   at the freeze.
3. Optionally take Cloud Run private again (`--no-allow-unauthenticated`) so no
   traffic reaches it during investigation.

> **⚠️ DATA-LOSS CAVEAT.** Any writes made on Cloud Run **after** the DNS flip
> (new logins/sessions, customer-info submissions, design-visit edits, uploaded
> photos, QuickBooks/HubSpot changes) exist **only** in Cloud SQL + GCS, **not**
> in the frozen Replit source. Rolling back to Replit **discards every such
> write.** If meaningful customer data has been written post-cutover, do **not**
> roll back blindly — reconcile that data forward into Replit first, or accept
> the loss as a deliberate decision. This is why the soak keeps Replit warm but
> treats Cloud Run as authoritative the moment DNS flips.

---

## Safety

- **Live customer PII.** `cutover.dump` and the media objects contain real
  customer data. Keep the dump encrypted at rest, transfer it only over secure
  channels, and **delete it after a verified, soaked cutover** — not before.
- **Never commit dumps or secrets.** No `*.dump`, no secret values, no bucket
  contents, no `DATABASE_URL` with credentials in any committed file or shell
  history. Secrets live only in Secret Manager.
- **`pgmigrations` is the trap.** Re-read the
  [CRITICAL pre-flight](#️-critical--pgmigrations-pre-flight-reconciliation-read-first)
  before running `db:migrate` against the restored DB. Reconcile, do not
  re-apply. Never drop `public.migrations`.
- **`verify:migration` is a hard gate.** Do not flip DNS until all three of its
  sections report PASS. It is strictly read-only and safe to run as often as you
  like.
- **Match the Postgres major version (16).** `pg_dump`/`pg_restore` across major
  versions can fail or silently differ. Cloud SQL must be `POSTGRES_16`.
- **Least privilege, ADC only.** The runtime service account gets
  `cloudsql.client` (project) and `storage.objectAdmin` on the single media
  bucket, plus per-secret `secretAccessor`. No key files — Cloud Run runs as the
  service account and ADC resolves automatically.
- **Keep `RUN_MIGRATIONS_ON_BOOT` unset on Cloud Run.** Apply future migrations
  via the pre-deploy `npm run db:migrate` step, never at boot.
- **Warm rollback through the soak.** Replit stays stopped-but-intact for the
  soak period so a fast DNS-revert is always possible — subject to the data-loss
  caveat above.
