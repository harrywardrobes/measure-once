# Harry Wardrobes — Project Dashboard

A project management web app that uses HubSpot as the backend and connects Gmail and Google Calendar into a single view.

## Features

- **Kanban board** — all HubSpot deals shown across your pipeline stages
- **Stage checklists** — per-stage task lists built from your workflow (editable)
- **Move deals** — change a deal's stage without leaving the app
- **Email threads** — see Gmail conversations for each customer
- **Calendar** — view and create Google Calendar events per project
- **Send emails** — compose and send from within the app
- **Checklist persistence** — task completion saved back to HubSpot notes

---

## Setup

### 1. Install dependencies
```bash
cd harry-wardrobes-crm
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Then fill in your keys (see below).

### 3. HubSpot Private App token
1. Go to **HubSpot → Settings → Integrations → Private Apps**
2. Create a new Private App
3. Add these scopes:
   - `crm.objects.deals.read` / `write`
   - `crm.objects.contacts.read`
   - `crm.objects.notes.read` / `write`
   - `crm.pipelines.orders.read`
4. Copy the token into `.env` as `HUBSPOT_TOKEN`

### 4. Google OAuth (Gmail + Calendar)
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project → Enable **Gmail API** and **Google Calendar API**
3. Go to **APIs & Services → Credentials → Create OAuth 2.0 Client ID**
4. Application type: **Web application**
5. Add authorised redirect URI: `http://localhost:3456/auth/google/callback`
6. Copy Client ID and Client Secret into `.env`

### 5. HubSpot Pipeline stages
Name your HubSpot deal pipeline stages to match your workflow:
- Sales
- Design Visit
- Survey
- Order
- Workshop
- Packing
- Delivery
- Installation
- Aftercare

The app will match stages by name automatically.

---

## Running locally
```bash
npm run dev    # with auto-reload
# or
npm start      # production
```

Open [http://localhost:3456](http://localhost:3456)

---

## Database migrations

The schema is built and upgraded entirely by ordered, versioned migration files
in `migrations/` using [`node-pg-migrate`](https://salsita.github.io/node-pg-migrate/).
There are no `ensureXTable()`/`CREATE TABLE` calls scattered through the app any
more — `runMigrations()` (in `db-migrate.js`) runs every pending migration on
boot, before auth/session setup, so the database is always current.

Migrations use raw SQL (`pgm.sql`) so the project's plain `pg` query style is
preserved end to end.

```bash
# Apply all pending migrations (also runs automatically on boot)
npm run db:migrate

# Roll back the most recent migration
npm run db:migrate:down

# Roll back then re-apply the most recent migration (handy while iterating)
npm run db:migrate:redo

# Scaffold a new migration file in migrations/
npm run db:migrate:create -- my_change_name
```

Guidelines:
- Migrations are immutable once merged — never edit an applied migration; add a
  new one to change the schema.
- Keep them ordered (the numeric timestamp prefix defines run order) and
  idempotent-safe where practical (`IF NOT EXISTS`, etc.).
- New sync-relevant tables should carry `updated_at` + `version` columns and the
  auto-update trigger (see `migrations/*_sync-readiness.js` for the pattern).
- Tests that spin up isolated databases apply the full migration set via
  `scripts/with-test-db.js`; no schema is created at boot by application code.

---

## Deploying to a server

The app is a standard Node.js/Express app. Deploy to any host that supports Node.js (Railway, Render, DigitalOcean, etc.).

When deploying:
1. Set all env vars on your hosting platform
2. Update `GOOGLE_REDIRECT_URI` to your production domain, e.g.:
   `https://crm.harrywwardrobes.co.uk/auth/google/callback`
3. Add that URI to your Google OAuth client's authorised redirect URIs
4. Set `PORT` if your host requires a specific port

---

## Editing your workflow checklists

Click any deal → **Checklist** tab → **Edit tasks** to customise the task list for any stage. Changes are saved to `workflow.json` and apply to all future deals in that stage.
