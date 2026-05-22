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
Run `DATABASE_URL_TEST=<disposable connection string> npm run test:privileges`
to boot a dedicated test server (port 5050 by default, override with
`PRIV_TEST_PORT`) against that isolated DB, seed four disposable users
(`privtest-<role>-<runId>@privtest.local`) at each privilege level, exercise
sign-in, the admin page, a 106-route capability matrix (every registered
`/api/*` route — including `/api/login`, `/api/logout`, `/api/request-access`,
`/api/forgot-password`, `/api/set-password`, `/api/change-password` —
× five actors), the full adversarial probe checklist, and a headless Puppeteer
UI smoke (`/login` → `/` → `/admin` per role with screenshot capture into
`test-results/screenshots/`). The harness refuses to run against the shared
`DATABASE_URL` unless you also export `PRIVTEST_ALLOW_SHARED_DB=1` — synthetic
rows are still namespaced behind the `privtest-` prefix and cleaned up on
exit, but a crash mid-run can leave stale fixtures. A markdown report is
written to `test-results/privileges.md`; the command exits non-zero when any
probe or matrix cell fails. Findings only — fixes are tracked as separate
tasks.

Probes covered: token single-use, session invalidation on revoke /
force-reset / change-password, mass-assignment + cross-cookie / swapped-key
abuse on `/api/change-password`, IDOR, admin-only mutations as non-admins
(including approve/reject lifecycle on account requests), OAuth callback
gating (Google + QuickBooks: stale / cross-user / missing state), CSRF
method-confusion, XSS round-trip through `/api/admin/requests` and the
allow-list note field, mid-session privilege downgrade, rate-limit hammering
of `/api/login`, `/api/request-access`, **and** `/api/forgot-password`, plus
a REQUIRED Turnstile tampering matrix (no-token / empty / replayed / 10KB /
literal dummy) across `/api/login`, `/api/request-access`,
`/api/forgot-password` — when prerequisites are missing the run records a
hard failing finding (no acknowledgement escape; run with
`PRIVTEST_USE_TURNSTILE_SECRET_KEY=1` + a real `TURNSTILE_SECRET_KEY` to
clear it).

The harness strips `TURNSTILE_SECRET_KEY` / `HUBSPOT_TOKEN` / `SMTP_*` /
`GOOGLE_*` / `QB_*` so it runs without third-party credentials. Opt any one
back in with `PRIVTEST_USE_<NAME>=1 <NAME>=… npm run test:privileges` —
required for the captcha tampering probes (`PRIVTEST_USE_TURNSTILE_SECRET_KEY=1`)
and to resolve HubSpot/Google/QuickBooks-gated matrix cells.

## Lead-status sync test
Run `DATABASE_URL_TEST=<disposable connection string> npm run test:lead-status-sync`
to boot a dedicated test server (reusing the privilege harness) and exercise the
two real-time sync paths that keep the lead-status filter dropdown on the Customers
page up to date after a label rename:

- **(A) BroadcastChannel path** — a second same-browser tab posts a
  `lead_statuses_changed` BroadcastChannel message; the Customers page listener
  calls `loadLeadStatuses()` → `populateLeadStatusFilter()` and the dropdown
  reflects the new label.
- **(B) visibilitychange path** — after a server-side rename the test synthesises
  a hidden→visible `visibilitychange` sequence; the handler fetches fresh statuses
  and re-renders the dropdown.
- **(C) count format** — every filter option must carry a `(N)` count suffix after
  `populateLeadStatusFilter()` runs.

The run also includes API pre-checks (`GET /api/admin/lead-statuses` and
`GET /api/lead-statuses`) before any browser tabs open. A markdown report is
written to `test-results/lead-status-sync.md`; the command exits non-zero when
any probe fails.

If a disposable database is unavailable, `PRIVTEST_ALLOW_SHARED_DB=1 npm run test:lead-status-sync` is accepted as a fallback — synthetic rows are namespaced behind the `privtest-` prefix and cleaned up on exit, but a crash mid-run can leave stale fixtures.

**Known limitation:** the test server strips `HUBSPOT_TOKEN`, so
`loadAllContacts()` returns 503 and contact counts in the filter options will
always be 0. The `bootstrapFilter()` helper compensates by calling
`loadLeadStatuses()` + `populateLeadStatusFilter()` directly in the page context,
so the sync-path handlers are still exercised faithfully.

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
- `BOOTSTRAP_ADMIN_PASSWORD` — **emergency-only** fallback password for all
  accounts listed in `ADMIN_EMAILS`. When set, those accounts can log in with
  this password even if their normal password is unset or forgotten, bypassing
  the usual bcrypt check. Use a strong random value (e.g. a UUID or 32-char
  random string). Every use is logged as `[SECURITY] Bootstrap admin login used`.
  This secret is not required for normal operation — omit it until needed.

`REPL_ID` and Replit OIDC are no longer used.
