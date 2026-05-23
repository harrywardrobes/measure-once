---
name: hw-actions
description: Add, modify, or audit card action handler types in the Measure Once (Harry Wardrobes) application. Use this skill whenever the user asks to add a new action to the card action handler system, change what happens when an operator clicks an action label on a Sales/Survey/Design Visit card, or review the security of an existing handler. Also triggers for: "new card action", "add handler", "action when operator clicks", "action handler type", "card action popup", or any work touching CARD_ACTION_HANDLER_TYPES in server.js or dispatchCardActionHandler in public/card-action-handlers.js.
---

# HW Actions — Card Action Handler Development

## What This System Does

When an operator clicks an **action label** on a Sales, Survey, or Design Visit card, a handler fires. Admins configure which handler fires for each lead-status slot in `/admin` → "Action handlers". Each handler has a **type** (e.g. `add_design_visit_to_calendar`), an optional **config** object (stored as JSONB), and one or more **bindings** that tie it to a (stage, lead-status) pair or a specific sub-status.

Read `references/architecture.md` for the full data-flow, table schema, and API contracts before making changes.

## When to Use This Skill

- Adding a new action handler type
- Changing what an existing handler does at runtime (modal UI, API calls)
- Updating the admin config form for a handler type
- Auditing a handler for XSS, auth, or data-integrity problems

## The Three-File Touch Pattern

Every new handler type requires changes in **all three** places. Missing any one breaks the full lifecycle.

| File | What to add |
|------|-------------|
| `server.js` | Register type in `CARD_ACTION_HANDLER_TYPES`; add validation branch in `_validateHandlerConfig` |
| `public/card-action-handlers.js` | Add branch in `dispatchCardActionHandler`; write the modal/action function |
| `public/admin.html` | Add to `HANDLER_TYPE_LABELS`, `HANDLER_TYPE_DESCRIPTIONS`; handle in `openHandlerEditor` if the type needs a custom config form |

---

## Step-by-Step: Adding a New Handler Type

### 1 — Server (`server.js`)

**Register the type** (~line 3565):
```js
const CARD_ACTION_HANDLER_TYPES = new Set([
  'add_design_visit_to_calendar',
  'summarise_phone_call',
  'show_message',
  'your_new_type',   // ← add here
]);
```

**Add a validation branch** in `_validateHandlerConfig` (~line 3571). The function must:
- Strip/coerce every field — never pass raw user input through to the DB
- Enforce field types, max lengths, and required fields
- Return `{ error: '…' }` on invalid input or `{ value: sanitisedConfig }` on success
- Keep the total serialised config under 4 KB (enforced by the guard at the top)

```js
if (type === 'your_new_type') {
  const out = {};
  if (cfg.someField !== undefined) {
    const v = String(cfg.someField || '').trim();
    if (v.length > 200) return { error: 'someField must be ≤200 chars.' };
    out.someField = v;
  }
  // ... required fields must fail-closed:
  if (!out.requiredField) return { error: 'requiredField is required.' };
  return { value: out };
}
```

The fallthrough `return { error: 'Unknown handler type.' }` at the end of the function catches any unregistered type — make sure your new branch returns before it.

### 2 — Client Dispatcher (`public/card-action-handlers.js`)

**Add a branch** in `dispatchCardActionHandler` (~line 101):
```js
function dispatchCardActionHandler(handler, ctx) {
  if (handler.type === 'add_design_visit_to_calendar') return openDesignVisitModal(handler, ctx);
  if (handler.type === 'summarise_phone_call')        return openPhoneSummaryModal(handler, ctx);
  if (handler.type === 'show_message')                return openMessagePopup(handler, ctx);
  if (handler.type === 'your_new_type')               return openYourModal(handler, ctx);   // ← add
  console.warn('Unknown card action handler type:', handler.type);
}
```

**Write the modal function.** Use the shared `_openModal(html)` scaffolding — it injects scoped CSS, creates a backdrop, and dismisses on outside click. The `ctx` object carries:
- `ctx.contactId` — HubSpot contact ID (may be empty on list cards)
- `ctx.contactName` — display name
- `ctx.contactEmail` — email address

Available internal helpers (already in scope, no imports needed):
- `_esc(str)` — HTML-escapes a value; **always use this for any user-supplied or config content inserted into HTML**
- `_toast(msg, isError)` — surface a toast via `showToast` if available, else console
- `_openModal(htmlString)` — returns the backdrop `<div>`; the inner `.cah-modal` div is always present
- `POST(url, body)` / `GET(url)` — fetch wrappers used elsewhere in the file (check they exist — currently not defined inside this IIFE; use `fetch` directly if needed, or follow the `openDesignVisitModal` pattern which uses `POST`)

Available server APIs (all require `isAuthenticated`):
- `POST /api/visits` — create a CRM visit record (design or survey)
- `POST /api/events` — add a Google Calendar event (requires Google OAuth in session)
- `POST /api/card-actions/phone-call-summary` — LLM summarise + save as HubSpot note

If the action needs a new server endpoint, add it to `server.js` with `isAuthenticated` (and `requireAdmin` if admin-only). See the architecture reference.

### 3 — Admin UI (`public/admin.html`)

**Register the label and description** (~line 2302):
```js
const HANDLER_TYPE_LABELS = {
  add_design_visit_to_calendar: 'Add design visit to calendar',
  summarise_phone_call:         'Summarise phone call',
  show_message:                 'Show informational message',
  your_new_type:                'Human-readable label',   // ← add
};

const HANDLER_TYPE_DESCRIPTIONS = {
  // ... existing entries ...
  your_new_type:
    'Plain-English description of what happens at runtime. ' +
    'Include: what the operator sees, what API calls are made, ' +
    'and what data is written (or explicitly that nothing is written).',
};
```

**Handle in `openHandlerEditor`** if the type needs a dedicated config form instead of the generic JSON textarea. Follow the `show_message` pattern:
- Add a new `<div id="cah-MYTYPE-block">` hidden by default
- Show/hide it in `renderForType()` — set `cfgBlock.style.display = 'none'` when your type is active
- On save, build the `cfg` object from your dedicated inputs (with client-side validation) and pass it to the existing PATCH/POST flow

The generic JSON config block still works for types with simple or optional config. Use it unless the config is required (where a textarea risks user error) or involves sensitive values.

---

## Security Checklist

Always verify these before marking a handler complete:

- [ ] **Config validated server-side**: `_validateHandlerConfig` strips, coerces, and enforces all fields. Never trust the client's `config` object.
- [ ] **HTML-escaped output**: Every piece of config or contact data inserted into modal HTML goes through `_esc()`. No bare string interpolation.
- [ ] **Auth on every endpoint**: New `POST`/`PATCH` routes use `isAuthenticated`. Admin-only mutations also use `requireAdmin`.
- [ ] **No IDOR**: If a new endpoint takes a contact or record ID, confirm the acting user is permitted to access that record.
- [ ] **No unvalidated redirects**: If the handler opens a URL (e.g. `mailto:`), ensure the scheme is restricted (`http:`/`https:`/`mailto:` only).
- [ ] **No silent fallback on missing config**: If a required field is absent, show an error rather than substituting a default that could mislead the operator.
- [ ] **BroadcastChannel fire after save**: After creating/editing a handler in the admin UI, post to `'card_action_handlers_changed'` so other open tabs re-index immediately.

---

## Config Storage Rules

Handler configs are stored as JSONB in `card_action_handlers.config`. Conventions:
- Keep configs small (< 4 KB enforced). Store IDs and short strings, not embedded HTML or full documents.
- Treat config as **admin-supplied but untrusted on the client** — it arrives in the page via `/api/card-action-handlers` and is embedded in modal HTML, so must be escaped.
- Sensitive secrets (API keys, tokens) must **never** go in config. Use environment variables and expose them only server-side.

---

## Reference Files

- `references/architecture.md` — data-flow diagram, DB schema, API contracts, binding resolution order, and handler lifecycle. Read this before any non-trivial change.
