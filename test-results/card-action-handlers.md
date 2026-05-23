# Card Action Handlers — E2E Test

- Run ID: `qlvaqz`
- Date: 2026-05-23T01:10:44.059Z
- Command: `npm run test:card-action-handlers`

## Summary

- Passed: 17 / 17
- Failed: 0 / 17

## Results

| Result | Probe | Expected | Observed |
|---|---|---|---|
| PASS | GET /api/admin/card-action-handlers responds for admin | status=200, JSON array | status=200 type=array |
| PASS | GET /api/card-action-handlers (authenticated) responds | status=200, JSON array | status=200 type=array |
| PASS | salesTab lookup starts with no handler for our test label | cardActionHandlerFor('sales', 'privtest_cah_dv') === null | null=true |
| PASS | POST /api/admin/card-action-handlers creates DV handler | status=201 with numeric id and one binding | status=201 id=6 bindings=1 |
| PASS | BroadcastChannel triggers salesTab to refresh its handler lookup | cardActionHandlerFor('sales', 'privtest_cah_dv') returns the new handler | got={"id":6,"type":"add_design_visit_to_calendar","name":"PrivTest design visit handler"} |
| PASS | click on DV-bound card opens the design-visit modal (datetime-local) | modal with #cah-dv-start[type=datetime-local], #cah-dv-title, #cah-dv-duration | got={"hasDatetime":true,"hasTitle":true,"hasDuration":true,"hasTextarea":true} |
| PASS | DV modal submit POSTs /api/visits | one POST request to /api/visits | requests=[{"url":"http://127.0.0.1:5050/api/visits","method":"POST"}] |
| PASS | DV modal submit did NOT call /api/events when Google checkbox is off | no POST /api/events | requests=[{"url":"http://127.0.0.1:5050/api/visits","method":"POST"}] |
| PASS | DV submit persisted a row in the visits table | 1 row with type=design and customer_id=privtest-cah-dv-001 | rows=1 types=design |
| PASS | POST /api/admin/card-action-handlers creates phone-summary handler | status=201 with bindings.length === 1 | status=201 id=7 bindings=1 |
| PASS | click on PC-bound card opens the phone-summary modal (textarea, no datetime) | modal with textarea#cah-pc-summary and no input#cah-dv-start | got={"hasTextarea":true,"hasDatetime":false} |
| PASS | PC modal submit POSTs /api/card-actions/phone-call-summary | one POST request to /api/card-actions/phone-call-summary | requests=[{"url":"http://127.0.0.1:5050/api/card-actions/phone-call-summary","method":"POST"}] |
| PASS | two override-test handlers created (label + substatus) | both 201; substatus binding has substatus_id set | lbl.status=201 sub.status=201 sub.bindings=[{"id":9,"stage_key":null,"status_key":null,"substatus_id":27}] |
| PASS | salesTab has the test lead_substatus loaded into window.LEAD_SUBSTATUSES | row with status_key=PRIVTEST_CAH_OVR substatus_key=PRIVTEST_SUB present | present=true |
| PASS | label binding resolves when no substatus value is passed | cardActionHandlerFor('sales', 'privtest_cah_ovr') returns handler A (id=8) | got={"id":8,"type":"add_design_visit_to_calendar"} |
| PASS | substatus binding overrides label binding when both exist | cardActionHandlerFor('sales', 'privtest_cah_ovr', 'PRIVTEST_CAH_OVR__PRIVTEST_SUB') returns handler B (id=9) | got={"id":9,"type":"summarise_phone_call"} |
| PASS | unknown substatus value falls back to the label binding | returns handler A (id=8) | got={"id":8,"type":"add_design_visit_to_calendar"} |

## Coverage

- **(API pre-checks)**: verify `GET /api/admin/card-action-handlers` and
  `GET /api/card-action-handlers` respond before any browser tab opens.
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

## Notes

- The test server strips `HUBSPOT_TOKEN`, so the phone-summary route is
  exercised at the URL-routing level only (its HubSpot mutation cannot
  succeed in this harness).  The design-visit handler's primary backend
  (`/api/visits`) does not require HubSpot, so the database write is
  verified end-to-end.
- Fixtures (handlers by name, the test lead_substatus row, and the
  synthetic `privtest-cah-*` visits) are purged in `cleanupAndExit()`.