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

## Lead-status tracker (customer-detail) sync test
Sibling of `test:lead-status-sync` that covers the per-contact tracker at the
top of the customer-detail page (`_renderWorkflowStagesImpl` in
`public/customer-detail.js`). Run with
`DATABASE_URL_TEST=<disposable> npm run test:lead-status-sync-customer-detail`
(or `PRIVTEST_ALLOW_SHARED_DB=1 npm run test:lead-status-sync-customer-detail`
against the shared DB). The harness seeds two visible lead statuses (KEY_A
before KEY_B in `sort_order`), one `excluded_from_sales` decoy, and two
sub-statuses for KEY_A; then for an admin-seeded contact on `/customers/:id`:

- Asserts the rail renders one row per non-`excluded_from_sales` status in
  admin order, the seeded `hs_lead_status` row is marked current
  (`ls-rail-item-current`), and the focused panel lists `LEAD_SUBSTATUSES`
  rows in `sort_order`.
- Exercises both the `lead_statuses_changed` and `lead_substatuses_changed`
  BroadcastChannel listeners (`workflow-core.js` lines 482–534) after admin
  PATCHes, asserting the rail/panel update in place.
- Exercises the `visibilitychange` handler the same way.
- Every BC/visibility re-render assertion also verifies
  `window.__renderToken` is preserved, proving no full page reload occurred.

The test server strips `HUBSPOT_TOKEN`, so `GET /api/contacts/:id` 503s and
the page replaces `#workflow-view` with an error. The test compensates by
re-injecting a minimal `#workflow-stages` mount and seeding
`state.selectedContact` directly — lead statuses + sub-statuses come from
PostgreSQL, not HubSpot, so the renderer paths under test are exercised
faithfully. A markdown report is written to
`test-results/lead-status-sync-customer-detail.md` and the command exits
non-zero on failure. `npm run test:ci` now runs all four test suites.

**Known limitation:** the test server strips `HUBSPOT_TOKEN`, so
`loadAllContacts()` returns 503 and contact counts in the filter options will
always be 0. The `bootstrapFilter()` helper compensates by calling
`loadLeadStatuses()` + `populateLeadStatusFilter()` directly in the page context,
so the sync-path handlers are still exercised faithfully.

## Card-action-handlers test
End-to-end live test for the card-action-handlers feature. Run with
`DATABASE_URL_TEST=<disposable> npm run test:card-action-handlers`
(or `PRIVTEST_ALLOW_SHARED_DB=1 npm run test:card-action-handlers`
against the shared DB). Mirrors the lead-status-sync harness pattern: boots a
disposable server, drives the UI with Puppeteer, writes a markdown report to
`test-results/card-action-handlers.md`, and exits non-zero on failure.

Probes covered:

- **(A) BroadcastChannel path** — admin creates a handler in `admin.html`; the
  `card_action_handlers_changed` BroadcastChannel fires and another open Sales
  tab refreshes its in-page handler lookup.
- **(B) Modal dispatch** — clicking a bound `.eq-card-action` strip opens the
  correct modal (datetime-local picker for `add_design_visit_to_calendar`,
  textarea for `summarise_phone_call`) and submitting the form posts to the
  expected backend route.
- **(C) Substatus-binding precedence** — a substatus binding wins over a label
  binding when both exist for the same `(stage_key, status_key)` the substatus
  belongs to.

API pre-checks run before any browser tab opens so failures in the API surface
clearly. `npm run test:ci` includes this suite.

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
- `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` — **required in production**
  (`NODE_ENV=production`) for Cloudflare Turnstile captcha on the public auth
  endpoints (`/api/login`, `/api/forgot-password`, `/api/request-access`). When
  `TURNSTILE_SECRET_KEY` is absent in production, those endpoints fail closed
  (503) rather than accepting unauthenticated requests without captcha. In
  development mode the check is a no-op so local operation still works without
  credentials. A `[SECURITY]` warning is logged on every server start when the
  keys are unset.
- `BOOTSTRAP_ADMIN_PASSWORD` — **emergency-only** fallback for accounts in
  `ADMIN_EMAILS` that have **no password set yet** and have **no pending
  force-reset token**. Specifically: bootstrap login is blocked (a) once an
  admin sets their own password, and (b) during the window after a
  `force-password-reset` (admin must use the emailed set-password link instead).
  Use a strong random value (e.g. a UUID or 32-char random string). Every use
  is logged as `[SECURITY] Bootstrap admin login used`.
  This secret is not required for normal operation — omit it until needed.

`REPL_ID` and Replit OIDC are no longer used.
