# GCP cutover — execution sheet (filled-in, copy-paste ready)

This is the **operator sheet** for the production freeze + DNS flip, with the real
`harry-wardrobes` values already filled in. It is the concrete companion to the
generic [docs/gcp-cutover.md](gcp-cutover.md) — read that once for the *why*; use
this for the *what to type*. Phases 0–4 (project, Cloud SQL, bucket, IAM,
secrets) and the **rehearsal (image build + Cloud Run deploy)** are already done.

> ⚠️ This is the only customer-facing step. It has a real freeze window. Work
> through it in order, do not skip the `verify:migration` gate, and keep Replit
> stopped-but-intact as a warm rollback through the soak.

Commands are **PowerShell on the workstation** unless explicitly marked
**[Replit shell]**. Postgres client tools are version-pinned: **PG16** to dump
the Neon source, **PG18** to restore into Cloud SQL.

---

## Known environment values

| Thing | Value |
|---|---|
| Project | `harry-wardrobes` |
| Region | `europe-west2` |
| Cloud SQL instance | `harry-wardrobes-instance` (POSTGRES_18) |
| Connection name | `harry-wardrobes:europe-west2:harry-wardrobes-instance` |
| App DB / user | `measureonce` / `app` |
| Bucket | `wardrobes-bucket` |
| Runtime SA | `wardrobes-run@harry-wardrobes.iam.gserviceaccount.com` |
| Artifact Registry repo | `measure-once` |
| Cloud Run service | `measure-once` |
| Service URL (rehearsal) | `https://measure-once-473090168235.europe-west2.run.app` |
| Production domain | `handle.harrywardrobes.co.uk` |
| Source (Neon) | Postgres 16 — pull current URL from Replit secrets at cutover |
| PG16 tools | `C:\Program Files\PostgreSQL\16\bin\` |
| PG18 tools | `C:\Program Files\PostgreSQL\18\bin\` |
| Cloud SQL Auth Proxy | `%USERPROFILE%\cloud-sql-proxy.exe` |

---

## T‑minus 24h — prerequisites (do the day before)

1. **Lower the DNS TTL** on `handle.harrywardrobes.co.uk` to **60s** at your DNS
   provider, so the flip propagates fast. (Must be done ≥24h ahead to take effect.)
2. **Register production OAuth redirect URIs** in the consoles:
   - Google OAuth client → `https://handle.harrywardrobes.co.uk/auth/google/callback`
   - QuickBooks app → `https://handle.harrywardrobes.co.uk/auth/quickbooks/callback`
3. **Have production integration values ready** to load into Secret Manager
   (current values are sandbox/safe): `HUBSPOT_ACCESS_TOKEN`, `QB_CLIENT_ID`,
   `QB_CLIENT_SECRET`, `QB_ENVIRONMENT` (→ `production`), `SMTP_*`, and any
   Google production values.
4. **Rotate the Neon password** if not already done (it was exposed in chat),
   and confirm you have the current `SOURCE_DATABASE_URL`.
5. Confirm the workstation toolchain still resolves (new terminal):
   ```powershell
   & "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" --version   # 16.x
   & "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" --version # 18.x
   gcloud --version
   Test-Path "$env:USERPROFILE\cloud-sql-proxy.exe"
   ```

---

## Step 0 — Shell setup (workstation)

```powershell
# Refresh PATH (each new terminal) and pin tool paths.
$machinePath = [Environment]::GetEnvironmentVariable("Path","Machine")
$userPath    = [Environment]::GetEnvironmentVariable("Path","User")
$env:Path = "$machinePath;$userPath"

$PG16 = "C:\Program Files\PostgreSQL\16\bin"
$PG18 = "C:\Program Files\PostgreSQL\18\bin"
gcloud config set project harry-wardrobes

# Source (Neon) — paste the CURRENT Neon URL (post-rotation). Keep it out of history where possible.
$SOURCE_DATABASE_URL = "<paste current Neon postgresql://… URL>"

# Destination (Cloud SQL via local proxy, started in Step 3). Built from the
# DATABASE_URL secret by swapping the socket host for the proxy address — this
# reuses the correct URL-encoded password with no copy/paste.
$dbSocket = (gcloud secrets versions access latest --secret=DATABASE_URL)
$DEST_DATABASE_URL = $dbSocket -replace '@/measureonce\?host=/cloudsql/[^\s"]+','@127.0.0.1:5432/measureonce'
```

---

## Step 1 — Freeze writes (take Replit offline)

**[Replit dashboard]** Stop the Replit deployment so no new rows or photos are
written after this moment. **Stop it — do NOT delete it** (it is your rollback).
From here the app is down for users; work through to Step 11 without pausing.

---

## Step 2 — Fresh dump of the Neon source (workstation, PG16)

```powershell
$dump = "$env:TEMP\cutover.dump"
& "$PG16\pg_dump.exe" -d $SOURCE_DATABASE_URL `
  --no-owner --no-privileges -Fc `
  --exclude-schema=_system `
  -f $dump
Write-Host "dump exit: $LASTEXITCODE"
(Get-Item $dump).Length
```

> `--exclude-schema=_system` drops Replit's internal `replit_database_migrations_v1`
> bookkeeping (meaningless on Cloud SQL). `rate_limit` and `public` come across.
> This file holds **real customer PII** — keep it on an encrypted disk and delete
> it after a verified, soaked cutover (Safety section).

---

## Step 3 — Restore into a clean Cloud SQL DB (workstation, PG18)

```powershell
# Start the Cloud SQL Auth Proxy (leave this window open, or run as a job).
Start-Process -FilePath "$env:USERPROFILE\cloud-sql-proxy.exe" `
  -ArgumentList "harry-wardrobes:europe-west2:harry-wardrobes-instance"
Start-Sleep -Seconds 6   # let it bind 127.0.0.1:5432

# Recreate measureonce clean (drop rehearsal leftovers). Connect to the 'postgres'
# db to drop/create. Uses the same proxy + app creds.
$adminUrl = $DEST_DATABASE_URL -replace '/measureonce$','/postgres'
& "$PG18\psql.exe" -d $adminUrl -c "DROP DATABASE IF EXISTS measureonce WITH (FORCE);" -c "CREATE DATABASE measureonce OWNER app;"

# Restore.
& "$PG18\pg_restore.exe" --no-owner --no-privileges --dbname=$DEST_DATABASE_URL $dump
Write-Host "restore exit: $LASTEXITCODE (a few benign 'already exists' notices are OK)"
```

---

## Step 4 — pgmigrations reconciliation (the trap — read [[gcp-pgmigrations-reconciliation]])

The Neon source maintains schema via Replit's publish diff, **not** node-pg-migrate,
so `pgmigrations` under-records what is actually applied. **Do NOT run
`db:migrate` to "catch up"** — it would try to re-apply already-present changes
and fail. Reconcile instead.

**4a. Re-derive the gap** (don't assume it matches the rehearsal — re-check):
```powershell
# Files the repo expects, vs names recorded applied in the freshly restored DB.
Get-ChildItem "migrations\*.js" | ForEach-Object { $_.BaseName } | Sort-Object > "$env:TEMP\files.txt"
& "$PG18\psql.exe" -d $DEST_DATABASE_URL -At -c "SELECT name FROM pgmigrations ORDER BY name" | Sort-Object > "$env:TEMP\applied.txt"
# The unrecorded candidates:
Compare-Object (Get-Content "$env:TEMP\files.txt") (Get-Content "$env:TEMP\applied.txt") |
  Where-Object SideIndicator -eq '<=' | ForEach-Object { $_.InputObject }
```

If this list **matches the 20 names in Step 4c** (expected, same source), proceed
with 4b + 4c verbatim. If it differs (new migrations added to the repo since
2026‑06‑25), re-classify each new name: schema-change-already-present → record
only (add to 4c); genuinely new → let `db:migrate` apply it in Step 5.

**4b. Apply the 3 genuinely-unapplied migrations for real** (their DDL is
idempotent — `IF NOT EXISTS` / `DROP TRIGGER IF EXISTS`). Save as
`cutover-apply-pending.sql` and run it:
```sql
-- 1783300000000_survey-visits  (tables + the two sync triggers that were missing)
CREATE TABLE IF NOT EXISTS survey_visits (
  id SERIAL PRIMARY KEY, contact_id TEXT NOT NULL, contact_name TEXT, contact_email TEXT,
  created_by TEXT NOT NULL, design_visit_id INT REFERENCES design_visits(id) ON DELETE SET NULL,
  handle_id INT REFERENCES catalog_handles(id) ON DELETE SET NULL,
  furniture_range_id INT REFERENCES catalog_ranges(id) ON DELETE SET NULL,
  visit_date TIMESTAMPTZ, duration_min INT NOT NULL DEFAULT 90, location TEXT,
  structured_address JSONB, notes TEXT, terms_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  terms_condition_version_id INT REFERENCES terms_conditions_versions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft', qb_estimate_id TEXT, qb_estimate_doc_num TEXT,
  qb_estimate_history JSONB NOT NULL DEFAULT '[]'::jsonb, signoff_token_hash TEXT,
  signoff_expires_at TIMESTAMPTZ, signed_off_at TIMESTAMPTZ,
  superseded_signoff_token_hashes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  revision_note TEXT, refund_requested_at TIMESTAMPTZ, refund_requested_by TEXT,
  refund_reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS survey_visits_contact_id_idx ON survey_visits (contact_id);
CREATE INDEX IF NOT EXISTS survey_visits_status_idx ON survey_visits (status);
CREATE INDEX IF NOT EXISTS survey_visits_design_visit_id_idx ON survey_visits (design_visit_id);
CREATE INDEX IF NOT EXISTS survey_visits_superseded_token_hashes_idx
  ON survey_visits USING GIN (superseded_signoff_token_hashes);
CREATE TABLE IF NOT EXISTS survey_visit_rooms (
  id SERIAL PRIMARY KEY, survey_visit_id INT NOT NULL REFERENCES survey_visits(id) ON DELETE CASCADE,
  source_design_visit_room_id INT REFERENCES design_visit_rooms(id) ON DELETE SET NULL,
  room_name TEXT NOT NULL, door_style_id INT REFERENCES catalog_doors(id) ON DELETE SET NULL,
  width_mm INT, height_mm INT, depth_mm INT, unit_count INT NOT NULL DEFAULT 1,
  unit_price_pence INT NOT NULL DEFAULT 0, notes TEXT, sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS survey_visit_rooms_visit_id_idx ON survey_visit_rooms (survey_visit_id);
CREATE TABLE IF NOT EXISTS survey_visit_room_images (
  id SERIAL PRIMARY KEY, room_id INT NOT NULL REFERENCES survey_visit_rooms(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL, mime_type TEXT, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS svri_room_id_idx ON survey_visit_room_images (room_id);
CREATE TABLE IF NOT EXISTS survey_visit_pending_uploads (
  storage_key TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_survey_visits_sync_meta ON survey_visits;
CREATE TRIGGER trg_survey_visits_sync_meta BEFORE UPDATE ON survey_visits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_and_bump_version();
DROP TRIGGER IF EXISTS trg_survey_visit_rooms_sync_meta ON survey_visit_rooms;
CREATE TRIGGER trg_survey_visit_rooms_sync_meta BEFORE UPDATE ON survey_visit_rooms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_and_bump_version();

-- 1784100000000_restore-legacy-catalog-stub-tables
CREATE TABLE IF NOT EXISTS design_visit_door_styles (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, image_url TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS design_visit_furniture_ranges (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS design_visit_handles (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT, image_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), style TEXT
);

-- 1785900000000_drop-corrected-mobile-from-admin-notification-email
UPDATE email_templates
   SET body_text = replace(body_text,
         E'{{contactPhone}}\n{{correctedMobile}}\nAddress:      {{address}}',
         E'{{contactPhone}}\nAddress:      {{address}}'),
       body_html = replace(body_html,
         E'  {{contactPhone}}\n  {{correctedMobile}}\n  <tr><td><strong>Address</strong></td><td>{{address}}</td></tr>',
         E'  {{contactPhone}}\n  <tr><td><strong>Address</strong></td><td>{{address}}</td></tr>')
 WHERE key = 'admin_notification' AND body_text LIKE '%{{correctedMobile}}%';
```
```powershell
& "$PG18\psql.exe" -d $DEST_DATABASE_URL -v ON_ERROR_STOP=1 -f "cutover-apply-pending.sql"
```

**4c. Record all 20 unrecorded names as applied** (one contiguous block, exact
lexicographic order, so node-pg-migrate's `checkOrder` passes). Save as
`cutover-record-applied.sql` and run it:
```sql
INSERT INTO pgmigrations (name, run_on) VALUES
 ('1783100000000_catalog-tables', now())
,('1783200000000_questionnaire-tables', now())
,('1783300000000_survey-visits', now())
,('1783400000000_visit-questions-collection-and-checks', now())
,('1783500000000_cleanup-stale-search-settings-action-ids', now())
,('1783600000000_customer-info-generic', now())
,('1783600000000_google-oauth-tokens', now())
,('1783700000000_encrypt-google-tokens', now())
,('1783800000000_encrypt-qb-tokens', now())
,('1783900000000_add-corrected-mobile-to-admin-notification-email', now())
,('1783900000000_customer-info-contact-phone', now())
,('1784000000000_add-contact-phone-to-admin-notification-email', now())
,('1784100000000_restore-legacy-catalog-stub-tables', now())
,('1784200000000_suppliers', now())
,('1784200000001_supplier-fk', now())
,('1785500000000_design-visits-visit-notes', now())
,('1785600000000_survey-visits-visit-notes', now())
,('1785700000000_priority-sort-mode', now())
,('1785800000000_drop-corrected-email-mobile', now())
,('1785900000000_drop-corrected-mobile-from-admin-notification-email', now());
```
```powershell
& "$PG18\psql.exe" -d $DEST_DATABASE_URL -v ON_ERROR_STOP=1 -f "cutover-record-applied.sql"
```

> The `encrypt-google-tokens` / `encrypt-qb-tokens` migrations are **record-only**
> here — they must NEVER be re-run, as they would double-encrypt live OAuth tokens.

---

## Step 5 — Confirm zero pending (workstation)

```powershell
$env:DATABASE_URL = $DEST_DATABASE_URL
npm run db:migrate     # expect: "No migrations to run!"
```
If it lists anything other than genuinely-new files you intentionally left for it,
**stop** and re-check Step 4.

---

## Step 6 — Object delta copy  **[Replit shell]**

Most objects copied during the parallel run; this catches anything written
before the freeze. Idempotent — only missing/changed objects copy. ADC is already
configured in Replit (re-run `gcloud auth application-default login --no-launch-browser`
if it was revoked).
```bash
DEST_GCS_BUCKET=wardrobes-bucket npm run migrate:objects
# clean run ends: total=N copied=N skipped=… failed=0
```

---

## Step 7 — Parity gate (HARD GATE)  **[Replit shell]**

`verify:migration` needs the source bucket (Replit) AND the dest DB. Run the
Cloud SQL Auth Proxy *inside Replit* so Cloud SQL is reachable there:
```bash
# One-time in Replit: get the linux proxy.
curl -o cloud-sql-proxy https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.linux.amd64
chmod +x cloud-sql-proxy
./cloud-sql-proxy harry-wardrobes:europe-west2:harry-wardrobes-instance &   # uses ADC

# Build the dest URL from the secret (swap socket host → proxy), keep STORAGE_BACKEND unset (source must read Replit).
DEST_DB=$(gcloud secrets versions access latest --secret=DATABASE_URL | sed -E 's#@/measureonce\?host=/cloudsql/[^"]+#@127.0.0.1:5432/measureonce#')

SOURCE_DATABASE_URL="<current Neon URL>" \
DEST_DATABASE_URL="$DEST_DB" \
DEST_GCS_BUCKET=wardrobes-bucket \
npm run verify:migration
```
**All sections must report PASS** (DB row counts, object parity, migration
records). If anything mismatches, **stop and resolve before flipping DNS** — this
is the point of no easy return.

---

## Step 8 — Deploy production to Cloud Run (workstation)

If app code changed since the rehearsal image, rebuild first
(`gcloud builds submit --tag europe-west2-docker.pkg.dev/harry-wardrobes/measure-once/measure-once:<ts> .`);
otherwise reuse the rehearsal image. Then deploy pointed at the now-production
data, adding the **production URL env** (OAuth redirects + APP_URL) and making it
public:
```powershell
$IMAGE = Get-Content "$env:TEMP\mo_image_tag.txt" -Raw   # or the fresh tag
$secretNames = gcloud secrets list --format="value(name)"
$setSecrets = (($secretNames | ForEach-Object { "$($_)=$($_):latest" }) -join ",")

gcloud run deploy measure-once `
  --image=$IMAGE.Trim() `
  --region=europe-west2 `
  --service-account="wardrobes-run@harry-wardrobes.iam.gserviceaccount.com" `
  --add-cloudsql-instances="harry-wardrobes:europe-west2:harry-wardrobes-instance" `
  --allow-unauthenticated `
  --port=8080 --cpu=1 --memory=512Mi --min-instances=0 --max-instances=4 `
  --set-env-vars="NODE_ENV=production,STORAGE_BACKEND=gcs,GCS_BUCKET=wardrobes-bucket,ADMIN_EMAILS=harry@harrywardrobes.co.uk,APP_URL=https://handle.harrywardrobes.co.uk,GOOGLE_REDIRECT_URI=https://handle.harrywardrobes.co.uk/auth/google/callback,QB_REDIRECT_URI=https://handle.harrywardrobes.co.uk/auth/quickbooks/callback" `
  --set-secrets=$setSecrets
```
Keep `RUN_MIGRATIONS_ON_BOOT` unset (boot logged "Skipping boot-time migrations"
in the rehearsal — that is correct).

---

## Step 9 — Swap sandbox → production integration secrets (workstation)

Add new versions for each integration secret that must go live, then roll the
service so `:latest` is picked up:
```powershell
# Example per secret (repeat for QB_ENVIRONMENT→production, QB_*, HUBSPOT_ACCESS_TOKEN, SMTP_*, Google prod values):
"production" | gcloud secrets versions add QB_ENVIRONMENT --data-file=-
# …add the others from your prepared prod values…

gcloud run services update measure-once --region=europe-west2 `
  --set-secrets=$setSecrets   # re-point to :latest, picking up the new versions
```
Confirm the prod OAuth redirect URIs from the T‑24h step are registered before
relying on Google/QuickBooks login.

---

## Step 10 — Domain mapping + DNS flip (workstation + DNS provider)

```powershell
gcloud beta run domain-mappings create --service=measure-once --domain=handle.harrywardrobes.co.uk --region=europe-west2
```
The command prints DNS records. Add/point them at your DNS provider. With the
60s TTL from T‑24h, propagation is fast.

---

## Step 11 — Smoke-test the live domain (the freeze ends when this passes)

Once DNS resolves to Cloud Run, hit `https://handle.harrywardrobes.co.uk`:
- Log in (cookies work now — real https), load dashboards, open a design visit.
- **Open a customer-info submission photo** (served from `wardrobes-bucket` via GCS).
- Send one real test email to an internal address; confirm one HubSpot read and one
  QuickBooks read succeed.
- Confirm Cloud Run logs show **no boot-time migrations** and no errors:
  ```powershell
  gcloud run services logs read measure-once --region=europe-west2 --limit=100
  ```

---

## Phase D — Post-cutover soak

1. **Re-run `verify:migration`** against the now-live data to confirm parity held.
2. **Watch logs** for errors/restart loops for the first hours.
3. **Exercise one low-impact write** of each integration (email, HubSpot, QuickBooks).
4. **Keep Replit stopped-but-intact** as a warm rollback for **~7 days**. Do not
   delete the Neon DB, the Replit bucket, or the `cutover.dump` until the soak is clean.

---

## Rollback (only clean before meaningful writes hit Cloud Run)

1. **Flip DNS back to Replit** (fast — TTL already low).
2. **Restart the Replit deployment** (stopped-but-intact since Step 1).
3. Optionally take Cloud Run private again (`--no-allow-unauthenticated`).

> ⚠️ Any writes made on Cloud Run **after** the flip (logins, submissions, visit
> edits, uploaded photos, QB/HubSpot changes) live only in Cloud SQL + GCS, not in
> the frozen Replit source. Rolling back **discards them.** Reconcile forward or
> accept the loss deliberately.

---

## Safety

- `cutover.dump` and the media objects are **live customer PII** — encrypted at
  rest, deleted only after a verified, soaked cutover.
- Never commit dumps, secret values, or a `DATABASE_URL` with credentials.
- **`pgmigrations` is the trap** — reconcile (Step 4), never blind `db:migrate`.
  Never drop `public.migrations`; never re-run the token-encryption migrations.
- `verify:migration` is the hard gate — do not flip DNS until all sections PASS.
- Least privilege / ADC only — no service-account keys (org-blocked anyway,
  see [[gcp-org-no-sa-keys]]).
