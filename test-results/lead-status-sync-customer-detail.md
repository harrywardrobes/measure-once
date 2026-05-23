# Lead-Status Tracker (customer-detail) Sync — E2E Test

- Run ID: `h8dmkf`
- Date: 2026-05-23T01:50:24.433Z
- Command: `npm run test:lead-status-sync-customer-detail`

## Summary

- Passed: 18 / 18
- Failed: 0 / 18

## Results

| Result | Probe | Expected | Observed |
|---|---|---|---|
| PASS | GET /api/admin/lead-substatuses returns the seeded sub-statuses | status=200 and rows for (PRIVTEST_LS_DT_A, STEP_ONE) and (PRIVTEST_LS_DT_A, STEP_TWO) present | status=200 foundA=true foundA2=true |
| PASS | GET /api/lead-statuses returns both visible test statuses | keys include PRIVTEST_LS_DT_A and PRIVTEST_LS_DT_B | keys present: A=true B=true |
| PASS | rail renders one row per non-excluded lead status, in admin order | PRIVTEST_LS_DT_A appears before PRIVTEST_LS_DT_B in rail (no PRIVTEST_LS_DT_X) | idxA=13 idxB=14 railLen=15 |
| PASS | excluded_from_sales status is omitted from rail | no rail entry for PRIVTEST_LS_DT_X | present=false |
| PASS | contact's hs_lead_status is marked current in the rail | rail entry with value=PRIVTEST_LS_DT_A has ls-rail-item-current class | current=PRIVTEST_LS_DT_A |
| PASS | focused panel shows sub-status rows from LEAD_SUBSTATUSES in order | [PrivTest DT Substep One, PrivTest DT Substep Two] | [PrivTest DT Substep One, PrivTest DT Substep Two] |
| PASS | PATCH /api/admin/lead-statuses/:key renames status A | status=200 label="PrivTest DT A Renamed BC" | status=200 label="PrivTest DT A Renamed BC" |
| PASS | BroadcastChannel triggers tracker rail to show new label (no reload) | rail label "PrivTest DT A Renamed BC" appears within 8 s, render token preserved | found=true labels=["Attempted to Contact","In Progress","Awaiting Photos","Rough Estimate","Design Scheduled","Design In Progress","Open Deal","Design Accepted","Deposit Invoice","Survey Scheduled","Survey In Progress","Survey Sent","Ready For Production","PrivTest DT A Renamed BC","PrivTest DT Status B"] tokenPreserved=true |
| PASS | original label is gone from rail after BroadcastChannel rename | no rail entry with label "PrivTest DT Status A" | stalePresent=false |
| PASS | PATCH /api/admin/lead-substatuses/:id renames sub-status | status=200 label="PrivTest DT Substep One Renamed" | status=200 label="PrivTest DT Substep One Renamed" |
| PASS | BroadcastChannel lead_substatuses_changed re-renders sub-status row (no reload) | task label "PrivTest DT Substep One Renamed" appears within 8 s, render token preserved | found=true tasks=["PrivTest DT Substep One Renamed","PrivTest DT Substep Two"] tokenPreserved=true |
| PASS | PATCH /api/admin/lead-statuses/:key bumps KEY_A sort_order past KEY_B | status=200 sort_order=995 | status=200 sort_order=995 |
| PASS | BroadcastChannel reorder re-renders rail with new lead-status order (no reload) | PRIVTEST_LS_DT_B now appears before PRIVTEST_LS_DT_A within 8 s, render token preserved | idxA=14 idxB=13 tokenPreserved=true |
| PASS | PATCH /api/admin/lead-substatuses/:id bumps SUB_A sort_order past SUB_A2 | status=200 sort_order=9 | status=200 sort_order=9 |
| PASS | BroadcastChannel reorder re-renders sub-status rows in new order (no reload) | STEP_TWO now appears before STEP_ONE within 8 s, render token preserved | idxA=1 idxA2=0 tokenPreserved=true |
| PASS | second PATCH renames label for visibilitychange test | status=200 label="PrivTest DT A Renamed Vis" | status=200 label="PrivTest DT A Renamed Vis" |
| PASS | visibilitychange triggers tracker rail to show new label (no reload) | rail label "PrivTest DT A Renamed Vis" appears within 8 s, render token preserved | found=true labels=["Attempted to Contact","In Progress","Awaiting Photos","Rough Estimate","Design Scheduled","Design In Progress","Open Deal","Design Accepted","Deposit Invoice","Survey Scheduled","Survey In Progress","Survey Sent","Ready For Production","PrivTest DT A Renamed Vis","PrivTest DT Status B"] tokenPreserved=true |
| PASS | BC-renamed label is gone after visibilitychange refresh | no rail entry with label "PrivTest DT A Renamed BC" | stalePresent=false |

## Coverage

- **(0) initial render**: opens `/customers/:id`, seeds an in-page contact whose
  `hs_lead_status` matches one of two visible test statuses (plus one
  `excluded_from_sales` decoy), and asserts `_renderWorkflowStagesImpl` renders
  one rail row per non-excluded status in admin sort order, marks the current
  status with `.ls-rail-item-current`, and lists `LEAD_SUBSTATUSES` rows for the
  focused entry in order.
- **(A) BroadcastChannel `lead_statuses_changed`**: renames the focused-status
  label via `PATCH /api/admin/lead-statuses/:key`, posts the channel message
  from a second same-browser tab, and asserts the rail re-renders in place with
  the new label and no stale label (exercises `workflow-core.js`
  `_lsChannel` listener → `_maybeRenderStages`).
- **(A2) BroadcastChannel `lead_substatuses_changed`**: renames a sub-status
  label via `PATCH /api/admin/lead-substatuses/:id`, posts the channel message,
  and asserts the focused panel sub-status row text updates in place
  (exercises `workflow-core.js` `_subChannel` listener → `_maybeRenderStages`).
- **(A3) BroadcastChannel reorder — lead statuses**: bumps `KEY_A`'s
  `sort_order` past `KEY_B` via PATCH, posts `lead_statuses_changed`, and
  asserts the rail re-renders in place with `KEY_B` now appearing before
  `KEY_A`. Catches reorder-propagation regressions that a rename-only probe
  would miss.
- **(A4) BroadcastChannel reorder — sub-statuses**: bumps `SUB_A`'s
  `sort_order` past `SUB_A2` via PATCH, posts `lead_substatuses_changed`,
  and asserts the focused panel sub-status rows re-render in place with
  `SUB_A2` now appearing before `SUB_A`.
- **(B) visibilitychange path**: renames the focused-status label again, then
  synthesises a hidden→visible `visibilitychange` event sequence, and asserts
  the rail picks up the latest label (exercises `workflow-core.js`
  `document.addEventListener("visibilitychange", ...)` → `renderWorkflowStages`).

Every BC/visibilitychange assertion also checks `window.__renderToken` is
preserved across the re-render, proving the tracker updated in place (no full
page reload).

## Notes

- The test server strips `HUBSPOT_TOKEN`, so `GET /api/contacts/:id` 503s and
  the customer-detail page replaces `#workflow-view` with an error. The
  `bootstrapTracker` helper rebuilds a minimal `#workflow-stages` mount, loads
  lead statuses + sub-statuses (which come from PostgreSQL, not HubSpot), seeds
  `state.selectedContact`, and calls `renderWorkflowStages()` — the same entry
  point the BC/visibilitychange handlers in `workflow-core.js` use.