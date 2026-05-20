# Measure Once

Project management dashboard (HubSpot CRM integration).

## Stack
- Node.js 20 + Express
- Static frontend in `public/` (vanilla JS + Tailwind via CDN)
- Single server file: `server.js` serves both API and static assets

## Replit Setup
- Workflow: `Start application` runs `npm start`
- Server binds to `0.0.0.0:5000` (PORT env var override supported)
- Deployment: VM target, `node server.js`

## Authentication
Email + password sign-in is wired in via `auth.js` (bcrypt + passport session, no
Replit OIDC). Public auth pages: `/login`, `/set-password`, `/onboarding`. API:
- `POST /api/login` — `{ email, password }`; returns `{ ok, next }` on success
- `POST /api/logout` — destroys the session; redirects to `/login` (or JSON if `Accept: application/json`)
- `GET  /api/auth/user` — current user (requires session); shape unchanged
- `GET  /api/set-password/validate?token=…` — public, checks a token's freshness
- `POST /api/set-password` — `{ token, password }`; consumes a single-use token
- `POST /api/onboarding/complete` — first-login profile form
- `POST /api/admin/users/:email/resend-set-password` — admin re-issues the link

### Approval & onboarding flow
1. Admin approves an access request (or adds a team member directly).
2. Server creates the `users` row with `onboarding_status = 'more_info_required'`
   and emails a one-time set-password link (24h TTL, hash stored in
   `password_set_tokens`). The user shows up on the Team list with a
   **More info required** badge.
3. User sets a password via the link, then signs in at `/login`.
4. On first login, an onboarding gate forces them to `/onboarding` to fill in
   the same fields as the admin "Add team member" form before any other API
   call succeeds (gate returns 403 `ONBOARDING_REQUIRED`).
5. Completing onboarding flips status to `active`; subsequent logins land on
   the dashboard.

## Privilege adversarial test suite
Run `npm run test:privileges` to boot a dedicated test server (port 5050 by
default, override with `PRIV_TEST_PORT`) against the live `DATABASE_URL`, seed
four disposable users (`privtest-<role>-<runId>@privtest.local`) at each
privilege level, exercise sign-in, the admin page, the per-route capability
matrix (every gate type × five actors), and ~25 adversarial probes (token
single-use, session invalidation on revoke / force-reset / change-password,
mass-assignment via PATCH `/api/users/:id/profile`, IDOR, admin-only mutations
as non-admins, OAuth callback gating, XSS data round-trip). A markdown report
is written to `test-results/privileges.md`; the command exits non-zero when
any probe or matrix cell fails. Findings only — fixes are tracked as separate
tasks. The harness unsets `TURNSTILE_SECRET_KEY` / `HUBSPOT_TOKEN` / `SMTP_*` /
`GOOGLE_*` / `QB_*` so it runs without third-party credentials.

### Migration note
Users that existed before this change are backfilled to `active` (no onboarding
prompt) but have **no password set**. An admin must click **Resend
set-password** on the Team tab for each of them before they can log in again.

Sessions and users are stored in PostgreSQL (`sessions`, `users`,
`password_set_tokens` — all auto-created on boot). Protect routes by importing
`isAuthenticated` from `./auth`.

## Required Secrets
- `DATABASE_URL`, `SESSION_SECRET` — required
- `ADMIN_EMAILS` — comma-separated bootstrap admins
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — used to send
  the "set your password" email; if missing, the link is logged to the server
  console for manual delivery
- `APP_URL` (or `REPLIT_DOMAINS`) — used to build the absolute link in emails
- `HUBSPOT_TOKEN` — HubSpot private app token (otherwise `/api/*` HubSpot endpoints return 503)
- `GOOGLE_*` — Google OAuth credentials for calendar integration

`REPL_ID` and Replit OIDC are no longer used.
