---
name: add-card-action-handler
description: Conventions and patterns for adding new card action handler types to the Measure Once dashboard. Covers the existing architecture, the proposed start_design_visit multi-step wizard handler, and an 8-step checklist for any new handler type.
---

# Add Card Action Handler

## When to Use

Use this skill when:
- Adding a new card action handler type to the Measure Once dashboard
- Implementing the `start_design_visit` multi-step design visit wizard
- Extending `CARD_ACTION_HANDLER_TYPES`, `_validateHandlerConfig`, or `dispatchCardActionHandler`
- Adding admin panel UI sections for a new handler's catalogue data

---

## System Architecture Overview

Card action handlers are configurable actions attached to Sales/Survey/Design Visit card slots. Each handler is bound to either a `(stage_key, status_key)` pair **or** a `lead_substatus_id` (never both). When a user clicks the `.eq-card-action` strip on a card, the client dispatches to the correct handler modal.

### Key Files

| File | Purpose |
|------|---------|
| `server.js` (~line 3536) | `CARD_ACTION_HANDLER_TYPES` set, `_validateHandlerConfig`, `ensureCardActionHandlersTables`, all admin CRUD routes, execute routes |
| `public/card-action-handlers.js` | Client-side dispatch (`dispatchCardActionHandler`), handler resolution, modal implementations, BroadcastChannel listener |
| `public/admin.html` (~line 2315) | `HANDLER_TYPE_LABELS`, `HANDLER_TYPE_DESCRIPTIONS`, `renderHandlersTable`, `openHandlerEditor`, admin catalogue sub-sections |
| `visits.js` | `ensureVisitsTable`, visit CRUD routes (`POST /api/visits`) |
| `quickbooks.js` | QB estimate/invoice routes, token helpers |
| `auth.js` | `isAuthenticated`, `requireAdmin`, `requirePrivilege` middleware |

### Core DB Tables

```sql
-- Handler definitions (one row per named handler)
card_action_handlers (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,          -- must be in CARD_ACTION_HANDLER_TYPES
  config     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
)

-- Bindings: each handler can be wired to one or more slots
card_action_handler_bindings (
  id           SERIAL PRIMARY KEY,
  handler_id   INT  NOT NULL REFERENCES card_action_handlers(id) ON DELETE CASCADE,
  stage_key    TEXT,                 -- 'sales' | 'designvisit' | 'survey'
  status_key   TEXT,
  substatus_id INT REFERENCES lead_substatuses(id) ON DELETE CASCADE,
  CHECK (
    (stage_key IS NOT NULL AND substatus_id IS NULL) OR
    (stage_key IS NULL  AND substatus_id IS NOT NULL)
  )
)
-- Unique indexes prevent duplicate slot bindings (cahb_label_uniq, cahb_substatus_uniq)
```

### Valid Types List

`CARD_ACTION_HANDLER_TYPES` (server.js ~3536) is a `Set` and the single source of truth:
```js
const CARD_ACTION_HANDLER_TYPES = new Set([
  'add_design_visit_to_calendar',
  'summarise_phone_call',
  'show_message',
  // add new types here
]);
```
The matching client object is `HANDLER_TYPE_LABELS` in `admin.html` (~line 2318) — both must stay in sync.

### Dispatch Pattern (client)

```js
function dispatchCardActionHandler(handler, ctx) {
  if (handler.type === 'add_design_visit_to_calendar') return openDesignVisitModal(handler, ctx);
  if (handler.type === 'summarise_phone_call')        return openPhoneSummaryModal(handler, ctx);
  if (handler.type === 'show_message')                return openMessagePopup(handler, ctx);
  // add new type branch here
  console.warn('Unknown card action handler type:', handler.type);
}
```

`ctx` shape: `{ contactId, contactName, contactEmail }` — read from `data-*` attributes on the `.eq-card-action` element.

### BroadcastChannel Events

| Channel name | Fired when |
|---|---|
| `card_action_handlers_changed` | Admin creates/updates/deletes a handler |

Pages that render cards call `loadCardActionHandlers()` on this message to keep their in-memory index fresh.

---

## Card Action → HubSpot Status Map

Only `arrange_visit` mutates HubSpot contact properties. `summarise_phone_call` creates a HubSpot note on the contact but does not touch any status fields. `show_message` is fully read-only and makes no HubSpot calls.

### `arrange_visit` — outcome × visitType mapping

| `outcome` | `visitType` | `hs_lead_status` set to | `hw_lead_substatus` set to |
|---|---|---|---|
| `booked` | `design` | `DESIGN_SCHEDULED` | `DSSC_AGREED` |
| `booked` | `survey` | `SURVEY_SCHEDULED` | `SRSC_AGREED` |
| `email_sent` | `design` | `DESIGN_SCHEDULED` | `DSSC_SUGGESTED` |
| `email_sent` | `survey` | `SURVEY_SCHEDULED` | `SRSC_SUGGESTED` |
| `not_proceeding` | *(any)* | `NOT_SUITABLE` | *(empty — cleared)* |

### How `visitType` is determined (server-side)

The server reads the contact's current `hs_lead_status` from HubSpot before applying the outcome. The rule is:

- If `hs_lead_status === 'awaiting_deposit'` → `visitType = 'survey'`
- Otherwise → `visitType = 'design'`

The client never sends `visitType` directly; it is always derived server-side from the contact's live status.

---

## Existing Handler Types Reference

### `add_design_visit_to_calendar`
Opens a date/time modal, calls `POST /api/visits` (type `'design'`), optionally `POST /api/events` for Google Calendar.
Config keys: `defaultDurationMin` (5–1440), `defaultTitle` (≤120 chars), `addToGoogleCalendar` (bool).

### `summarise_phone_call`
Opens a text area, calls `POST /api/card-actions/phone-call-summary` which creates a HubSpot note on the contact, then offers to draft a follow-up email via `window.openEmailCompose` or `mailto:`.
Config keys: `notePrefix` (≤120 chars), `draftEmailSubject` (≤200 chars).
Middleware: `isAuthenticated`, `requirePrivilege('member')`, `requireHubspotToken`, `hubspotMutationLimiter`.

### `show_message`
Opens a read-only popup with an admin-authored message. Config: `message` (required, ≤2000 chars), `title` (≤120 chars).

---

## Proposed New Handler: `start_design_visit`

`start_design_visit` is a multi-step wizard that collects design visit details room-by-room, produces a QuickBooks estimate, emails the customer a sign-off link, and notifies the team. See `references/start-design-visit.md` for full DB schema, QB payload, and email specs.

### High-Level Flow

1. User clicks card action strip → wizard modal opens
2. **Step 1 — Visit details**: date/time, designer, handle selection, T&C acceptance
3. **Step 2 — Rooms**: add rooms with measurements, door style, and photo uploads
4. **Step 3 — Review**: summary before submit
5. User submits → server executes in order:
   a. Insert `design_visits` row (status `draft`)
   b. Insert `design_visit_rooms` rows + upload images to `design_visit_room_images`
   c. Update HubSpot contact `hs_lead_status` to the configured `submittedLeadStatus`
   d. Create HubSpot note summarising the visit
   e. Create QuickBooks Estimate from room line items
   f. Generate single-use sign-off token, store in `design_visit_handles` (or a dedicated sign-off table)
   g. Send customer confirmation email with "See Your Design" CTA and sign-off link
   h. Send internal team notification email
   i. Return `{ ok: true, designVisitId }` to client

### Status Lifecycle

```
draft → submitted → signed_off
              ↑         |
              └─ revision_requested ←┘
```

- `draft`: wizard saved but not submitted
- `submitted`: customer email sent, awaiting sign-off
- `revision_requested`: customer requested changes via sign-off page
- `signed_off`: customer accepted via public sign-off link

### Server Routes

All authenticated routes require `isAuthenticated`. Admin routes additionally require `requireAdmin`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/design-visits` | member | Create visit (wizard submit — runs full side-effect chain) |
| `GET` | `/api/design-visits` | member | List visits (filtered by user or all for admin) |
| `GET` | `/api/design-visits/:id` | member | Single visit detail |
| `PATCH` | `/api/design-visits/:id` | member | Update draft fields |
| `DELETE` | `/api/design-visits/:id` | admin | Delete visit |
| `POST` | `/api/design-visits/:id/submit` | member | Trigger side-effect chain if not yet submitted |
| `POST` | `/api/design-visits/:id/revision` | member | Mark revision requested, re-send email |
| `GET` | `/api/design-visits/sign-off/:token` | **public** | Render sign-off page (serves HTML or JSON) |
| `POST` | `/api/design-visits/sign-off/:token` | **public** | Record sign-off, flip status to `signed_off` |
| `GET` | `/api/admin/design-visit-handles` | admin | List handle catalogue |
| `POST` | `/api/admin/design-visit-handles` | admin | Create handle |
| `PATCH` | `/api/admin/design-visit-handles/:id` | admin | Update handle |
| `DELETE` | `/api/admin/design-visit-handles/:id` | admin | Delete handle |
| `GET` | `/api/admin/design-visit-furniture-ranges` | admin | List furniture range catalogue |
| `POST` | `/api/admin/design-visit-furniture-ranges` | admin | Create range |
| `PATCH` | `/api/admin/design-visit-furniture-ranges/:id` | admin | Update range |
| `DELETE` | `/api/admin/design-visit-furniture-ranges/:id` | admin | Delete range |
| `GET` | `/api/admin/design-visit-door-styles` | admin | List door style catalogue |
| `POST` | `/api/admin/design-visit-door-styles` | admin | Create door style |
| `PATCH` | `/api/admin/design-visit-door-styles/:id` | admin | Update door style |
| `DELETE` | `/api/admin/design-visit-door-styles/:id` | admin | Delete door style |

### Config Keys (`start_design_visit` handler)

```json
{
  "action_name":         "start_design_visit",
  "defaultDurationMin":  90,
  "submittedLeadStatus": "DESIGN_VISIT_SENT",
  "addToGoogleCalendar": true,
  "termsAndConditions":  "Your T&C text here (≤4000 chars)"
}
```

### Admin Panel Sub-Sections

Add four new sub-sections to the Card Action Handlers tab in `admin.html`:

1. **Handles catalogue** — name, description, image URL; CRUD table; fires `design_visit_handles_changed` BroadcastChannel on mutation
2. **Furniture ranges** — name, description; CRUD table; fires `design_visit_furniture_ranges_changed`
3. **Door styles** — name, image URL; CRUD table; fires `design_visit_door_styles_changed`
4. **T&C text** — single rich-text area; saved in `admin_settings` table under key `design_visit_terms`

### Client-Side Dispatch

Add to `dispatchCardActionHandler` in `public/card-action-handlers.js`:
```js
if (handler.type === 'start_design_visit') return openDesignVisitWizard(handler, ctx);
```

`openDesignVisitWizard(handler, ctx)` renders the multi-step wizard in a full-screen overlay (not the small `.cah-modal`) and manages step state internally. On submit it calls `POST /api/design-visits`. The public design-visit page lives at `public/design-visit.html`.

---

## 8-Step Checklist: Adding Any New Handler Type

Follow these steps in order when implementing a new handler type:

1. **Register the type** — Add the snake_case type string to `CARD_ACTION_HANDLER_TYPES` (Set) in `server.js`.

2. **Add config validation** — Add a branch to `_validateHandlerConfig` in `server.js`. Strip unknown keys, validate ranges/lengths, return `{ value }` on success or `{ error }` on failure.

3. **Register in admin UI labels** — Add the type to `HANDLER_TYPE_LABELS` and `HANDLER_TYPE_DESCRIPTIONS` objects in `public/admin.html`. These drive the type `<select>` and the in-row summary card.

4. **Add any config UI** — If the type needs special fields (beyond the generic JSON textarea), add a dedicated block in `openHandlerEditor` in `admin.html`, following the `show_message` pattern (toggle visibility based on selected type).

5. **Add server execute route(s)** — Create `POST /api/card-actions/<action-name>` (or equivalent). Guard with `isAuthenticated`, appropriate `requirePrivilege`, and a rate-limiter. Follow the pattern in the existing `phone-call-summary` route.

6. **Add client dispatch branch** — Add a branch to `dispatchCardActionHandler` in `public/card-action-handlers.js` and implement the modal/wizard function in the same IIFE.

7. **Create any DB tables** — Add `ensureXxxTables()` function and call it from `server.js` startup alongside existing `ensure*` calls.

8. **Fire BroadcastChannel on admin mutations** — After any admin catalogue mutation, emit `new BroadcastChannel('<type>_changed').postMessage({ ts: Date.now() })`. Pages that need fresh catalogue data listen for this channel.

---

## See Also

- `references/start-design-visit.md` — Full DB schema (6 tables), QuickBooks Estimate JSON shape, customer email HTML spec, team email spec
