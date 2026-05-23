# HW Actions — Architecture Reference

## Data Flow

```
Admin configures handler
  → POST /api/admin/card-action-handlers
    → card_action_handlers row (type, config JSONB)
    → card_action_handler_bindings rows (stage+status OR substatus_id)

Operator opens Sales/Survey/Design Visit page
  → GET /api/card-action-handlers  (isAuthenticated, all roles)
    → client indexes handlers into HANDLERS_BY_LABEL and HANDLERS_BY_SUBSTATUS

Operator clicks action label on a card
  → click delegation in card-action-handlers.js (capture phase)
    → resolves handler by substatus_id first, then stage|status fallback
    → calls dispatchCardActionHandler(handler, ctx)
      → opens the correct modal / popup for handler.type
```

## Database Schema

### `card_action_handlers`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| name | TEXT | Optional human label (currently always '') |
| type | TEXT | Must be in CARD_ACTION_HANDLER_TYPES |
| config | JSONB | Validated + sanitised by `_validateHandlerConfig` |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### `card_action_handler_bindings`
| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| handler_id | INT FK → card_action_handlers(id) ON DELETE CASCADE | |
| stage_key | TEXT NULL | 'sales' / 'designvisit' / 'survey' |
| status_key | TEXT NULL | Lowercase LS key, or '' for "no lead status" row |
| substatus_id | INT NULL FK → lead_substatuses(id) ON DELETE CASCADE | |

**DB-enforced constraint**: exactly one of (stage_key IS NOT NULL) or (substatus_id IS NOT NULL) must hold per row.

## Binding Resolution (client-side)

In `cardActionHandlerFor(stageKey, leadStatusKey, hwSubstatusValue)`:

1. If `hwSubstatusValue` is set (contact has a sub-status), parse it as `${LS_KEY}__${SUB_KEY}`, find the matching row in `window.LEAD_SUBSTATUSES`, and look up `HANDLERS_BY_SUBSTATUS[row.id]`. If found → use it.
2. Fall back to `HANDLERS_BY_LABEL[\`${stageKey}|${leadStatusKey}\`]`.
3. If neither matches → no handler, action strip renders as plain text.

The substatus binding is **more specific** and always wins. This means a sub-status can override the LS-default handler for a single step in the workflow.

## API Contracts

### `GET /api/card-action-handlers` — isAuthenticated (all roles)
Returns the full handler list with bindings. Used by every card page to index handlers on load.
```json
[
  {
    "id": 1,
    "name": "",
    "type": "add_design_visit_to_calendar",
    "config": { "defaultDurationMin": 60 },
    "bindings": [
      { "id": 3, "stage_key": "sales", "status_key": "in_progress", "substatus_id": null }
    ]
  }
]
```

### `GET /api/admin/card-action-handlers` — isAuthenticated + requireAdmin
Same shape as above, includes `updated_at`. Used by the admin config page.

### `POST /api/admin/card-action-handlers` — isAuthenticated + requireAdmin
Create a new handler. Body:
```json
{
  "name": "",
  "type": "your_new_type",
  "config": { "key": "value" },
  "bindings": [
    { "stage_key": "sales", "status_key": "in_progress" }
  ]
}
```
Config is passed through `_validateHandlerConfig` before storage — server returns 400 with `{ error }` on invalid input.

Bindings: each must have either `substatus_id` OR `stage_key` (not both). `status_key` may be `''` (the "no lead status" row for that stage).

### `PATCH /api/admin/card-action-handlers/:id` — isAuthenticated + requireAdmin
Partial update. Accepts any subset of `name`, `type`, `config`, `bindings`. If `bindings` is present, all existing bindings for the handler are replaced atomically.

### `DELETE /api/admin/card-action-handlers/:id` — isAuthenticated + requireAdmin
Removes the handler and its bindings (CASCADE).

### Other APIs available to handlers (client-side)

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /api/visits` | isAuthenticated | Create a CRM visit (design or survey) |
| `POST /api/events` | isAuthenticated + Google OAuth in session | Add event to operator's Google Calendar |
| `POST /api/card-actions/phone-call-summary` | isAuthenticated | LLM summarise notes → save as HubSpot engagement note |

## Admin UI Components (`public/admin.html`)

### `_buildCardActionsModel()`
Builds the staged model from `_cardActionsData` (stage_action_labels), `_leadStatusesData` (lead_status_config), and `_cardSubstatusesData` (lead_substatuses). Returns stages in Sales → Design Visit → Survey order. Each stage has `statuses[]`; each status has `defaultLabel`, `defaultStatusKey`, `substatuses[]`.

### `_buildActionSlotGroups()`
Walks the model above and returns only rows that have an action label. Used by the Action handlers card to build the grouped table. Only shows LS groups where the LS default has an action label; within those groups, sub-status rows are included only if `action_label` is non-empty.

### `renderHandlersTable()`
Renders the Action handlers card. Calls `_buildActionSlotGroups()` for ordering, `_handlersForSlot(slot)` to find attached handlers, `_handlerSummaryHtml(h)` for the description block. Wires Add/Change/Remove buttons.

### `openHandlerEditor(slot, existing)`
Opens the handler editor modal. Shows a type `<select>` with `HANDLER_TYPE_LABELS`. Shows `HANDLER_TYPE_DESCRIPTIONS[type]` as a live description. For `show_message`, hides the generic JSON config block and shows dedicated Title/Message fields. Other types get the generic JSON textarea.

### `HANDLER_TYPE_LABELS` / `HANDLER_TYPE_DESCRIPTIONS`
Both must include every entry in `CARD_ACTION_HANDLER_TYPES` (server). They drive what the admin sees when adding/editing a handler.

## Cross-Tab Refresh

After any create/update/delete of a handler in the admin UI, post:
```js
new BroadcastChannel('card_action_handlers_changed').postMessage({ ts: Date.now() });
```
All open card pages (sales.html, survey.html, customer-detail.html) listen on this channel and call `loadCardActionHandlers()` + re-render their lists.

## Config Field Conventions

| Field type | Max length | Validation pattern |
|------------|-----------|-------------------|
| Short text (title, label) | 120 chars | `String(v).trim().slice(0, 120)` |
| Medium text (subject line) | 200 chars | `String(v).trim().slice(0, 200)` |
| Long text (message body) | 2000 chars | explicit length check + `trim()` |
| Duration (minutes) | — | `parseInt` + range check (5–1440) |
| Boolean flag | — | `!!v` |

Never store: API keys/tokens, HTML markup, external URLs without scheme validation (`http:`/`https:` only), or values that need to be treated as trusted at render time.
