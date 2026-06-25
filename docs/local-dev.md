# Local development against cloud services

Run and edit Measure Once on your own machine while continuing to use the
existing **cloud** integrations (HubSpot, QuickBooks, Google, SMTP, object
storage). This is a dev loop, not a migration — nothing here moves data off the
cloud.

> ⚠ **Use a dev database.** In development the server **auto-runs migrations on
> boot** (`server.js`, gated on `NODE_ENV !== 'production'`). Never point
> `DATABASE_URL` at production — migrations would run against live customer data.

---

## Prerequisites

- **Node 20.x** (`package.json` pins `>=20 <21`).
- **PostgreSQL** running locally (or any throwaway dev Postgres you control).
- **gcloud CLI** (only if you use GCS for photo storage — see step 4).

---

## 1. Install dependencies

Skip the Puppeteer Chromium download (it's only needed for PDF/browser test
flows, not for running the app):

```bash
PUPPETEER_SKIP_DOWNLOAD=true npm install
```

On Windows PowerShell:

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD = "true"; npm install
```

## 2. Create your `.env`

```bash
cp .env.example .env
```

Fill in at minimum the **Required to boot + log in** block:

- `SESSION_SECRET` — `openssl rand -hex 32`
- `DATABASE_URL` — your **dev** Postgres (see step 3)
- `ADMIN_EMAILS` — keep your own email so you get admin access

`NODE_ENV=development`, `PORT=5000`, and `APP_URL=http://localhost:5000` are
already set in the example. Add per-integration credentials only for the
services you actually exercise (each block in `.env.example` explains what it
unlocks). Leaving a block blank disables that integration; the server still
boots.

## 3. Create a dev Postgres database

```bash
createdb measureonce_dev
# then in .env:
# DATABASE_URL=postgres://postgres:postgres@localhost:5432/measureonce_dev
```

Migrations under `migrations/` run automatically on first boot in development —
you don't need to run `npm run db:migrate` by hand (though you can).

## 4. Object storage (photos)

storage.js talks to **GCS**. For local dev:

```bash
gcloud auth application-default login
```

Then in `.env`:

```
STORAGE_BACKEND=gcs
GCS_BUCKET=<your-bucket-name>
```

The bucket must be one your Google account can read/write. Photo upload/download
won't work until both are set, but the rest of the app runs fine without it.

## 5. Register local OAuth redirect URIs

Add these **redirect URIs** to the respective OAuth clients (in addition to the
production ones — don't replace them):

- **Google** (Cloud Console → Credentials → your OAuth client):
  `http://localhost:5000/auth/google/callback`
- **QuickBooks** (Intuit developer portal → your app → Redirect URIs):
  `http://localhost:5000/auth/quickbooks/callback`

These match `GOOGLE_REDIRECT_URI` / `QB_REDIRECT_URI` in `.env.example`. Without
the registration, the provider rejects the callback with a redirect-mismatch
error.

## 6. Run

```bash
npm run dev          # Express server on http://localhost:5000 (nodemon)
```

Optionally, in a second terminal, run the Vite dev server for React HMR:

```bash
npm run dev:react    # Vite on http://localhost:5173
```

Open <http://localhost:5000>. First time on a fresh DB you have no password yet
— see the next section.

## 7. First login (set a password on a fresh dev DB)

Login is **email + password** (Google OAuth is only for *connecting*
Gmail/Calendar after you're logged in, not for signing in). On a fresh dev DB:

1. On boot, the server seeds an admin `users` row for each address in
   `ADMIN_EMAILS` — but with **no password**.
2. With `NODE_ENV=development` and no `TURNSTILE_SECRET_KEY`, the captcha check
   is skipped, and with **no SMTP configured** the set-password link is printed
   to the **server console** instead of emailed.
3. Trigger a link: on the login page click **Forgot password** and enter your
   admin email, or from another terminal:
   ```bash
   curl -X POST http://localhost:5000/api/forgot-password \
     -H 'Content-Type: application/json' \
     -d '{"email":"harry@harrywardrobes.co.uk"}'
   ```
4. Watch the `npm run dev` console for a line like:
   ```
   Set-password link (manual delivery): http://localhost:5000/set-password?token=…
   ```
   Open that URL, set a password (min 8 chars, letters + numbers).
5. Log in with your email + the password you just set. The dev cookie settings
   (below) keep you logged in over plain HTTP.

---

## Why local login works now (the cookie fix)

Production runs behind HTTPS with cross-site OAuth, so the session cookie is
`Secure` + `SameSite=None`. Browsers refuse to store a `Secure` cookie over
`http://localhost`, which silently broke local login (you'd log in and bounce
straight back to `/login`).

`auth.js` now gates the cookie on `NODE_ENV`:

| `NODE_ENV`     | `secure` | `sameSite` |
| -------------- | -------- | ---------- |
| `production`   | `true`   | `none`     |
| anything else  | `false`  | `lax`      |

Production behaviour is unchanged. For this to work locally you must have
`NODE_ENV=development` (set in `.env.example`).

---

## Troubleshooting

- **Login bounces back to `/login`** — confirm `NODE_ENV=development` is actually
  loaded (`echo $NODE_ENV` won't reflect `.env`; check the boot logs). The
  Secure-cookie gate depends on it.
- **No account / can't log in on a fresh DB** — see "First login" above. Make
  sure your email is in `ADMIN_EMAILS`, then use Forgot password and grab the
  link from the server console.
- **Forgot-password says captcha failed / Turnstile widget won't load** — the
  real `TURNSTILE_SITE_KEY` is bound to the prod hostname in Cloudflare and can't
  render on `localhost`. Leave both `TURNSTILE_SITE_KEY` and
  `TURNSTILE_SECRET_KEY` **blank** in dev — the app then disables Turnstile
  entirely (`verifyCaptchaToken` short-circuits when `NODE_ENV!=='production'`).
  `npm run pull-secrets` intentionally does not pull these. To exercise the
  widget locally, use Cloudflare's test keys instead: site `1x00000000000000000000AA`,
  secret `1x0000000000000000000000000000000AA` (always pass, any hostname).
- **`relation "unique_session_key" already exists` on boot** — a previous crashed
  boot left a half-built `rate_limit` schema (the `@acpr/rate-limit-postgresql`
  init isn't idempotent). Clear it and reboot:
  `psql -U postgres -d measureonce_dev -c "DROP SCHEMA IF EXISTS rate_limit CASCADE; DROP TABLE IF EXISTS public.migrations;"`
- **`SESSION_SECRET is required`** on boot — set `SESSION_SECRET` in `.env`.
- **DB / migration errors on boot** — wrong or unreachable `DATABASE_URL`, or
  you pointed it at a database you don't want migrated. Use a dev DB.
- **Photo upload 503 / "Object storage is not configured"** — you haven't run
  `gcloud auth application-default login` / set `GCS_BUCKET`.
- **Google/QuickBooks "disconnected"** — set `GOOGLE_TOKEN_ENCRYPTION_KEY` /
  `QB_TOKEN_ENCRYPTION_KEY` (tokens can't be encrypted/decrypted without them).
