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
