# Harry Wardrobes — Project Dashboard

A bespoke CRM and project management app for Harry Wardrobes. Integrates with HubSpot (contacts and deals), QuickBooks (invoices), Google (email, calendar, auth), and WhatsApp into a single workflow.

## Features

- **Customers** — browse, search, filter, and create contacts; track lead status and urgency
- **Projects** — manage deal stages across the full installation pipeline (sales → design → survey → order → workshop → installation → aftercare)
- **Design visits & surveys** — schedule visits, capture questionnaire submissions, customer sign-off
- **Trades** — create and approve trade cost items; audit history and conflict resolution
- **Invoicing** — view and filter QuickBooks invoices per customer or across all projects
- **Tasks & calendar** — create tasks with deadlines and assignees; create Google Calendar events
- **WhatsApp** — send and receive messages per customer from within the app
- **Ideas** — team feature requests with voting and comments
- **Admin** — team management, role-based permissions, custom nav, card actions, workflow automation, email templates, audit log, HubSpot / QuickBooks / Google Maps config

---

## Setup

> **Local development?** See [docs/local-dev.md](docs/local-dev.md) for the full local dev loop (dev DB, GCS storage, OAuth redirect registration, local-login cookie behaviour).

### 1. Install dependencies

```bash
PUPPETEER_SKIP_DOWNLOAD=true npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in your keys (HubSpot token, Google OAuth credentials, database URL, etc.).

### 3. HubSpot Private App

1. **HubSpot → Settings → Integrations → Private Apps** — create a new app
2. Add scopes: `crm.objects.deals.read/write`, `crm.objects.contacts.read`, `crm.objects.notes.read/write`, `crm.pipelines.orders.read`
3. Copy the token into `.env` as `HUBSPOT_ACCESS_TOKEN`

### 4. Google OAuth (email + calendar)

1. [console.cloud.google.com](https://console.cloud.google.com) — enable **Gmail API** and **Google Calendar API**
2. Create an OAuth 2.0 Client ID (Web application)
3. Add authorised redirect URI: `http://localhost:5000/auth/google/callback`
4. Copy Client ID and Client Secret into `.env`

---

## Running locally

Two terminals for the fastest dev loop with Hot Module Replacement:

```bash
# Terminal 1 — Express API server
npm run dev

# Terminal 2 — Vite dev server with HMR (open on port 5173)
npm run dev:react
```

Or use a single terminal with auto-rebuild on save (open on port 5000):

```bash
npm run dev          # Terminal 1
npm run watch:react  # Terminal 2 — rebuilds on save, reload manually
```

---

## Building

```bash
npm run build:react      # full build — typecheck + Vite + bundle-size check
npm run typecheck        # TypeScript check only
```

---

## Database migrations

Schema is owned entirely by versioned migration files in `migrations/` — no `CREATE TABLE` calls in app code. Migrations run automatically on boot in development.

```bash
npm run db:migrate                        # apply all pending migrations
npm run db:migrate:down                   # roll back the most recent migration
npm run db:migrate:redo                   # roll back then re-apply the most recent
npm run db:migrate:create -- my_change    # scaffold a new migration file
```

Never edit an applied migration — add a new one to change the schema.

---

## Pulling production data

`npm run db:pull` copies configuration and reference data from production into your local dev database and/or staging. It is safe to run repeatedly — rows are upserted, not replaced.

**What is pulled** (always):
- Team: `users`, `allowed_emails`, `job_roles`, role & nav config
- Workflow: lead statuses, sub-statuses, stage action labels, card action handlers
- Settings: admin, app, search, page filter, workshop, QuickBooks config
- Catalogue: design visit options, product ranges, doors, handles, finishes, pairings
- Templates: email templates, terms & conditions, visit questions

**Optional groups** (you choose each run): Trades, Ideas, Customer data, Finance

**Never pulled**: `sessions`, `password_set_tokens`, `qb_tokens`, `google_oauth_tokens`, image/upload tables, audit logs.

### Prerequisites

1. Add to `.env` (see `.env.example` for the format):
   ```
   PROD_DATABASE_URL=postgres://app:PASSWORD@127.0.0.1:15432/measureonce
   STAGING_DATABASE_URL=postgres://app:PASSWORD@127.0.0.1:15432/measureonce_staging
   ```

2. Start the Cloud SQL Auth Proxy:
   ```powershell
   & "C:\Users\User\cloud-sql-proxy.exe" --port 15432 harry-wardrobes:europe-west2:harry-wardrobes-db
   ```

### Running the pull

```bash
npm run db:pull                   # interactive — prompts for target + optional tables
npm run db:pull -- --local        # local dev only, no prompts
npm run db:pull -- --staging      # staging only, no prompts
npm run db:pull -- --local --staging  # both at once
npm run db:pull -- --dry-run      # preview row counts without writing anything
```

When pulling to **staging**, `dev_mode_enabled` is automatically set to `true` after the pull (so staging only shows test contacts). QuickBooks and Google tokens are never pulled — reconnect them in the staging admin panel if needed.

---

## Deployment

The app runs on **Google Cloud Run**. See [docs/deploy.md](docs/deploy.md) for the full deploy runbook and [docs/environments.md](docs/environments.md) for environment concepts.

Before deploying, apply any pending migrations against the production database:

```bash
npm run db:migrate   # run against production DATABASE_URL
```

Or set `RUN_MIGRATIONS_ON_BOOT=true` in the Cloud Run environment to apply migrations automatically at boot (fail-closed — a migration error exits the process).
