# Measure Once

Project management dashboard (HubSpot CRM integration).

## Stack
- Node.js 20 + Express; single `server.js` serves API and static assets.
- Static frontend in `public/` (vanilla JS + Tailwind CDN) being progressively
  migrated to React + MUI islands in `src/react/`.

## Replit Setup
- Workflow: `Start application` runs `npm start`.
- Server binds `0.0.0.0:5000` (`PORT` env override).
- Deployment: VM target, `node server.js`.
- Build step: `npm run build:react && npm run build:storybook`.
  - `build:react` → `public/react/main.js` (stable filename, self-mounting).
    Run after editing anything in `src/react/`. `npm run dev:react` runs
    Vite on 5173 with `/api` proxied to Express.
  - `build:storybook` → `public/storybook/`, served as static assets.
  - Both output dirs are gitignored.

## React island conventions
- Material UI is the standard component framework; every mount is wrapped
  in `AppThemeProvider`. See `src/react/README.md` and `src/react/ICONS.md`.
- Mounts are declared in `src/react/main.tsx`. Brand tokens (palette, stage
  colours, radii, typography) live in `src/react/theme.ts` — the canonical
  source of design tokens; `public/style.css` will eventually be retired.
- Icons: named imports from `@mui/icons-material`, no inline `<svg>` in React.

## Privilege checks
- **React components:** use `usePrivilege()` from `src/react/hooks/usePrivilege.ts`.
  Returns `{ privilegeLevel, isAdmin, isManager, isViewer }`.
- **Vanilla-JS files:** call `getPrivilegeLevel()` (defined in `public/core.js`).
  It reads `window.__moHeaderUser || state.user` and defaults to `'member'`.
- **Deprecated:** reading `window.__moHeaderUser?.privilege_level` or
  `state.user?.privilege_level` directly is deprecated. Route all privilege
  checks through one of the two helpers above.

## Authentication
Email + password via `auth.js` (bcrypt + Passport session in PostgreSQL — no
Replit OIDC). Public pages: `/login`, `/set-password`, `/onboarding`. Key API:
- `POST /api/login`, `POST /api/logout`, `GET /api/auth/user`
- `GET /api/set-password/validate?token=…`, `POST /api/set-password`
- `POST /api/onboarding/complete`
- `POST /api/admin/users/:email/resend-set-password`

Protect routes by importing `isAuthenticated` from `./auth`. Admin routes
also use `requireAdmin`. Sessions, users, and `password_set_tokens` tables
are auto-created on boot.

### Approval & onboarding flow
1. Admin approves an access request (or adds a team member directly).
2. Server creates the `users` row with `onboarding_status = 'more_info_required'`
   and emails a one-time set-password link (24h TTL, hash in
   `password_set_tokens`). User shows a **More info required** badge.
3. User sets a password via the link, then signs in.
4. First login is gated to `/onboarding` (gate returns 403 `ONBOARDING_REQUIRED`)
   until profile fields are filled in.
5. Completing onboarding flips status to `active`.

**Pre-auth migration note:** legacy users were backfilled to `active` with
no password set. An admin must click **Resend set-password** on the Team tab
for each of them before they can log in.

## Admin database editor
Generic table browser at `/admin/database` for inspecting/fixing data that
has no dedicated admin UI. Allow-list lives in `db-editor.js` (`TABLES`) —
add new editable tables there explicitly. Sensitive auth/session/token
tables are excluded. All endpoints under `/api/admin/db/*` are gated by
`isAuthenticated + requireAdmin`.

Every write is wrapped in a transaction that also appends to
`db_editor_audit` (admin_email, table, pk, op, before/after JSON). The
**Audit log** tab supports one-click revert via
`POST /api/admin/db/audit/:id/revert`.

### Schema constraints used by the db editor
A small set of cross-table FKs are `ON DELETE NO ACTION` so the editor's
"blocking rows" preview surfaces dependents instead of silently orphaning:
- `lead_substatuses.status_key → lead_status_config(key)`
  (`lead_substatuses_status_key_fk`, in `ensureLeadSubstatusesTable`).

`card_action_handler_bindings` FKs stay `ON DELETE CASCADE` — the admin
handler-delete flow relies on the cascade.

## Dev-only admin features
The admin **Dev environment** tab (`#tab-devenv` in `public/admin.html`)
lists every feature suppressed when `NODE_ENV=production`. **Convention:**
whenever you add anything gated on `NODE_ENV !== 'production'` to the admin
panel, add a matching entry to `#tab-devenv` (name, location, why excluded).
A maintainer comment above the panel restates this rule.

## Design visits — QuickBooks estimate sync
`runSubmitSideEffects` in `design-visits.js` is idempotent across
re-submissions. When a `revision_requested` visit is resubmitted and already
has `qb_estimate_id`, the pipeline fetches that estimate and:
- If `TxnStatus` is `Pending` (or absent) with a `SyncToken`, issues a
  **sparse update** (`{ Id, SyncToken, sparse: true, … }`). Visit row keeps
  the same `qb_estimate_id` / `qb_estimate_doc_num`.
- Otherwise (404, voided/deleted/auth error, or `TxnStatus` ≠ Pending) a new
  estimate is created and the prior id is appended to a JSONB
  `design_visits.qb_estimate_history` column with `replaced_at`,
  `replaced_by`, and `reason: prior_estimate_not_updatable`.

## Test suites
All suites accept either `DATABASE_URL_TEST=<disposable>` or, as a fallback,
`PRIVTEST_ALLOW_SHARED_DB=1` (synthetic rows are namespaced behind a
`privtest-` prefix and cleaned up on exit — a mid-run crash can leave stale
fixtures). Each suite writes a markdown report to `test-results/<name>.md`
and exits non-zero on failure. `npm run test:ci` runs all the suites listed
below except `test:hw-test-user:live`.

| Script | Covers |
| --- | --- |
| `test:privileges` | 5-actor × 123-route capability matrix, the adversarial probe checklist, and a headless `/login → / → /admin` UI smoke. Required Turnstile-tampering probes fail closed unless opted in via `PRIVTEST_USE_TURNSTILE_SECRET_KEY=1`. |
| `test:lead-status-sync` | Customers-page filter dropdown updates via BroadcastChannel + `visibilitychange` after admin renames, count-suffix format, skeleton load/clear cycle, and sub-status chip live-rename via BC and visibilitychange. |
| `test:lead-status-sync-customer-detail` | Per-contact tracker on customer-detail (rail order, current marker, sub-status panel) re-renders via BC + `visibilitychange` without full reload. |
| `test:lead-status-sync-customer-detail-viewer` | **Isolated** viewer-role pill check: boots a fresh browser (no prior admin pages or request-interception), navigates to `/customers/:id` as a viewer, and asserts the `.lead-status-badge` pill lacks `lsb-clickable`, has no onclick, and clicking it never opens `#card-picker-popup`. Regression guard for the `canEditPipeline()` gate in `_renderWorkflowHeaderImpl`. |
| `test:design-visit-list` | `GET /api/design-visits?contactId=…` scoping + customer-detail "Design visits" rail (status pills, totals, admin Request-revision/Delete actions, member gating). |
| `test:design-visit-qb-resubmit` | QuickBooks sparse-update vs create-new fallback branches in `runSubmitSideEffects` against a local mock QB server (uses test-only `QB_API_BASE_OVERRIDE` in `design-visits.js`). |
| `test:design-visit-submitter-name` | Regression guard for "Designer/Submitted by unknown" — captures HubSpot note + team email + customer email + sign-off approve/revision via test-only `HUBSPOT_API_BASE_OVERRIDE` and `MAIL_TRANSPORT_FILE_OVERRIDE`. |
| `test:card-action-handlers` | Admin handler create → cross-tab BC refresh, modal dispatch for bound `.eq-card-action` strips, and substatus-binding-wins-over-label precedence. |
| `test:duplicate-phone-warnings` | Admin "Add team member" form and Trades modal duplicate-phone alerts (notice copy, disabled submit, jump-to-record link); Edit-mode company-phone closure check (clear duplicate → notice hides → submit re-enables). |
| `test:lead-status-counts-rate-limit` | Single-flight + stale-cache + retry behaviour of `/api/contacts-lead-status-counts` against a mock HubSpot HTTP server. |
| `test:phone-directory-customers` | Mock-HubSpot coverage for the customers section of `GET /api/admin/phone-directory`: phone/mobilephone field mapping, two-entry split for contacts with both fields, name-fallback to email, and zero-entry guarantee for contacts with no phone data. |
| `test:hw-test-user:live` | **Opt-in live HubSpot smoke** for `/api/open-leads` and `/api/contacts-lead-status-counts`. Pre-flights the token; briefly toggles `app_settings.dev_filter_enabled` (restored on exit, may stay OFF on crash). Not in `test:ci`. Requires a HubSpot **private-app token** scoped for CRM contact reads, stored as the `HUBSPOT_TOKEN` secret. |

**Privileges harness behaviour:** strips `TURNSTILE_SECRET_KEY`,
`HUBSPOT_TOKEN`, `SMTP_*`, `GOOGLE_*`, `QB_*` so it runs without
third-party credentials. Opt any back in with
`PRIVTEST_USE_<NAME>=1 <NAME>=… npm run test:privileges`. `ADMIN_EMAILS` is
an `optionalPassthrough` (`PRIVTEST_USE_ADMIN_EMAILS=1`).

**HubSpot-token-stripping side effect:** when `HUBSPOT_TOKEN` is stripped,
`GET /api/contacts/:id` 503s and customer-detail bootstrap replaces
`#workflow-view` with an error. Tests that need the page-level renderers
wait for that error, then re-inject the relevant mount (e.g.
`#workflow-stages`, `#design-visits-section`) and seed `state.selectedContact`
directly. Lead statuses/sub-statuses/design visits come from PostgreSQL,
so the renderer paths under test still run faithfully.

**Test-only env overrides** (never set in production): `QB_API_BASE_OVERRIDE`
(`design-visits.js`), `HUBSPOT_API_BASE_OVERRIDE`, `MAIL_TRANSPORT_FILE_OVERRIDE`.

## Required Secrets
- `DATABASE_URL`, `SESSION_SECRET` — required.
- `ADMIN_EMAILS` — comma-separated bootstrap admins.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — set-password
  email. If missing, the link is logged to the server console.
- `APP_URL` (or `REPLIT_DOMAINS`) — absolute link base in emails.
- `HUBSPOT_TOKEN` — HubSpot private app token (otherwise HubSpot endpoints 503).
- `GOOGLE_*` — Google OAuth (Gmail + Calendar).
- `TURNSTILE_SECRET_KEY`, `TURNSTILE_SITE_KEY` — **required in production** for
  Cloudflare Turnstile captcha on `/api/login`, `/api/forgot-password`,
  `/api/request-access`. Absent in production → endpoints fail closed (503).
  Dev mode is a no-op. A `[SECURITY]` warning is logged at startup if unset.
- `BOOTSTRAP_ADMIN_PASSWORD` — **emergency-only** fallback for `ADMIN_EMAILS`
  accounts with no password set and no pending force-reset token. Blocked
  once an admin sets their own password, and during the window after a
  `force-password-reset`. Use a strong random value. Every use is logged as
  `[SECURITY] Bootstrap admin login used`. Omit until needed.
- `DEBUG_HUBSPOT` — optional. When truthy, enables verbose server logs for
  HubSpot rate-limit events, retry/backoff attempts in `hubspotSearchWithRetry`
  (used by `/api/open-leads` and `/api/contacts-lead-status-counts`), and
  stale-cache fallbacks in `/api/contacts-lead-status-counts`
  (e.g. `serving stale counts`). Unset in production to keep logs quiet;
  a `[DEBUG]` warning is printed at startup when this flag is on.

`REPL_ID` and Replit OIDC are no longer used.
