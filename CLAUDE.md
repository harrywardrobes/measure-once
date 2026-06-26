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
- **localStorage key registry:** Every localStorage and sessionStorage key
  used in `src/react/` must be declared as a named export in
  `src/react/constants/localStorageKeys.ts` and imported from there. Never
  pass a raw string literal directly to `getItem`, `setItem`, or
  `removeItem`. The `test:ls-keys` CI check enforces this automatically and
  will fail if a raw string literal is found outside the registry file. If a
  line genuinely needs a raw string (e.g. a one-off migration shim clearing
  an old key by its original name), suppress it with a trailing
  `// ls-key-ok: <reason>` comment.
- **Component reuse:** Always reuse existing site components before writing new
  ones. When a genuinely new MUI component type is required, reference the
  official MUI documentation before implementing it. If something outside MUI
  or the existing component set appears necessary, confirm with the user before
  proceeding.
- **Follow-up tasks:** Always propose follow-up tasks for complex work. Keep
  them as small and focused as possible. Never pre-approve anything that would
  dramatically change application functionality — always surface it for the
  user to review and approve first.
- **Design changes:** Before making any UI/design change, reference the
  existing design system docs (theme.ts, ICONS.md, src/react/README.md) and
  ask as many clarifying questions as needed to understand what the user wants.
  Any new component or significant visual update must have a Storybook story
  in `src/react/stories/` (or co-located with the component). The design
  system gallery is Storybook, accessible via the Design System card in the
  admin Settings tab or at `/storybook/`.

## Google Places API
- Secret: `GOOGLE_PLACES_API_KEY` must be present as an environment variable
  (local `.env`) / Secret Manager secret (GCP).
- The key requires **"Places API (New)"** and **"Maps JavaScript API"** enabled in Google Cloud Console. The legacy Places API is no longer used.
- Five autocomplete surfaces: `customerInfo`, `designVisit`, `arrangeVisit`, `contactEdit`, `genericVisit`. All are toggled individually in the admin Google Maps settings page.

## Stack
- Node.js 20 + Express; single `server.js` serves API and static assets.
- Static frontend in `public/` (vanilla JS + Tailwind CDN) being progressively
  migrated to React + MUI islands in `src/react/`.
- PostgreSQL accessed with raw `pg`. Schema is owned by ordered, versioned
  `node-pg-migrate` files in `migrations/` (no `ensureXTable()`/`CREATE TABLE`
  in app code). `runMigrations()` in `db-migrate.js` runs pending migrations on
  boot before auth/session setup. By default this happens in **development only**
  (`NODE_ENV !== 'production'`); in production boot-time migrations are skipped
  unless `RUN_MIGRATIONS_ON_BOOT=true` is set.
  - **Migrations are the sole source of truth for schema** — there is no
    publish-time dev→prod diff. Two ways to apply the schema in production:
    1. **Boot flag:** set `RUN_MIGRATIONS_ON_BOOT=true` so the server runs
       pending migrations at boot exactly as in development (fail-closed:
       a migration error logs and exits the process).
    2. **Pre-deploy command:** run `npm run db:migrate` against the production
       `DATABASE_URL` before deploying (no code changes needed — the script
       has no dev-only guards). This is the path used by docs/deploy.md.
  - `ensureRateLimitMigrations()` runs on every boot path regardless of the
    flag, keeping `@acpr/rate-limit-postgresql`'s own migration records intact.

## Database migrations
- Apply: `npm run db:migrate` (also auto-runs on boot). Roll back one:
  `npm run db:migrate:down`. Redo last: `npm run db:migrate:redo`. New file:
  `npm run db:migrate:create -- name`.
- Migrations use raw SQL (`pgm.sql`). Never edit an applied/merged migration —
  add a new one. Order is the numeric timestamp prefix.
- **Renaming migration files:** if a file is renamed (timestamp or slug
  changed), add an entry to `MIGRATION_RENAMES` in `db-migrate.js` — omitting
  it causes a `checkOrder` boot failure on every database that applied the
  migration under the old name. See the inline comments in `db-migrate.js`
  (~lines 23–60) for the entry format and cascade rules.
- **`public.migrations`** is owned by `@acpr/rate-limit-postgresql` — never
  drop or truncate it (it tracks the package's internal SQL migrations, not
  app migrations). `ensureRateLimitMigrations()` self-heals it on every boot.
- New sync-relevant tables must carry `updated_at` + `version` + the auto-update
  trigger (see `migrations/*_sync-readiness.js`).
- Isolated test DBs apply the full migration set via `scripts/with-test-db.js`;
  application code creates no schema at boot.

## Deployment
- Developed locally, hosted on Google Cloud Run. See
  [docs/environments.md](docs/environments.md) (concepts) and
  [docs/deploy.md](docs/deploy.md) (routine deploy runbook).
- Server binds `0.0.0.0:5000` locally (`PORT` env override; Cloud Run sets
  `PORT=8080`).
- Container build (`Dockerfile`): `npm run build:react && npm run build:storybook`.
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

### Option C — Storybook dev server (for story/design-system work)
Use this when actively editing stories in `src/react/stories/` and you want
the Design System gallery to update automatically:

```
# Terminal 1 — Express API server (optional, only needed for API-backed stories)
npm run dev          # nodemon on 5000

# Terminal 2 — Storybook dev server with HMR
npm run watch:storybook  # http://0.0.0.0:6006, auto-reloads on story changes
```

Open the gallery on **port 6006**. Every save to `src/react/stories/` or any
component it imports reflects instantly via Hot Module Replacement. This has
no effect on `public/storybook/` (the static build served by Express at
`/storybook/`) — run `npm run build:storybook` to refresh that.

> **Note:** Both `npm start` (`prestart`) and `npm run dev` (`predev`) skip the
> React build when `public/react/main.js` **already exists**, so process
> restarts and nodemon restarts are instant for server-side-only changes.
>
> On a **clean checkout** (no bundle present) the two differ:
> - `prestart` runs the full CI-quality build (typecheck + vite build +
>   bundle-size check) so production always starts with a verified bundle.
> - `predev` runs only `vite build` (no typecheck, no bundle-size check) to get
>   the dev server up as fast as possible.
>
> To rebuild React manually during development use:
> - `npm run build:react:dev` — fast Vite-only rebuild (no typecheck/size check)
> - `npm run build:react` — full CI-quality build (typecheck + size check)

## React island conventions
- Material UI is the standard component framework; every mount is wrapped
  in `AppThemeProvider`. See `src/react/README.md` and `src/react/ICONS.md`.
- Mounts are declared in `src/react/main.tsx`. Brand tokens (palette, stage
  colours, radii, typography) live in `src/react/theme.ts` — the canonical
  source of design tokens. CSS custom-property tokens are generated into
  `public/tokens.css` by `scripts/generate-tokens-css.mjs` and loaded by every
  HTML page. All shared app styles live in `public/app-styles.css`.
  (`public/style.css` has been retired and deleted.)
- Icons: named imports from `@mui/icons-material`, no inline `<svg>` in React.
- **Bundle size gate:** `scripts/check-bundle-sizes.mjs` enforces a ~40kB gzip
  cap on the always-loaded `public/react/main.js`. Any static import reachable
  from `main.tsx` lands in this bundle — keep `offlineDb.ts` and its `idb` dep
  out via dynamic `await import('./offlineDb')`. After adding a new dependency,
  run `npm run build:react` to confirm the gate still passes.
- **Admin tabs are separate, non-unmounting React roots.** Each `#tab-*` panel
  in the admin view is mounted as its own `createRoot` and never unmounts, so
  a shared React context/provider would create one live instance per opened tab
  (duplicate SSE connections, stale-data banners on wrong pages). Use a
  **module-level cache** (memoised promise) instead — see `fetchWorkflowCached()`
  in `lib/workflowConfig.ts`. Only full-page board roots get `WorkflowDataProvider`.
- **MUI v6 gotchas:**
  - Stack layout props (`alignItems`, `flexWrap`, `direction`, `justifyContent`,
    etc.) must go inside `sx={{}}` — the responsive shorthand prop system was
    removed in v6.
  - To attach `data-testid` to a Drawer/Dialog paper slot, use a `ref` callback
    (`ref: (el) => { if (el) el.setAttribute('data-testid', 'id'); }`) inside
    `slotProps.paper` — MUI v6 `SlotProps` types don't accept arbitrary data
    attributes directly and TypeScript rejects them with TS2353.

## Shared modules (CJS/ESM boundary)
Modules consumed by both the Node.js CJS server (`require()`) and the Vite/React
bundle (`import`) live in `shared/` as a paired set:
- `shared/<name>.ts` — canonical TypeScript/ESM source; imported by `.tsx`/`.ts` via Vite.
- `shared/<name>.cjs` — CJS mirror; required by server-side Node.js modules.

Server-side callers must use the **explicit `.cjs` extension**
(`require('./shared/<name>.cjs')`). Never use the bare name — Vite resolves `.js`
before `.ts`, so a co-located `.js` file breaks Rollup's named-export detection.
Add a drift-guard test if the two files must agree on critical contracts (see
`test/card-action-handlers/drift-guard.js`).

## Privilege checks
- **React components:** use `usePrivilege()` from `src/react/hooks/usePrivilege.ts`.
  Returns `{ privilegeLevel, isAdmin, isManager, isViewer }`.
- **Vanilla-JS files:** call `getPrivilegeLevel()` (defined in `public/core.js`).
  It reads `window.__moHeaderUser || state.user` and defaults to `'member'`.
- **Server route code:** call `getRequestPrivilegeLevel(req)` (exported from `auth.js`).
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
  - Hand-written `.js` files under `public/` — currently **none**. After the
    EJS/React migration the vanilla-JS client was replaced by the bundled React
    island, so this surface is retired but kept as a guard: it scans 0 source
    files today and will catch any hand-written `.js` re-added under `public/`.
    The only `.js` files there now are auto-generated, gitignored build
    artifacts (`react/`, `storybook/`, and the Workbox `sw.js`), all excluded.
    Flags any `privilege_level` read.
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
Email + password via `auth.js` (bcrypt + Passport session in PostgreSQL).
Public pages: `/login`, `/set-password`, `/onboarding`. Key API:
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

See **[docs/TEST_SUITES.md](docs/TEST_SUITES.md)** for the full suite reference,
harness notes, and the isolated temp-database wrapper documentation.
