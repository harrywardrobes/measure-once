# Changeset: local development against cloud services

Apply these changes to the canonical git repo to reproduce the local-dev setup
done on 2026-06-24/25. All paths are relative to the app root (`measure-once/`).

**Only one change affects production:** the `auth.js` session-cookie fix, and it
is gated on `NODE_ENV` so production behaviour is identical. Everything else is
additive (new files / dev tooling / docs).

| File | Type | Prod impact |
|---|---|---|
| `auth.js` | edit | none (gated on `NODE_ENV`) |
| `package-lock.json` | regenerate | none (fixes installs outside Replit) |
| `README.md` | edit | none (docs) |
| `package.json` | edit | none (adds a dev script) |
| `.env.example` | new | none |
| `docs/local-dev.md` | new | none |
| `scripts/pull-dev-secrets.mjs` | new | none |

---

## 1. `auth.js` — session cookie works on local HTTP (EDIT)

In `getSession()` (~line 698). Replace:

```js
  return session({
    secret: process.env.SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: { httpOnly: true, secure: true, sameSite: 'none', maxAge: ttl },
  });
```

with:

```js
  const isProd = process.env.NODE_ENV === 'production';
  return session({
    secret: process.env.SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      // Production runs behind HTTPS with cross-site OAuth, so the cookie must
      // be Secure + SameSite=None. Over plain http://localhost a Secure cookie
      // is silently dropped by the browser, breaking local login — so dev uses
      // secure:false + SameSite=Lax. Gated on NODE_ENV (server-side signal).
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge: ttl,
    },
  });
```

Behaviour: with `NODE_ENV=production` (Replit), cookie stays `secure:true` /
`sameSite:'none'` — unchanged. Any other env gets `secure:false` /
`sameSite:'lax'` so `http://localhost` login works. Do **not** change
`app.set('trust proxy', 1)` or the session store.

---

## 2. `package-lock.json` — regenerate against the public npm registry (REGENERATE)

The committed lockfile resolves every package from `http://package-firewall.replit.local/...`,
which only exists inside Replit, so `npm install` hangs/404s on any other machine.
Regenerate it from the public registry:

```bash
rm -f package-lock.json
rm -rf node_modules
PUPPETEER_SKIP_DOWNLOAD=true npm install --registry=https://registry.npmjs.org/
```

Commit the regenerated `package-lock.json`. It still works on Replit (Replit can
resolve public npm), and unblocks local installs.

---

## 3. `README.md` — fix stale references (EDIT)

Four small edits:

- Setup intro / install dir — replace:
  ```
  ### 1. Install dependencies
  ```bash
  cd harry-wardrobes-crm
  npm install
  ```
  ```
  with a pointer to the dev doc, the correct folder, and the Puppeteer skip:
  ```
  > **Developing locally against the cloud services?** See
  > [docs/local-dev.md](docs/local-dev.md) for the full local dev loop.

  ### 1. Install dependencies
  ```bash
  cd measure-once
  # Skip the Puppeteer Chromium download (only needed for PDF/browser test flows):
  PUPPETEER_SKIP_DOWNLOAD=true npm install
  ```
  ```
- HubSpot token name — `Copy the token into .env as HUBSPOT_TOKEN` →
  `... as HUBSPOT_ACCESS_TOKEN`.
- Google redirect URI — `http://localhost:3456/auth/google/callback` →
  `http://localhost:5000/auth/google/callback`.
- Run URL — `Open http://localhost:3456` → `Open http://localhost:5000`.

---

## 4. `package.json` — add the `pull-secrets` script (EDIT)

In `"scripts"`, add this line (e.g. just above `"db:migrate"`):

```json
    "pull-secrets": "node scripts/pull-dev-secrets.mjs",
```

---

## 5. `.env.example` — NEW FILE

Confirm `.env` is gitignored (it is). Create `.env.example` with:

```
# =============================================================================
# Measure Once — example environment file
# =============================================================================
# Copy this to `.env` (which is gitignored) and fill in real values:
#     cp .env.example .env
#
# This file is committed and MUST NOT contain real secrets.
#
# The app loads `.env` via `dotenv` at the top of server.js. Anything left
# blank/commented here just disables the matching feature (the server still
# boots) — except the "Required to boot + log in" block below.
#
# ⚠ SAFETY
#   - DATABASE_URL must point at a DEV database. In development the server
#     auto-runs migrations on boot (server.js: NODE_ENV !== 'production'), so a
#     prod URL here would read/write live customer data. Use a local Postgres.
#   - Real HUBSPOT / QUICKBOOKS / SMTP credentials mutate the live pipeline and
#     send real invoices & emails. Only fill an integration in when you actually
#     intend to exercise it against the live service.
# =============================================================================


# -----------------------------------------------------------------------------
# Required to boot + log in
# -----------------------------------------------------------------------------
NODE_ENV=development
PORT=5000

# Public base URL the server advertises (used for OAuth redirects, links, etc.).
# auth.js appBaseUrl() prefers APP_URL. Keep in sync with PORT.
APP_URL=http://localhost:5000

# Session signing secret. REQUIRED — the server throws on boot without it.
# Generate one:  openssl rand -hex 32
SESSION_SECRET=

# DEV Postgres connection string — NOT production. (See SAFETY note above.)
# Example: postgres://postgres:postgres@localhost:5432/measureonce_dev
DATABASE_URL=

# Comma-separated list of admin emails. Your own login must be in here to get
# admin access.
ADMIN_EMAILS=harry@harrywardrobes.co.uk


# -----------------------------------------------------------------------------
# Object storage (photos)
# -----------------------------------------------------------------------------
# Backends (storage.js getBackend()):
#   replit (default) — @replit/object-storage; ONLY works inside Replit.
#   gcs              — Google Cloud Storage via Application Default Credentials.
# For local dev use gcs:
#   1. gcloud auth application-default login
#   2. set GCS_BUCKET to a bucket you can read/write.
STORAGE_BACKEND=gcs
GCS_BUCKET=


# -----------------------------------------------------------------------------
# Token encryption keys
# -----------------------------------------------------------------------------
# Only needed once you connect Google and/or QuickBooks (those integrations
# appear "disconnected" until set — boot/login does not require them).
# Generate each:  openssl rand -hex 32
GOOGLE_TOKEN_ENCRYPTION_KEY=
QB_TOKEN_ENCRYPTION_KEY=


# =============================================================================
# Per-integration (optional) — fill in ONLY the ones you exercise.
# Leaving a block blank disables that integration; the server still boots.
# =============================================================================

# --- HubSpot (CRM "backend") -------------------------------------------------
# Primary token feature code reads. (server.js also accepts the legacy
# HUBSPOT_TOKEN as a fallback alias.) Real token mutates the live CRM pipeline.
HUBSPOT_ACCESS_TOKEN=
# Optional: override the API base (defaults to https://api.hubapi.com).
# HUBSPOT_API_URL=

# --- Google OAuth (Gmail/Calendar) + Places ----------------------------------
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
# Must be registered on the OAuth client. For local dev:
GOOGLE_REDIRECT_URI=http://localhost:5000/auth/google/callback
# Google Places (address autocomplete).
GOOGLE_PLACES_API_KEY=
# Calendar used for scheduling. Scheduling actions error until this is set.
GOOGLE_SHARED_CALENDAR_ID=

# --- QuickBooks (invoices) ---------------------------------------------------
QB_CLIENT_ID=
QB_CLIENT_SECRET=
# 'sandbox' targets the QB sandbox API; anything else = production.
QB_ENVIRONMENT=sandbox
# Must be registered on the QB app. For local dev:
QB_REDIRECT_URI=http://localhost:5000/auth/quickbooks/callback

# --- SMTP email --------------------------------------------------------------
# With all of HOST/USER/PASS set, the app sends REAL emails. Leave blank in dev
# unless you intend to send.
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
# From / Reply-To headers (default to SMTP_USER if unset).
SMTP_FROM=
SMTP_REPLY_TO=

# --- Cloudflare Turnstile (login bot check) ----------------------------------
# If unset, the Turnstile check is skipped (fine for local dev).
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=

# --- WhatsApp (notifications) ------------------------------------------------
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=


# =============================================================================
# Advanced / rarely-needed (safe to ignore for a normal local dev loop)
# =============================================================================
# Force migrations to run on boot even in production (dev runs them anyway):
# RUN_MIGRATIONS_ON_BOOT=true
# Public base URL used when registering webhooks (e.g. an ngrok https URL):
# WEBHOOK_BASE_URL=
# Logging:
# LOG_LEVEL=info
# Override a Chromium binary for Puppeteer-based flows (e.g. PDF generation):
# PUPPETEER_EXECUTABLE_PATH=
# CHROMIUM_PATH=
```

---

## 6. `scripts/pull-dev-secrets.mjs` — NEW FILE

Builds/refreshes the local `.env` by pulling secrets from Google Secret Manager
(`gcloud`) and merging with dev-only config. Run via `npm run pull-secrets`.

```js
// scripts/pull-dev-secrets.mjs
//
// Build / refresh the local development `.env` by pulling secret values from
// Google Secret Manager (GSM) and combining them with dev-only config.
//
//   node scripts/pull-dev-secrets.mjs        (or: npm run pull-secrets)
//
// What it does:
//   - Fetches each key in SECRET_KEYS from GSM via the gcloud CLI and writes it
//     to `.env` (overwriting that key each run — GSM is the source of truth).
//   - For DEV_DEFAULTS (NODE_ENV, ports, URLs, DB, bucket): keeps whatever is
//     already in your `.env`, and only fills in the default when the key is
//     missing. So your local GCS_BUCKET / DATABASE_URL edits survive re-runs.
//   - Preserves any other keys already in `.env` that this script doesn't manage.
//
// Why a separate dev config block (not pulled from GSM): NODE_ENV, APP_URL,
// DATABASE_URL, STORAGE_BACKEND and the OAuth redirect URIs are environment
// specific. Production values must never land in the dev `.env` — in particular
// a prod DATABASE_URL here would let dev's auto-migrations hit live data.
//
// Requirements: gcloud installed + authenticated (`gcloud auth login`) with the
// right project set (`gcloud config set project ...`). This script never prints
// secret values. `.env` is gitignored.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');

// Secrets pulled from GSM every run (overwrite local value).
const SECRET_KEYS = [
  'SESSION_SECRET',
  'GOOGLE_TOKEN_ENCRYPTION_KEY',
  'QB_TOKEN_ENCRYPTION_KEY',
  'HUBSPOT_ACCESS_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_PLACES_API_KEY',
  'GOOGLE_SHARED_CALENDAR_ID',
  'QB_CLIENT_ID',
  'QB_CLIENT_SECRET',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'SMTP_REPLY_TO',
  // NOTE: TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY are intentionally NOT pulled.
  // The real site key is bound to the prod hostname in Cloudflare and won't
  // render on localhost. Left blank, the app disables Turnstile in dev
  // (verifyCaptchaToken short-circuits when NODE_ENV!=='production'). See
  // DEV_DEFAULTS below. To exercise the widget locally, use Cloudflare's test
  // keys (1x000...AA) instead.
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_BUSINESS_ACCOUNT_ID',
];

// Dev-only config. Kept from existing .env if present; default used otherwise.
const DEV_DEFAULTS = {
  NODE_ENV: 'development',
  PORT: '5000',
  APP_URL: 'http://localhost:5000',
  ADMIN_EMAILS: 'harry@harrywardrobes.co.uk',
  STORAGE_BACKEND: 'gcs',
  GCS_BUCKET: 'your-dev-bucket', // <-- edit in .env after first run
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/measureonce_dev',
  QB_ENVIRONMENT: 'sandbox',
  GOOGLE_REDIRECT_URI: 'http://localhost:5000/auth/google/callback',
  QB_REDIRECT_URI: 'http://localhost:5000/auth/quickbooks/callback',
  // Blank in dev = Turnstile disabled (the real prod site key can't render on
  // localhost). Set Cloudflare test keys here if you want the widget locally.
  TURNSTILE_SITE_KEY: '',
  TURNSTILE_SECRET_KEY: '',
};

function parseEnv(text) {
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    map.set(line.slice(0, idx).trim(), line.slice(idx + 1));
  }
  return map;
}

function fetchSecret(key) {
  const r = spawnSync(
    'gcloud',
    ['secrets', 'versions', 'access', 'latest', `--secret=${key}`],
    { encoding: 'utf8', shell: true }
  );
  if (r.error) {
    console.error(`\nFailed to run gcloud — is it installed and on PATH?\n${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) return null; // not found / no access
  return r.stdout.replace(/\r?\n$/, ''); // strip a single trailing newline
}

const existing = existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, 'utf8')) : new Map();
const result = new Map();

// 1. Dev config: keep existing, else default.
for (const [k, def] of Object.entries(DEV_DEFAULTS)) {
  result.set(k, existing.has(k) ? existing.get(k) : def);
}

// 2. Secrets from GSM (overwrite). Keep existing value if a secret is missing.
const pulled = [];
const missing = [];
for (const k of SECRET_KEYS) {
  const v = fetchSecret(k);
  if (v !== null) {
    result.set(k, v);
    pulled.push(k);
  } else if (existing.has(k)) {
    result.set(k, existing.get(k));
    missing.push(`${k} (kept existing)`);
  } else {
    missing.push(k);
  }
}

// 3. Preserve any other keys already in .env that we don't manage.
const managed = new Set([...Object.keys(DEV_DEFAULTS), ...SECRET_KEYS]);
const extras = [...existing.keys()].filter((k) => !managed.has(k));

// Write .env (UTF-8, no BOM).
const lines = [
  '# Generated by scripts/pull-dev-secrets.mjs — secrets pulled from Google Secret Manager.',
  '# Re-run `npm run pull-secrets` to refresh. Do not commit (this file is gitignored).',
  '',
  '# --- Dev config (local, not from prod) ---',
  ...Object.keys(DEV_DEFAULTS).map((k) => `${k}=${result.get(k)}`),
  '',
  '# --- Secrets (from GSM) ---',
  ...SECRET_KEYS.filter((k) => result.has(k)).map((k) => `${k}=${result.get(k)}`),
];
if (extras.length) {
  lines.push('', '# --- Other (preserved from existing .env) ---');
  for (const k of extras) lines.push(`${k}=${result.get(k) ?? existing.get(k)}`);
  for (const k of extras) result.set(k, existing.get(k));
}
writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf8');

console.log(`Wrote ${ENV_PATH}`);
console.log(`  Secrets pulled from GSM: ${pulled.length}`);
if (missing.length) console.log(`  Not in GSM: ${missing.join(', ')}`);
if (result.get('GCS_BUCKET') === 'your-dev-bucket') {
  console.log('  ⚠ Edit GCS_BUCKET in .env — still the placeholder.');
}
```

---

## 7. `docs/local-dev.md` — NEW FILE

The full local-dev runbook (install, dev DB, GCS, OAuth redirects, first login,
the cookie explainer, and troubleshooting incl. the `unique_session_key` boot
crash and Turnstile-on-localhost). This file already exists in the working tree —
copy `measure-once/docs/local-dev.md` across as-is. (Not inlined here because it
contains nested code fences.)

---

## Applying & committing

```bash
git checkout -b local-dev-setup
# apply edits 1, 3, 4; add new files 5, 6, 7; regenerate lockfile (2)
git add auth.js README.md package.json package-lock.json \
        .env.example docs/local-dev.md docs/changeset-local-dev.md \
        scripts/pull-dev-secrets.mjs
git commit -m "Enable local development against cloud services

- auth.js: gate session cookie secure/sameSite on NODE_ENV so http://localhost
  login works; production behaviour unchanged.
- Regenerate package-lock.json against the public npm registry (was pinned to
  Replit's internal package-firewall.replit.local).
- Add .env.example, docs/local-dev.md, and scripts/pull-dev-secrets.mjs
  (npm run pull-secrets) for the local dev loop.
- Fix stale README references (folder name, HUBSPOT_ACCESS_TOKEN, port 5000)."
```

Do **not** commit `.env` (gitignored). Verify production still sets
`NODE_ENV=production` so the cookie stays `secure:true` / `sameSite:'none'`.
