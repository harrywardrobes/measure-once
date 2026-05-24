# Card Action Handlers — E2E Test

- Run ID: `wymrdg`
- Date: 2026-05-24T20:13:22.106Z
- Command: `npm run test:card-action-handlers`

## Summary

- Passed: 79 / 87
- Failed: 8 / 87

## Results

| Result | Probe | Expected | Observed |
|---|---|---|---|
| PASS | GET /api/admin/card-action-handlers responds for admin | status=200, JSON array | status=200 type=array |
| PASS | GET /api/card-action-handlers (authenticated) responds | status=200, JSON array | status=200 type=array |
| PASS | NEG-01: defaultDurationMin < 5 rejected | status=400 with error message containing "defaultDurationMin" | status=400 error="defaultDurationMin must be 5–1440." |
| PASS | NEG-02: defaultDurationMin > 1440 rejected | status=400 with error message containing "defaultDurationMin" | status=400 error="defaultDurationMin must be 5–1440." |
| PASS | NEG-03: defaultDurationMin non-numeric rejected | status=400 with error message containing "defaultDurationMin" | status=400 error="defaultDurationMin must be 5–1440." |
| PASS | NEG-04: config as array rejected | status=400 with error message containing "config must be a JSON object" | status=400 error="config must be a JSON object." |
| PASS | NEG-05: config > 4 KB rejected | status=400 with error message containing "too large" | status=400 error="config payload is too large (max 4KB)." |
| PASS | NEG-06: defaultTitle > 120 chars rejected | status=400 with error message containing "defaultTitle" | status=400 error="defaultTitle must be 120 characters or fewer." |
| PASS | NEG-07: notePrefix > 120 chars rejected | status=400 with error message containing "notePrefix" | status=400 error="notePrefix must be 120 characters or fewer." |
| PASS | NEG-08: show_message with absent message rejected | status=400 with error message containing "message" | status=400 error="message is required for show_message handlers." |
| PASS | NEG-09: show_message with message > 2000 chars rejected | status=400 with error message containing "2000" | status=400 error="message must be 2000 characters or fewer." |
| PASS | NEG-10: unknown handler type rejected | status=400 with error message | status=400 error="type must be add_design_visit_to_calendar, summarise_phone_call, show_message, start_design_visit." |
| PASS | NEG-11: name > 80 chars rejected | status=400 with error message containing "80" | status=400 error="name must be 80 characters or fewer." |
| PASS | NEG-12: binding with invalid stage_key rejected | status=400 with error message containing "stage_key" | status=400 error="stage_key must be one of: sales, designvisit, survey." |
| PASS | NEG-13: binding with illegal status_key chars rejected | status=400 with error message containing "status_key" | status=400 error="status_key may only contain lowercase letters, digits, and underscores." |
| PASS | NEG-14: binding missing both stage_key and substatus_id rejected | status=400 with error message containing "stage_key" | status=400 error="Each binding requires a stage_key or substatus_id." |
| PASS | NEG-15: substatus_id = 0 rejected | status=400 with error message containing "substatus_id" | status=400 error="substatus_id must be a positive integer." |
| PASS | NEG-16: substatus_id non-numeric string rejected | status=400 with error message containing "substatus_id" | status=400 error="substatus_id must be a positive integer." |
| PASS | NEG-17: PATCH with defaultDurationMin < 5 rejected | status=400 with error message containing "defaultDurationMin" | status=400 error="defaultDurationMin must be 5–1440." |
| PASS | NEG-18: PATCH with invalid binding stage_key rejected | status=400 with error message containing "stage_key" | status=400 error="stage_key must be one of: sales, designvisit, survey." |
| FAIL | NEG-19: POST with non-snake_case config.action_name rejected | status=400 with error message containing "action_name" | status=201 error=undefined |
| PASS | NEG-20: POST with valid snake_case config.action_name accepted | status=201 with integer id | status=201 id=36 |
| PASS | PRIV-00: member GET /api/admin/card-action-handlers blocked | status=403 (or 401/302) | status=403 |
| PASS | PRIV-01: member POST /api/admin/card-action-handlers blocked | status=403 (or 401/302) | status=403 |
| PASS | PRIV-02: member PATCH /api/admin/card-action-handlers/:id blocked | status=403 (or 401/302) | status=403 |
| PASS | PRIV-03: member DELETE /api/admin/card-action-handlers/:id blocked | status=403 (or 401/302) | status=403 |
| PASS | salesTab lookup starts with no handler for our test label | cardActionHandlerFor('sales', 'privtest_cah_dv') === null | null=true |
| PASS | POST /api/admin/card-action-handlers creates DV handler | status=201 with numeric id and one binding | status=201 id=38 bindings=1 |
| PASS | BroadcastChannel triggers salesTab to refresh its handler lookup | cardActionHandlerFor('sales', 'privtest_cah_dv') returns the new handler | got={"id":38,"type":"add_design_visit_to_calendar","name":"PrivTest design visit handler"} |
| PASS | click on DV-bound card opens the design-visit modal (datetime-local) | modal with #cah-dv-start[type=datetime-local], #cah-dv-title, #cah-dv-duration | got={"hasDatetime":true,"hasTitle":true,"hasDuration":true,"hasTextarea":true} |
| PASS | DV modal submit POSTs /api/visits | one POST request to /api/visits | requests=[{"url":"http://127.0.0.1:5050/api/visits","method":"POST"}] |
| PASS | DV modal submit did NOT call /api/events when Google checkbox is off | no POST /api/events | requests=[{"url":"http://127.0.0.1:5050/api/visits","method":"POST"}] |
| PASS | DV submit persisted a row in the visits table | 1 row with type=design and customer_id=privtest-cah-dv-001 | rows=1 types=design |
| PASS | POST /api/admin/card-action-handlers creates phone-summary handler | status=201 with bindings.length === 1 | status=201 id=39 bindings=1 |
| PASS | click on PC-bound card opens the phone-summary modal (textarea, no datetime) | modal with textarea#cah-pc-summary and no input#cah-dv-start | got={"hasTextarea":true,"hasDatetime":false} |
| PASS | PC modal submit POSTs /api/card-actions/phone-call-summary | one POST request to /api/card-actions/phone-call-summary | requests=[{"url":"http://127.0.0.1:5050/api/card-actions/phone-call-summary","method":"POST"}] |
| PASS | two override-test handlers created (label + substatus) | both 201; substatus binding has substatus_id set | lbl.status=201 sub.status=201 sub.bindings=[{"id":11,"stage_key":null,"status_key":null,"substatus_id":27}] |
| PASS | salesTab has the test lead_substatus loaded into window.LEAD_SUBSTATUSES | row with status_key=PRIVTEST_CAH_OVR substatus_key=PRIVTEST_SUB present | present=true |
| PASS | label binding resolves when no substatus value is passed | cardActionHandlerFor('sales', 'privtest_cah_ovr') returns handler A (id=40) | got={"id":40,"type":"add_design_visit_to_calendar"} |
| PASS | substatus binding overrides label binding when both exist | cardActionHandlerFor('sales', 'privtest_cah_ovr', 'PRIVTEST_CAH_OVR__PRIVTEST_SUB') returns handler B (id=41) | got={"id":41,"type":"summarise_phone_call"} |
| PASS | unknown substatus value falls back to the label binding | returns handler A (id=40) | got={"id":40,"type":"add_design_visit_to_calendar"} |
| PASS | (D) POST handler A for conflict slot returns 201 | status=201 with numeric id | status=201 id=42 |
| PASS | (D) handler B seeded directly with the same (sales, LBL_KEY_CONFLICT) binding | DB insert succeeds after unique index drop | conflictAId=42 conflictBId=43 |
| PASS | (D) GET /api/admin/card-action-handlers/conflicts returns the seeded duplicate | status=200, total>=1, conflict for (sales, privtest_cah_conflict) listing handlers 42 & 43 | status=200 total=1 slot={"type":"label","stage_key":"sales","status_key":"privtest_cah_conflict","substatus_id":null,"count":2,"handler_ids":[42,43],"handler_names":["PrivTest conflict handler A","PrivTest conflict handler B"]} |
| PASS | (D) GET /api/admin/card-action-handlers/conflicts blocks non-admin members | status=403 (or 401/302) | status=403 |
| PASS | (D) GET /api/admin/card-action-handlers/conflicts blocks unauthenticated requests | status=401/403/302 | status=401 |
| PASS | (D) ⚠ Fix button appears in the card-actions table for the conflicted slot | button.ca-fix-conflict-btn inside [data-ls-block="PRIVTEST_CAH_CONFLICT"] | found=found |
| FAIL | (D) conflict-resolver modal opens with 2 handler rows | 2 .ca-conflict-row elements present | rows=null |
| PASS | (D) conflict-resolver modal closes after removing one handler | no .ca-conflict-row elements (modal wrapper removed from DOM) | result=closed |
| FAIL | (D) "✓ Resolved" flash pill appears on the table row after modal closes | .ca-resolved-pill visible in the target row within 3 s | result=null |
| PASS | (D) "✓ Resolved" flash pill disappears from DOM after ~2 s | .ca-resolved-pill removed from DOM ~2 s after appearing | result=gone |
| FAIL | (D) ⚠ Fix button no longer shown after conflict is resolved | no .ca-fix-conflict-btn inside [data-ls-block="PRIVTEST_CAH_CONFLICT"] | result=null |
| PASS | (E) POST handler with action_name="send_quote" returns 201 | status=201 with numeric id and one binding | status=201 id=44 bindings=1 |
| FAIL | (E.1) admin card-actions table renders the send_quote badge | a <span> with text "send_quote" is visible in the card-action-handlers panel | result=null |
| FAIL | (E.2) cardActionHandlerAttrs emits data-card-action-name="send_quote" | returned string contains data-card-action-name="send_quote" | attrStr=" data-card-action-handler-id=\"44\" data-card-action-handler-type=\"summarise_phone_call\" data-card-action-contact-id=\"test-aname-001\" data-card-action-contact-name=\"PrivTest ActionName\" data-card-action-contact-email=\"aname@privtest.local\"" |
| FAIL | (E.3) Sales card strip .eq-card-action-label reads "Send Quote" via enquiryRowHtml() | "Send Quote" (title-cased action_name overrides nextActionLabel fallback) | got={"label":null} |
| PASS | (F) editor modal opens via openHandlerEditor() with #cah-action-name input | opened | result=opened |
| PASS | (F.1) #cah-action-name-err becomes visible after blurring an invalid value | computed style.display !== "none" | result=visible |
| PASS | (F.1) clicking Save with an invalid action_name leaves the modal open with a #cah-edit-err message | modalOpen=true, editErrText non-empty, no POST sent | modalOpen=true editErrText="Action name may only contain lowercase letters, digits, and underscores." postsDelta=0 |
| PASS | (F.1) no handler is created by the invalid-save attempt | count of HANDLER_NAME_NAMING unchanged (0) | before=0 after=0 |
| PASS | (F.2) #cah-action-name-err is hidden after blurring a valid snake_case value | computed style.display === "none" | result=hidden |
| PASS | (F.2) clicking Save with a valid action_name closes the modal | modal wrapper removed (no #cah-action-name in DOM) | result=closed |
| FAIL | (F.2) POST /api/admin/card-action-handlers created the handler with config.action_name="send_quote_ok" | handler appears in GET /api/admin/card-action-handlers with matching binding and action_name | created=null posts=1 |
| PASS | (G/handle) seeded 3 rows with sort_order 10/20/30 | 3 ids returned | ids=1,2,3 |
| PASS | (G/handle) catalogue panel renders the seeded rows in sort_order | ordered ids = [1,2,3] | got=[1,2,3] |
| PASS | (G/handle) first row ▲ and last row ▼ render with disabled, middle row's are enabled | firstUpDisabled=true, lastDownDisabled=true, middleUpEnabled=true, middleDownEnabled=true | {"firstUpDisabled":true,"lastDownDisabled":true,"middleUpEnabled":true,"middleDownEnabled":true} |
| PASS | (G/handle) clicking ▲ on the last row sends 2 PATCH calls that swap sort_order | 2 PATCHes — id 3 → sort_order=20, id 2 → sort_order=30 | count=2 3=20 2=30 |
| PASS | (G/handle) rows re-render in the new order after the swap (no page reload) | ordered ids = [1,3,2] | got=[1,3,2] |
| PASS | (G/handle) the page was not fully reloaded (window.__reorderToken preserved) | __reorderToken === "sentinel-1779653597519" | before=sentinel-1779653597519 after=sentinel-1779653597519 |
| PASS | (G/handle) BroadcastChannel "design_visit_handles_changed" fires after a swap | __reorderBcCount >= 1 | count=1 |
| PASS | (G/handle) GET /api/admin/design-visit-handles shows the swapped sort_order values persisted | id 3 → 20, id 2 → 30 | 3=20 2=30 |
| PASS | (G/furniture) seeded 3 rows with sort_order 10/20/30 | 3 ids returned | ids=1,2,3 |
| PASS | (G/furniture) catalogue panel renders the seeded rows in sort_order | ordered ids = [1,2,3] | got=[1,2,3] |
| PASS | (G/furniture) first row ▲ and last row ▼ render with disabled, middle row's are enabled | firstUpDisabled=true, lastDownDisabled=true, middleUpEnabled=true, middleDownEnabled=true | {"firstUpDisabled":true,"lastDownDisabled":true,"middleUpEnabled":true,"middleDownEnabled":true} |
| PASS | (G/furniture) clicking ▲ on the last row sends 2 PATCH calls that swap sort_order | 2 PATCHes — id 3 → sort_order=20, id 2 → sort_order=30 | count=2 3=20 2=30 |
| PASS | (G/furniture) rows re-render in the new order after the swap (no page reload) | ordered ids = [1,3,2] | got=[1,3,2] |
| PASS | (G/furniture) the page was not fully reloaded (window.__reorderToken preserved) | __reorderToken === "sentinel-1779653599497" | before=sentinel-1779653599497 after=sentinel-1779653599497 |
| PASS | (G/furniture) BroadcastChannel "design_visit_furniture_ranges_changed" fires after a swap | __reorderBcCount >= 1 | count=1 |
| PASS | (G/furniture) GET /api/admin/design-visit-furniture-ranges shows the swapped sort_order values persisted | id 3 → 20, id 2 → 30 | 3=20 2=30 |
| PASS | (G/door-style) seeded 3 rows with sort_order 10/20/30 | 3 ids returned | ids=1,2,3 |
| PASS | (G/door-style) catalogue panel renders the seeded rows in sort_order | ordered ids = [1,2,3] | got=[1,2,3] |
| PASS | (G/door-style) first row ▲ and last row ▼ render with disabled, middle row's are enabled | firstUpDisabled=true, lastDownDisabled=true, middleUpEnabled=true, middleDownEnabled=true | {"firstUpDisabled":true,"lastDownDisabled":true,"middleUpEnabled":true,"middleDownEnabled":true} |
| PASS | (G/door-style) clicking ▲ on the last row sends 2 PATCH calls that swap sort_order | 2 PATCHes — id 3 → sort_order=20, id 2 → sort_order=30 | count=2 3=20 2=30 |
| PASS | (G/door-style) rows re-render in the new order after the swap (no page reload) | ordered ids = [1,3,2] | got=[1,3,2] |
| PASS | (G/door-style) the page was not fully reloaded (window.__reorderToken preserved) | __reorderToken === "sentinel-1779653601489" | before=sentinel-1779653601489 after=sentinel-1779653601489 |
| PASS | (G/door-style) BroadcastChannel "design_visit_door_styles_changed" fires after a swap | __reorderBcCount >= 1 | count=1 |
| PASS | (G/door-style) GET /api/admin/design-visit-door-styles shows the swapped sort_order values persisted | id 3 → 20, id 2 → 30 | 3=20 2=30 |

## Coverage

- **(API pre-checks)**: verify `GET /api/admin/card-action-handlers` and
  `GET /api/card-action-handlers` respond before any browser tab opens.
- **(PRIV) Member-privilege probes** — 3 pure-REST probes that confirm a
  regular approved member is blocked (403) from mutating admin routes:
  - PRIV-01: member POST `/api/admin/card-action-handlers` → 403.
  - PRIV-02: member PATCH `/api/admin/card-action-handlers/:id` → 403.
  - PRIV-03: member DELETE `/api/admin/card-action-handlers/:id` → 403.
- **(NEG) Negative-path validation probes** — 18 pure-REST probes that
  POST or PATCH `/api/admin/card-action-handlers` with each known-bad
  payload and assert the server returns 400 with a descriptive error:
  - NEG-01/02/03: `defaultDurationMin` below 5, above 1440, non-numeric.
  - NEG-04: `config` is an array (not a JSON object).
  - NEG-05: `config` payload > 4 KB.
  - NEG-06: `defaultTitle` > 120 chars is rejected with 400.
  - NEG-07: `notePrefix` > 120 chars is rejected with 400.
  - NEG-08/09: `show_message` with absent or overlong `message`.
  - NEG-10: unknown handler type.
  - NEG-11: `name` > 80 chars.
  - NEG-12: binding with an invalid `stage_key`.
  - NEG-13: binding with illegal `status_key` characters (uppercase / special).
  - NEG-14: binding with neither `stage_key` nor `substatus_id`.
  - NEG-15/16: `substatus_id` = 0 or a non-numeric string.
  - NEG-17: PATCH with `defaultDurationMin` < 5.
  - NEG-18: PATCH with an invalid binding `stage_key`.
  - NEG-19: POST with non-snake_case `config.action_name` (spaces + punctuation).
  - NEG-20: happy-path companion — valid snake_case `config.action_name` accepted (201).
  Both handler types (`add_design_visit_to_calendar`, `summarise_phone_call`)
  and both binding shapes (label and substatus) are exercised.
- **(A) BroadcastChannel cross-tab refresh**: a second same-browser tab
  posts `card_action_handlers_changed`; the Sales-tab listener re-fetches
  and its `cardActionHandlerFor()` lookup resolves the newly-created
  handler.  Also confirms the lookup starts empty (no stale state).
- **(B) Click → modal → backend route**: an injected `.eq-card-action`
  element bound to each handler type is clicked.  The design-visit
  handler must open a datetime-local picker and submit to `/api/visits`
  (verified both via Puppeteer network interception and a follow-up DB
  query confirming the row landed).  The phone-summary handler must open
  a textarea modal and submit to `/api/card-actions/phone-call-summary`
  (verified via network interception — the route returns 503 in this
  harness because HUBSPOT_TOKEN is stripped, which is irrelevant to the
  URL-routing assertion).
- **(C) Substatus binding overrides label binding**: with handler A bound
  to (sales, LBL) and handler B bound to a substatus whose status_key
  matches LBL, `cardActionHandlerFor()` returns A when no substatus value
  is passed and B when the matching substatus value is passed.  A bogus
  substatus value falls back to A, confirming the override is conditional.
- **(D) Conflict-fix flow**: a test lead-status row (stage=SALES) is
  seeded so the slot appears in the card-actions table.  Handler A is
  created via the API; the unique label-binding index is then temporarily
  dropped and handler B is inserted directly in the DB with the same
  (sales, LBL_KEY_CONFLICT) binding — the only way to reproduce the
  conflict state the Fix button is designed to clear.  The harness then
  opens a fresh admin tab, switches to the Card actions panel, and waits
  for the ⚠ Fix button to appear beside the conflicted slot.  Clicking Fix
  must open the conflict-resolver modal with exactly 2 handler rows;
  clicking Remove on one row must close the modal, flash a "✓ Resolved"
  green pill on the target table row (visible within 3 s of modal close,
  gone from the DOM within ~2 s after appearing), and remove the ⚠ Fix
  button from the badge area.  `purgeFixtures()` re-creates the unique
  index after deleting the conflicting rows.
- **(E) action_name display**: a handler is seeded with
  `config.action_name = "send_quote"` bound to `(sales, LBL_KEY_ANAME)`.
  Three assertions confirm the field flows end-to-end:
  - **E.1** A fresh admin tab switches to the Card actions panel and
    polls until a `<span>` whose text is exactly `"send_quote"` is
    visible inside `#card-action-handlers-wrap` (the badge rendered by
    `_handlerSummaryHtml` in `admin.html`).
  - **E.2** After re-fetching handlers in the Sales tab,
    `cardActionHandlerAttrs('sales', LBL_KEY_ANAME, null, ctx)` returns
    a string containing `data-card-action-name="send_quote"`.
  - **E.3** `enquiryRowHtml()` is called in-page (the real `sales.js`
    rendering function) with a fake contact whose `hs_lead_status`
    matches `LBL_KEY_ANAME`.  The resulting HTML is injected into the
    DOM and the text of `.eq-card-action-label` is read directly,
    asserting it equals `"Send Quote"`.  Because `LBL_KEY_ANAME` is a
    synthetic key absent from the workflow config, `nextActionLabel()`
    returns empty — proving `_cahName` wins over the fallback.
- **(G) DV catalogue arrow-reordering** (task #669): for each of the
  three catalogues (handles, furniture ranges, door styles) the harness
  seeds 3 rows with `sort_order` 10/20/30, opens a fresh admin tab on
  the Design visit panel, and asserts:
  - The first row's ▲ button and the last row's ▼ button render with
    the `disabled` attribute; the middle row's ▲/▼ are enabled.
  - Clicking ▲ on the last row sends exactly two PATCH calls to
    `/api/admin/design-visit-<type>/:id` that swap the `sort_order`
    values of the moved and previous rows.
  - The list re-renders in the new order without a full page reload
    (verified via a `window.__reorderToken` sentinel set before the
    click and read back afterwards).
  - The per-type `design_visit_<type>_changed` BroadcastChannel fires
    after the swap (a listener installed in the same tab observes the
    self-posted message — `_broadcastDvCatalogueChange()` runs in the
    sender's context).
  - A follow-up GET on the catalogue endpoint confirms the swapped
    `sort_order` values were persisted server-side.

## Notes

- The test server strips `HUBSPOT_TOKEN`, so the phone-summary route is
  exercised at the URL-routing level only (its HubSpot mutation cannot
  succeed in this harness).  The design-visit handler's primary backend
  (`/api/visits`) does not require HubSpot, so the database write is
  verified end-to-end.
- Fixtures (handlers by name, the test lead_substatus row, the conflict
  test lead-status row, and the synthetic `privtest-cah-*` visits) are
  purged in `cleanupAndExit()`.  The unique label-binding index is
  recreated there after the conflicting rows are removed.