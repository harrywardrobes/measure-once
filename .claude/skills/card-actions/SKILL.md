---
name: card-actions
description: Implement, modify, or audit card action handlers in Harry Wardrobes. Use when adding a new handler type, changing what happens when an operator clicks an action label on a card, updating the admin config form for a handler, or reviewing handler security. Triggers for phrases like "new card action", "add handler", "action handler type", "card action modal", or any work touching the handler system.
---

# Card Actions

## What This System Does

When an operator clicks an **action label** on a Sales, Survey, or Design Visit card, a handler fires. Each handler has a **type** (a string key), an optional **config** object (JSONB), and one or more **bindings** that tie it to a `(stage_key, status_key)` pair. Admins configure handlers in `/admin` → "Action handlers".

The canonical list of valid handler types is derived at runtime from the keys of `CARD_ACTION_HANDLER_CONFIG_VALIDATORS` in `server.js`. There is no separate static type list to maintain — adding a validator key registers the type everywhere.

---

## Backbone Files

These are the source-of-truth files. Read the relevant ones before making any change. The skill references them rather than duplicating their contents so it stays accurate as the system evolves.

| File | Role |
|---|---|
| `server.js` — `CARD_ACTION_HANDLER_CONFIG_VALIDATORS` | Canonical type registry. Every valid handler type has an entry here. Also owns all admin CRUD routes and execute routes. |
| `shared/handler-outcomes.ts` | Canonical outcome registry — TypeScript/ESM. Imported by React (via Vite) and `handlerMeta.ts`. Defines outcomes, their `kind`, `setsLeadStatus`, `sendsEmailTemplates`, and action/system email refs. |
| `shared/handler-outcomes.cjs` | CJS mirror of the above — `require()`d by `server.js` and other server modules. **Must stay in sync with `.ts`.** The drift guard enforces this. |
| `src/react/utils/handlerMeta.ts` | Labels, modal summaries, and derived email template maps for every handler type. `HANDLER_EMAIL_TEMPLATES` is **derived** — never hand-edit its values. `isHandlerType()` is the runtime type guard used by the dispatcher. |
| `src/react/utils/dispatchCardActionHandler.ts` | Typed entry point for all handler dispatch. Validates the handler type via `isHandlerType()` before opening the modal. React components and click-delegation always go through here. |
| `src/react/utils/cardActionModalRegistry.ts` | Connects the dispatcher to `CardActionModalsHost`. The host registers itself here on mount; the dispatcher calls it. Keeps dispatch decoupled from the host lifecycle. |
| `src/react/components/CardActionModalsHost.tsx` | React component that renders handler modals. Contains the `switch(handler.type)` that maps types to modal components. Lazy-loads each modal for bundle efficiency. |
| `src/react/hooks/useCardActionHandlers.ts` | Fetches handlers from `/api/card-action-handlers`, indexes them by `(stage_key, status_key)` binding, and re-fetches on `BroadcastChannel('card_action_handlers_changed')`. Powers the label strip on each card. |
| `src/react/pages/admin/ActionHandlersPage.tsx` | Admin UI for creating, editing, and binding handlers. Contains `NO_CONFIG_HANDLER_TYPES` — the set of types that use no config and skip the config editor. |
| `src/react/pages/admin/HandlerConfigBlocks.tsx` | Per-type config editor components. Types with non-trivial config get a dedicated block here; all others use the JSON fallback or nothing. |
| `email-templates.js` — `TEMPLATE_DEFS` / `TEMPLATE_KEYS` | The actual email template definitions. Every key referenced in the outcome registry must exist here, and every key here must be reachable from the registry. |

---

## Dispatch Flow

```
card click → dispatchCardActionHandler.ts
               ↓ isHandlerType() guard
             cardActionModalRegistry.ts
               ↓ calls registered host
             CardActionModalsHost.tsx
               ↓ switch(handler.type)
             <SpecificModal handler ctx />
               ↓ POST /api/card-actions/<type>
             server.js route
               ↓ outcome applied
             HubSpot + DB writes
```

`ctx` carries: `contactId`, `contactName`, `contactEmail`, and optionally `contactPhone` / `contactMobile`.

---

## Adding a New Handler Type

Follow these steps in order. Every step has a specific file — read the existing entries in that file before adding yours so the new handler is consistent with the pattern.

### 1 — Register the type (`server.js`)

Add a validator function to `CARD_ACTION_HANDLER_CONFIG_VALIDATORS`. The type key is the registration — it is automatically accepted by all CRUD and execute routes.

The validator must:
- Strip every unknown field — never pass raw user input to the DB
- Validate types, lengths, and required fields
- Return `{ value: sanitisedConfig }` on success or `{ error: '…' }` on failure
- Keep total serialised config under 4 KB (the guard at the top of the function enforces this)

If the handler needs no config, return `{ value: {} }`.

### 2 — Add outcomes to the registry (`shared/handler-outcomes.ts` **and** `.cjs`)

Both files must be updated together — the drift guard (`test:handler-outcomes-drift`) will fail if they diverge.

Each outcome needs: `key`, `label`, `kind` (`'terminal'` or `'partial'`), and — for terminal outcomes — `setsLeadStatus` (the HubSpot `hs_lead_status` value to write).

- **`terminal`** — moves the card; writes `hs_lead_status`
- **`partial`** — logs progress only; no card move, no status write

For email wiring see the Email Templates section below. Use `arrange_visit` in `shared/handler-outcomes.ts` as the reference for a handler with multiple outcomes and status writes.

### 3 — Register in React metadata (`src/react/utils/handlerMeta.ts`)

Add the type to:
- `HANDLER_TYPE_LABELS` — human-readable name shown in the admin UI
- `HANDLER_MODAL_SUMMARY` — step count and HubSpot impact description shown in the admin binding editor
- `HANDLER_COMPONENT_META` — any additional metadata the admin UI needs
- Add a `<type>: deriveHandlerEmailTemplates('<type>')` line to the email templates map — the value is **derived automatically**, this line just satisfies the exhaustiveness check

The CI check (`test:handler-meta`) enforces that every `Record<HandlerType, …>` table in this file has an entry for every registered type.

### 4 — Add the modal (`src/react/components/CardActionModalsHost.tsx`)

Add a `case '<your_type>':` to the switch. Lazy-load the modal component the same way existing cases do. See `ArrangeVisitModal` or `DesignVisitFollowupModal` (referenced below) as reference implementations.

### 5 — Create the modal component

Place the component in `src/react/components/modals/`. The `handler` and `ctx` props are the standard contract — see `CardActionModalsHost.tsx` for the types.

**Draft persistence:** if the modal has form state, save it to `sessionStorage` under a key registered in `src/react/constants/localStorageKeys.ts` (keyed by `contactId`). Clear on successful submit.

**BroadcastChannel:** after a successful outcome, the modal does not need to fire the handlers channel — only admin mutations do. Do post to `'card_action_handlers_changed'` after any admin create/update/delete so `useCardActionHandlers` re-indexes in all open tabs.

### 6 — Config editor (`src/react/pages/admin/HandlerConfigBlocks.tsx` and `ActionHandlersPage.tsx`)

If the type has no config: add it to `NO_CONFIG_HANDLER_TYPES` in `ActionHandlersPage.tsx`.

If the type has simple optional config: the JSON fallback textarea is used automatically — no action needed.

If the type has required or complex config: add a dedicated `<YourTypeConfig>` block in `HandlerConfigBlocks.tsx` and wire it into the handler editor. Follow the `ScheduleVisitConfig` or `StartDesignVisitConfig` patterns.

### 7 — Server execute route(s) (`server.js`)

Add `POST /api/card-actions/<your-type>` (and sub-routes for multi-step flows). Every route must:
- Use `isAuthenticated`
- Use the appropriate `requirePrivilege` level
- Use a rate limiter for any mutation
- Derive accepted outcome keys from `getTerminalKeys()` / `getTerminalStatusMap()` in `shared/handler-outcomes.cjs` — never hardcode status strings inline

### 8 — DB changes

If the handler needs new tables, add a `node-pg-migrate` migration file (`npm run db:migrate:create -- name`). Never use `ensureXTable()` or `CREATE TABLE IF NOT EXISTS` in app code — migrations are the sole schema source of truth.

New tables that need to be sync-trackable must carry `updated_at`, `version`, and the auto-update trigger (see existing sync-readiness migrations as a reference).

---

## Email Template Wiring

Email refs live in the outcome registry, not in React. Three kinds:

| Kind | Where to add |
|---|---|
| **Per-outcome** — sent when a specific staff outcome fires | `outcome.sendsEmailTemplates: ['template_key']` in `shared/handler-outcomes.ts` + `.cjs` |
| **Action-level** — sent during the flow but not tied to one outcome (e.g. a customer-triggered email) | `ACTION_LEVEL_EMAIL_TEMPLATES['your_type']` in both files |
| **System / lifecycle** — not tied to any handler (auth, onboarding) | `SYSTEM_EMAIL_TEMPLATES` array in both files |

Every template key referenced in the registry **must** exist in `email-templates.js`. Every key in `email-templates.js` must be reachable from the registry (or it lands in the admin "Unassigned" accordion). The drift guard checks both directions.

For emails sent automatically by an integration module rather than composed by staff, use the annotated object form: `{ key: 'template_key', system: true, sentFrom: 'your-module.js' }`.

---

## Security Checklist

Before marking a handler complete:

- [ ] Config validated server-side in `CARD_ACTION_HANDLER_CONFIG_VALIDATORS` — strips, coerces, enforces all fields. Client config is untrusted.
- [ ] No IDOR — if a route takes a contact or record ID, confirm the acting user is permitted to access that record.
- [ ] Auth on every route — `isAuthenticated` on all execute routes; `requireAdmin` on admin-only mutations.
- [ ] No raw outcome keys accepted from client — derive accepted keys server-side from `getTerminalKeys()`.
- [ ] No unvalidated redirects — if the handler opens a URL, restrict the scheme (`https:` / `mailto:` only).
- [ ] No secrets in config — API keys and tokens stay in environment variables, never in the JSONB config column.
- [ ] Fail-closed on missing required config — show an error rather than silently substituting a default.

---

## CI Checks

These run as part of `npm run test:ci` and must pass before merging:

| Command | What it checks |
|---|---|
| `npm run test:handler-outcomes-drift` | `.ts` and `.cjs` outcome registries agree on terminal keys, status writes, and email refs |
| `npm run test:handler-meta` | Every `Record<HandlerType, …>` table in `handlerMeta.ts` has an entry for every registered type |
| `scripts/check-no-config-handler-types.mjs` | `NO_CONFIG_HANDLER_TYPES` in `ActionHandlersPage.tsx` stays in sync with types that have no config block |

Run these locally after adding a type before opening a PR.

---

## Reference Implementations

These two handlers cover the most common patterns — read them before implementing a new modal:

**`src/react/components/modals/ArrangeVisitModal.tsx`**
Multi-step flow (load contact context → select outcome → confirm). Shows the standard pattern for: fetching contact data via a POST, presenting outcome choices, applying a terminal outcome with a status write, and clearing session draft state on success.

**`src/react/components/modals/DesignVisitFollowupModal.tsx`**
Three-path hub for a contact at a specific lead status. Shows the pattern for: branching on current contact state, re-using shared visit wizard code between handler types (see how `start_design_visit` and `start_survey_visit` share their implementation), and handling the `revision_requested` lifecycle.
