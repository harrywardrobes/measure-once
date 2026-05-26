# Measure Once

Project management dashboard (HubSpot CRM integration).

## User preferences
- **Tests:** Only create tests for crucial backend functionality — auth, data
  integrity, API error handling. Do NOT create tests for UI behaviour, CI
  documentation, or test infrastructure. Creating new testing tasks is not a
  priority — only add tests when a specific feature task explicitly requires
  them.
- **UX first:** Before planning or building any feature, ask clarifying
  questions about how users will actually use it — expected workflows, edge
  cases, frequency of use, and pain points. Delivering an easy, intuitive
  experience is the top priority.
- **Form persistence:** All in-progress forms and multi-step data inputs must
  persist their state so that a network disconnection, accidental navigation,
  or page refresh does not lose the user's work. Use localStorage (or
  sessionStorage where appropriate) to draft-save form values and restore them
  on re-mount. Clear the draft only after a successful submit.
- **Follow-up tasks:** Always propose follow-up tasks for complex work. Keep
  them as small and focused as possible. Never pre-approve anything that would
  dramatically change application functionality — always surface it for the
  user to review and approve first.
- **Design changes:** Before making any UI/design change, reference the
  existing design system docs (theme.ts, ICONS.md, src/react/README.md) and
  ask as many clarifying questions as needed to understand what the user wants.
  Any new component or significant visual update must also be added to the
  admin Design System page so it is visible and testable there.

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
  - `build:storybook` → `public/storybook/`, served as static assets.
  - Both output dirs are gitignored.

## Local development workflow for React changes

Two patterns for iterating on `src/react/` without a manual rebuild each time:

### Option A — Vite dev server (recommended)
Run two terminals in parallel:

```
# Terminal 1 — Express API server
npm run dev          # nodemon, restarts on server-side changes

# Terminal 2 — Vite dev server with HMR
npm run dev:react    # http://0.0.0.0:5173, proxies /api → Express on 5000
```

Open the app on **port 5173** (not 5000) to get instant Hot Module Replacement.
All `/api/*` calls pass through to Express automatically. TypeScript errors
surface in the Vite terminal in real time.

### Option B — Vite build watch (simpler, no HMR)
Use this when you want to keep loading the app through the normal Express
server on port 5000 but still get auto-rebuilds on save:

```
# Terminal 1 — Express server (with pre-built bundle)
npm run dev          # nodemon on 5000

# Terminal 2 — Vite in watch / incremental-build mode
npm run watch:react  # rebuilds public/react/ on every src/react/ save
```

Reload the browser manually after each rebuild. Useful when testing
server-rendered pages or middleware that must run through Express.

> **Note:** `npm start` (`prestart`) and `npm run dev` (`predev`) both run a
> full `build:react` (typecheck + bundle + bundle-size check) before starting
> the server, so the bundle is always fresh for production use. The two
> watch-mode scripts above skip the size check to keep iteration fast.

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
- **Server route code:** call `getReqPrivilege(req)` (exported from `auth.js`).
  Returns `req.user?.privilege_level || 'member'` — the session-cached value.
  For route-level gating prefer `requireAdmin` / `requirePrivilege(minLevel)` /
  `requireManagerOrAdmin` (also in `auth.js`) — those re-query the database and
  are always up-to-date after a privilege change.
- **Deprecated:** reading `window.__moHeaderUser?.privilege_level`,
  `state.user?.privilege_level`, or `req.user?.privilege_level` directly is
  deprecated. Route all privilege checks through one of the helpers above.
- **Lint guard:** `npm run test:privilege-reads` (script:
  `scripts/check-privilege-reads.mjs`) fails CI if any guarded file contains
  a privilege bypass outside an approved context. Three surfaces are scanned:
  - `.js` files under `public/` — except `core.js`, `react/`, and `storybook/`
    (auto-generated). Flags any `privilege_level` read.
  - `.ts`/`.tsx` files under `src/react/` — except `hooks/usePrivilege.ts` and
    `hooks/usePrivilegeSync.ts` (canonical implementations) and `*.stories.*`
    (Storybook fixtures). TypeScript property-declaration lines
    (`privilege_level?: string`) are skipped automatically.
  - Server-side modules (`server.js`, `design-visits.js`, etc.) — `auth.js`
    is excluded as the canonical owner. Flags direct `req.user?.privilege_level`
    reads (the narrower server-side pattern; DB-query results and data-management
    code are not flagged).
  Lines that legitimately reference another user's field are annotated with a
  trailing `// privilege-read-ok: <reason>` comment (suppresses all surfaces).
  Run standalone or via `npm run test:ci`.

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
| `test:privilege-reads` | Static lint that blocks direct `.privilege_level` reads outside the canonical helpers. Scans all `.js` files under `public/` (excluding `core.js`, the compiled `react/`, and `storybook/` dirs) and all `.ts`/`.tsx` files under `src/react/` (excluding `usePrivilege.ts`, `usePrivilegeSync.ts`, and `*.stories.*` fixtures). A line is a violation when it contains `privilege_level`, is not a pure comment, lacks a `// privilege-read-ok: <reason>` suppression, and — for TypeScript — is not a bare property-type declaration. |
| `test:privileges` | 5-actor × 123-route capability matrix, the adversarial probe checklist, and a headless `/login → / → /admin` UI smoke. Required Turnstile-tampering probes fail closed unless opted in via `PRIVTEST_USE_TURNSTILE_SECRET_KEY=1`. |
| `test:lead-status-sync` | Customers-page filter dropdown updates via BroadcastChannel + `visibilitychange` after admin renames, count-suffix format, skeleton load/clear cycle, and sub-status chip live-rename via BC and visibilitychange. |
| `test:lead-status-sync-customer-detail` | Per-contact tracker on customer-detail (rail order, current marker, sub-status panel) re-renders via BC + `visibilitychange` without full reload. Also covers probes **(H)** and **(I)**: when the contact already has `hw_lead_substatus` pre-set, the pill's primary text (sub-status label) updates in place after a sub-status rename fired via BroadcastChannel (H) and via a hidden→visible `visibilitychange` sequence (I) — render token preserved, no full page reload. |
| `test:lead-status-sync-customer-detail-viewer` | **Isolated** viewer-role pill check: boots a fresh browser (no prior admin pages or request-interception), navigates to `/customers/:id` as a viewer, and asserts the `.lead-status-badge` pill lacks `lsb-clickable`, has no onclick, and clicking it never opens `#card-picker-popup`. Regression guard for the `canEditPipeline()` gate in `_renderWorkflowHeaderImpl`. |
| `test:lead-status-sync-customer-detail-editable` | **Isolated** manager/admin-role pill check: boots a fresh browser, runs each role in its own incognito context, and asserts the `.lead-status-badge` pill carries `lsb-clickable`, has an onclick handler, and clicking it opens `#card-picker-popup`. Regression guard for the `canEditPrivilege()` gate — catches any change that accidentally strips the editable path from manager or admin users. |
| `test:design-visit-list` | `GET /api/design-visits?contactId=…` scoping + customer-detail "Design visits" rail (status pills, totals, admin Request-revision/Delete actions, member gating). |
| `test:design-visit-qb-resubmit` | QuickBooks sparse-update vs create-new fallback branches in `runSubmitSideEffects` against a local mock QB server (uses test-only `QB_API_BASE_OVERRIDE` in `design-visits.js`). |
| `test:design-visit-submitter-name` | Regression guard for "Designer/Submitted by unknown" — captures HubSpot note + team email + customer email + sign-off approve/revision via test-only `HUBSPOT_API_BASE_OVERRIDE` and `MAIL_TRANSPORT_FILE_OVERRIDE`. |
| `test:design-visit-hubspot-retry` | HubSpot 429 retry and permanent-failure resilience for the design-visit and localdata pipelines. Covers: note-creation retry (DV1), lead-status PATCH retry (DV2), note permanent failure (DV3), lead-status permanent failure (DV4), localdata PATCH retry (LD), localdata permanent failure (LD2), room-assignment fitter PATCH retry (RA1), fitter PATCH permanent failure with `syncFailed: true` body (RA2/RA2.4), and fitter PATCH happy path with no `syncFailed` flag (RA3). Uses a local mock HubSpot server via `HUBSPOT_API_BASE_OVERRIDE`. |
| `test:card-action-handlers` | Admin handler create → cross-tab BC refresh, modal dispatch for bound `.eq-card-action` strips, and substatus-binding-wins-over-label precedence. |
| `test:duplicate-phone-warnings` | Admin "Add team member" form and Trades modal duplicate-phone alerts (notice copy, disabled submit, jump-to-record link); Edit-mode company-phone closure check (clear duplicate → notice hides → submit re-enables). |
| `test:lead-status-counts-rate-limit` | Single-flight + stale-cache + retry behaviour of `/api/contacts-lead-status-counts` against a mock HubSpot HTTP server. |
| `test:phone-directory` | Auth gating (member 403 / manager+admin 200) and payload coverage for the staff and trades sections of `GET /api/admin/phone-directory`: `allowed_emails`-only vs users-joined team rows, `kind:'company'` vs `kind:'contact'` trades entries, correct field/label/phone/email/userId/companyName/contactName values, and customers always an array. |
| `test:phone-directory-customers` | Mock-HubSpot coverage for the customers section of `GET /api/admin/phone-directory`: phone/mobilephone field mapping, two-entry split for contacts with both fields, name-fallback to email, and zero-entry guarantee for contacts with no phone data. |
| `test:bundle-sizes` | Post-build gzip-size check for every `.js` file under `public/react/`. Exits non-zero if any always-loaded chunk exceeds its threshold. Also appends a size snapshot to `test-results/bundle-sizes-history.jsonl` for trend tracking and emits a non-fatal **spike warning** when the total gzip size grows by more than `SPIKE_PCT` (5 %) relative to the immediately preceding history entry (a large dependency may have been added) — **this file must be cached/uploaded as a CI artefact** (e.g. `actions/cache@v4` + `actions/upload-artifact@v4`) so trend data and spike detection are preserved across runs; see the header comment in `scripts/check-bundle-sizes.mjs` for example steps. |
| `test:bundle-size-trend` | Unit tests for the bundle-size trend-regression warning logic in `scripts/bundle-size-trend.mjs`. Covers: growth above threshold warns, below threshold is silent, exactly at threshold is silent (strict >), single-entry window is silent, empty window is silent, zero oldest value is silent, window-slicing correctness, shrinkage is silent, and multi-entry window comparison. No build step required. |
| `test:bundle-spike-warning` | Unit tests for the per-build spike-detection warning logic (`detectSpikeWarning` in `scripts/bundle-size-trend.mjs`). Covers: growth above SPIKE_PCT warns, below threshold is silent, exactly at threshold is silent (strict >), single entry is silent, empty history is silent, zero previous value is silent (avoids division by zero), shrinkage is silent, only the last two entries are compared. No build step required. |
| `test:chunk-cache-headers` | HTTP HEAD probes against a running Express server: asserts that `/react/chunks/<hashed>.js` and `/react/assets/<hashed>.<ext>` are served with `Cache-Control: … immutable`, and that `/react/main.js` is NOT. A synthetic hashed CSS file is written to `public/react/assets/` when no real build output exists there so the ASSETS probe always runs and is never silently skipped. Guards the task-#956 static-middleware configuration against accidental revert. |
| `test:admin-tab-skeletons-new` | Puppeteer request-interception suite for the Settings, Card Actions, and Action Handlers admin tabs. Holds each tab's lazy JS chunk (`SettingsPage-*.js`, `CardActionsPage-*.js`, `ActionHandlersPage-*.js`) while React is mid-load, confirms the Suspense-fallback skeleton (`AdminSettingsPageSkeleton` / `CardActionsPageSkeleton` / `ActionHandlersPageSkeleton`) appears within the panel, then releases the chunk and asserts the skeleton is gone and the real component's static DOM is present. |
| `test:design-system-skeletons` | Puppeteer end-to-end test that confirms all nine page skeletons (`PageLoadingSkeleton`, `CustomersPageSkeleton`, `CalendarPageSkeleton`, `HomePageSkeleton`, `ProfilePageSkeleton`, `AdminTeamPageSkeleton`, `AdminSettingsPageSkeleton`, `CardActionsPageSkeleton`, `ActionHandlersPageSkeleton`) render at least one `.MuiSkeleton-root` in the DesignSystemPage gallery (Skeletons tab). All skeletons are rendered with `forceVisible` so no request interception is needed. **In `test:ci` this runs via `test:design-system-skeletons:ci`** which automatically spins up an isolated temp database using `scripts/with-test-db.js`. |
| `test:calendar-empty-state` | CalendarSection empty-state branch: `connected: true` + zero events → "Upcoming" heading + "No upcoming events" visible; `connected: false` → section absent. Intercepts `/api/calendar/upcoming` via Puppeteer; stubs all other home-page API calls so the test runs without Google OAuth credentials. |
| `test:icon-lint` | Static two-pass lint over every `.tsx`/`.ts` file under `src/react/` (excluding `.d.ts` and Storybook files). Pass 1: every `*Icon` identifier used as a JSX element or bare value must be imported from `@mui/icons-material` in that file. Pass 2: every `@mui/icons-material` import must be used at least once. No server, no DB, no Puppeteer — reads source files directly. |
| `test:mount-ids` | Two-pass static check (`scripts/check-mount-id-conflicts.mjs`). Pass 1: each React mount id in the `MOUNTS` table of `src/react/main.tsx` appears in at most one `public/*.html` file — a duplicate causes `mountKnown()` to render the wrong island on the wrong page. Pass 2: every `public/*.html` that loads `/react/main.js` must also declare at least one element id from the MOUNTS table — a page that loads the bundle with no mount element is silently loading dead JS. Pages where mounts are injected dynamically (e.g. by `chrome.js`) may suppress Pass 2 with `<!-- main-js-no-mount-ok: reason -->`. No server, no DB, no Puppeteer — reads source files directly. |
| `test:inline-styles` | Static scan (`scripts/check-inline-styles.mjs`) over every `public/*.html` file for `style="…"` attributes. Fails if any element carries an inline style without an explicit `<!-- inline-style-ok: reason -->` suppression comment on the same line. Lines inside `<script>…</script>` blocks are skipped (JS string literals, not HTML attributes). Enforces the stylesheet-first convention and catches regressions like the survey-board inline styles. No server, no DB, no Puppeteer — reads source files directly. |
| `test:workflow-js-no-dups` | Static guard (`scripts/check-workflow-js-duplicates.mjs`) that none of the 11 picker-cluster functions moved to `workflow-core.js` in task #1109 (`closeCardPicker`, `openLeadStatusPicker`, `openCardStagePicker`, `openCardSubstagePicker`, `quickSetLeadStatus`, `_quickSetLeadStatusWithSub`, `_fetchLocaldataForCard`, `_lastCompletedSubstageLabel`, `_saveCardRoomMutation`, `_substatusesForStatus`, `_currentSubstatusFor`) appear as top-level function declarations in `public/workflow.js`. Prevents silent re-introduction of duplicate definitions. No server, no DB, no Puppeteer — reads source files directly. |
| `test:turnstile-signout` | Regression guard for the bfcache restore fix and the `?signed_out=1` redirect from command-palette.js. Verifies: POST `/api/logout` redirects to `/login?signed_out=1`; `window._cpRun['sign-out']` source contains the correct redirect pattern; the "You've been signed out." banner is visible on `/login?signed_out=1`; the `#turnstile-login` iframe renders (via Turnstile stub + request-intercepted config); and `pageshow(persisted:true)` re-renders the widget. |
| `test:invoice-panel-hidden` | CSS visibility regression guard for `#inv-panel`. Visits home, trades, projects, survey, invoices, and calendar pages as an admin and asserts `visibility: hidden` via computed style on each page before the panel is opened. On the invoices page, also adds the `inv-panel-open` class and confirms visibility becomes `visible`, then removes it and confirms visibility returns to `hidden` after the transition delay. Guards against MUI emotion, Tailwind, or other stylesheet overrides of the `.inv-panel` hiding rules in `app-styles.css`. |
| `test:onboarding-conflicts` | End-to-end coverage for the onboarding conflict detection and admin resolution flow (task #1108). API probes: `POST /api/onboarding/complete` with values that differ from admin pre-fills → 200 and `pending_profile_updates` stored on `allowed_emails`; `POST /api/admin/users/:id/resolve-profile-conflicts` → 200 and `pending_profile_updates` cleared. UI probes: admin Team tab shows the `DifferenceIcon` badge on the conflict user's row; Edit dialog shows the "Onboarding discrepancies" Alert with the correct admin and user values; after resolution save the badge is gone from the row. Uses `DATABASE_URL_TEST` or `PRIVTEST_ALLOW_SHARED_DB=1`. **In `test:ci` this runs via `test:onboarding-conflicts:ci`** which automatically spins up an isolated temp database using `scripts/with-test-db.js`. |
| `test:open-leads-stale-visibility` | Tab-visibility pause for the open-leads stale badge. **(F1)** Hidden → stale response deferred: intercepts `/api/open-leads` returning `X-Cache-Status: stale` while `document.hidden=true`; badge must NOT appear immediately but MUST appear after a synthetic `visibilitychange → visible`. **(F2)** Hidden → fresh response, badge persists: with the badge visible, sets `document.hidden=true` and uses `window.__setTestPendingOpenLeadsStale(false)` to simulate a fresh response arriving while hidden; badge must STILL show and only disappear after `visibilitychange → visible`. Uses `DATABASE_URL_TEST` or `PRIVTEST_ALLOW_SHARED_DB=1`. **In `test:ci` this runs via `test:open-leads-stale-visibility:ci`** which automatically spins up an isolated temp database using `scripts/with-test-db.js`. |
| `test:ideas` | Puppeteer + API coverage for the Ideas & Feedback page (task #1094). API probes: `POST /api/ideas` → 201 with correct fields; `GET /api/ideas` most-recent order; `GET /api/ideas/:id/comments` empty array; `POST /api/ideas/:id/comments` → 201; `DELETE /api/ideas/:id` → 403 for member / 404 admin fake-id; `DELETE /api/ideas/:id/comments/:cid` → 403 member / 200 admin. UI probes: posting an idea prepends a card; comment chip lazy-fetches comments; replying adds comment inline; admin sees `[data-testid="delete-idea-btn"]` buttons and confirm dialog; member sees no delete buttons. Uses `PRIVTEST_ALLOW_SHARED_DB=1` or `DATABASE_URL_TEST`. |
| `test:keyboard-shortcuts` | Headless Chromium smoke for `window.getShortcut()` in `public/chrome.js`. Exercises four scenarios: (1) `userAgentData` path with `platform="macOS"` → ⌘K, (2) `userAgentData` path with `platform="Windows"` → Ctrl K, (3) legacy `navigator.platform` fallback `"MacIntel"` → ⌘K, (4) legacy fallback `"Win32"` → Ctrl K. No server or database required — reads the production source directly and evaluates it in a data-URL page. |
| `test:settings-tab-load` | Regression guard for the race condition fixed in task #1110 (`waitForElement` replacing early-return null checks). Logs in as admin, intercepts `GET /api/hubspot/status` → `{ connected: true }` and `GET /api/admin/lead-statuses` → one-row fixture, then opens the Settings tab via `switchTab`. Asserts (ST-A) `#hubspot-status-badge` text becomes `"Connected"` (not `"Checking…"`) and (ST-B) `#lead-statuses-table-wrap` contains a `<table>` element. |
| `test:hw-test-user:live` | **Opt-in live HubSpot smoke** for `/api/open-leads` and `/api/contacts-lead-status-counts`. Pre-flights the token; briefly toggles `app_settings.dev_filter_enabled` (restored on exit, may stay OFF on crash). Not in `test:ci`. Requires a HubSpot **private-app token** scoped for CRM contact reads, stored as the `HUBSPOT_TOKEN` secret. |
| `test:room-stale-banner-visibility` | Tab-visibility pause for the room-assignments stale banner: F1 confirms `#room-stale-banner` is absent when `/api/localdata/all` returns `X-Cache-Status: stale` while `document.hidden=true`, then appears after `visibilitychange → visible`; F2 confirms a pending clear (via `__setTestPendingRoomStale(false)`) is also deferred until visibility restores. |
| `test:room-assignments-outage` | Integration test for `GET /api/localdata/all` resilience against a prolonged HubSpot outage. **(E) Prolonged outage**: warms the contacts cache with fixture contacts carrying `measure_once_rooms`, busts the fresh cache, ages the snapshot past `ALL_CONTACTS_STALE_MAX_MS_OVERRIDE`, then confirms `GET /api/localdata/all` still returns 200 with a non-empty room map (`X-Cache-Status: stale`) — the no-cap fallback in `server.js`. **(F) Contrast**: under the same conditions, `GET /api/contacts-all` returns 502 (`HUBSPOT_ERROR`), confirming the stale cap is enforced for the main customer list. **(G) Recovery**: after HubSpot comes back online, `GET /api/localdata/all` returns 200 with `X-Cache-Status: fresh` and the mock HubSpot is actually called, confirming the cache is refreshed rather than short-circuited to the stale snapshot. |
| `test:bottom-nav` | End-to-end coverage for the "More" drawer in the bottom navigation bar. Verifies role-specific primary-tab sets ([M-BAR] member: Home/Calendar/Trades/More; [MG-BAR] manager: Home/Sales/Projects/More), drawer open/close behaviour ([M-DRAW]/[MG-DRAW]), More-tab selection when an overflow route is active ([M-ACT]/[MG-ACT]), tap-to-navigate closes drawer and updates pathname ([M-NAV]/[MG-NAV]), and backdrop click closes drawer ([CLO]). Requires `DATABASE_URL_TEST` or `PRIVTEST_ALLOW_SHARED_DB=1`. **In `test:ci` this runs via `test:bottom-nav:ci`** which automatically spins up an isolated temp database using `scripts/with-test-db.js` so no shared-DB flag is needed. |
| `test:nav-active-tab` | Regression guard for the `matchPath` prefix-route logic in `BottomNav.tsx`. Verifies: (CUST-LIST) `/customers` → `#bnav-customers` has `Mui-selected` and More tab is active; (CUST-DETAIL) `/customers/:id` full page load → `#bnav-customers` still selected; (CUST-PS) `history.pushState` from `/customers` to `/customers/:id` → tab stays selected, then deselects when pushed to `/`; (TRADES-DETAIL) `/trades/:id` → `#bnav-trades` (a primary bar item) has `Mui-selected` and More tab is NOT active; (TRADES-PS) pushState `/trades` → `/trades/:id` → `#bnav-trades` stays selected. |
| `test:nav-customise` | End-to-end coverage for the nav tab customisation dialog: API auth-gating (`GET`/`PATCH /api/users/me/prefs`), dialog opens from the More drawer for managers and is absent for members, selecting and saving 3 tabs updates the bar immediately, preference persists across a page reload, fallback to role defaults when `nav_primary_keys` is absent, and Cancel discards unsaved changes. |
| `test:nav-role-config` | End-to-end coverage for the admin role-based nav config API (task #968): `GET /api/nav-role-config` returns `__default__` keys when user has no `job_role`; returns role-specific keys when a matching `nav_role_configs` row exists; requires auth. `PATCH /api/admin/nav-role-config/:roleName` succeeds for admin, returns 403 for member/manager, validates body (wrong length / duplicates / invalid key → 400). `GET /api/admin/nav-role-configs` lists all configs for admin, 403 for non-admin. `POST /api/admin/job-roles` seeds a `nav_role_configs` row by cloning `__default__`. Puppeteer UI probe: BottomNav renders the role-specific primary tabs when the user's `job_role` has a custom config. |
| `test:change-password` | End-to-end coverage for the Change Password dialog on `/profile`: API probes (missing body → 400, wrong current password → 401, same password → 400, valid credentials → 200); UI probes (ProfilePage mounts and Password card renders, dialog opens with three fields and Submit/Cancel buttons, zxcvbn strength meter does not crash on input — regression guard for task #870, browser-autofill simulation via native value setter + input event, empty-form submission surfaces MUI helper texts, full submit flow succeeds); and a page-level error check confirming no console errors occur during the flow. |
| `test:trades` | End-to-end Trades page coverage: API CRUD + role-gating (admin/manager/viewer/member), Puppeteer-driven UI checks (search filter, category chip, Add Company / Submit for Approval visibility, duplicate-phone warning, Snackbar pause on hidden tab, ContactSlot field wiring). Requires `DATABASE_URL_TEST` or `PRIVTEST_ALLOW_SHARED_DB=1`. **In `test:ci` this runs via `test:trades:ci`** which automatically spins up an isolated temp database using `scripts/with-test-db.js` so no shared-DB flag is needed. |
| `test:sales-board-error-state` | Error and stale-data states for `SalesBoardPage`. **(A)** Bootstrap failure (cold cache, no HubSpot token): `core.js` dispatches `sales-board-bootstrap-failed` without destroying `#sales-board-mount`; component shows "HubSpot is currently unavailable" heading + "Reload page" button, no contact cards. **(B)** Pre-seeded `window.__salesBoardBootstrapFailed` via `evaluateOnNewDocument`: component reads flag synchronously in `useState` initialiser → error card renders immediately on mount (race-condition path). **(C)** Stale contacts: intercepts `/api/contacts-all` returning contacts with `X-Cache-Status: stale`; seeds `window.state` and dispatches `sales-board-cache-status` + `sales-board-data-ready`; asserts contact card present and no error card. |
| `test:sales-board-stage-labels` | Regression guard for task #983 re-fetch fix. Navigates to `/sales`, re-injects `#sales-board-mount` after bootstrap fails (no HubSpot token), remounts `SalesBoardPage` via `window.__reactIslandMount()`, and seeds `window.state.workflow` with known stage labels. Exercises two update paths: **(A) BroadcastChannel** — installs `window.loadWorkflow` and `window.loadLeadStatuses` spies, posts `lead_statuses_changed` from a second same-browser tab, and asserts both spy call-counts are ≥ 1 (guards the re-fetch requirement) plus the column header shows the renamed label without a page reload; **(B) visibilitychange** — installs the same spies, synthesises a hidden→visible transition, and asserts both functions are called and the header updates. |
| `test:survey-board` | End-to-end Puppeteer coverage for `SurveyBoardPage`: **(A)** single-column layout with "Survey" header and Filter button; **(B)** card content (name, postcode, stage pill, substage pill, source pill, stage-trail labels, "Updated" timestamp); **(C)** terminal card de-emphasis (opacity ≈ 0.55 for `statusId` in `SURVEY_TERMINAL_SUBSTAGES`); **(D)** card click navigates to `/customers/:id`; **(E)** substage filter — popover opens, unchecking a substage hides matching cards, re-checking restores them; **(F)** bootstrap-failure error state — dispatching `survey-board-bootstrap-failed` shows the warning icon, "HubSpot is currently unavailable" heading, and "Reload page" button with no `[data-contact-id]` cards; recovery via `survey-board-data-ready` clears the error and renders the board. |
| `test:customers-pagination` | Puppeteer end-to-end coverage for Customers page server-side pagination. Seeds 30 fake contacts via a mock HubSpot server and 3 `lead_status_config` rows (`PAGTEST_LS_A/B/C`) so the lead-status filter always has real options. Seven probes: **(A.1)** MUI Pagination control appears when total contacts exceeds the page limit (25); **(A.2)** clicking page 2 causes the URL to include `?page=2` and a `/api/contacts-all?page=2` request is made; **(A.3)** page-2 results differ from page-1 results (server-side slicing confirmed); **(C.1)** "Showing X–Y of Z" count string is visible on page 1; **(D.1)** changing the sort select while on page 2 resets the URL back to page 1; **(D.2)** typing in the search field while on page 2 resets to page 1; **(D.3)** selecting a value in the lead-status `<select id="lead-status-filter">` while on page 2 resets to page 1. Accepts `DATABASE_URL_TEST` or `PRIVTEST_ALLOW_SHARED_DB=1`. |

**Isolated temp-database wrapper:** `scripts/with-test-db.js` creates a fresh PostgreSQL database (named `mo_testdb_<timestamp_ms>_<hex>`), sets `DATABASE_URL_TEST` for the child process, runs the target script, then drops the temp DB on exit (including SIGINT/SIGTERM). A startup pruning step runs before each new DB is created: any existing `mo_testdb_*` database older than `TEST_DB_PRUNE_TTL_MS` (default 2 hours) is dropped automatically, guarding against orphan databases left by a force-killed CI runner. Databases using the legacy naming format (`mo_testdb_<hex>`, no timestamp) are treated as infinitely old and always pruned. All DB-dependent suites in `test:ci` run via a `:<suite>:ci` variant that invokes this wrapper, so no external `DATABASE_URL_TEST` or `PRIVTEST_ALLOW_SHARED_DB=1` flag is required when running `npm run test:ci`.

**Standalone orphan pruner:** `scripts/prune-test-dbs.js` (npm script: `prune-test-dbs`) can be run independently as a CI post-step or on-demand to drop all stale `mo_testdb_*` databases. Respects the same `TEST_DB_PRUNE_TTL_MS` env override. Logs each dropped database name and a final count summary.

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
