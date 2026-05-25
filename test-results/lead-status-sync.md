# Lead-Status Label Rename Sync — E2E Test

- Run ID: `m0tzem`
- Date: 2026-05-25T14:23:52.292Z
- Command: `npm run test:lead-status-sync`

## Summary

- Passed: 11 / 11
- Failed: 0 / 11

## Results

| Result | Probe | Expected | Observed |
|---|---|---|---|
| PASS | GET /api/admin/lead-statuses returns the test status | status=200 and key "PRIVTEST_LS_SYNC" present | status=200 found=true |
| PASS | GET /api/lead-statuses (public, auth-gated) returns the test status | status=200 and key "PRIVTEST_LS_SYNC" present | status=200 found=true |
| PASS | filter shows original label after manual bootstrap | option starting with "PrivTest Sync Label" | options: ["NEW Contact (0)","Attempted to Contact (0)","In Progress (0)","Awaiting Photos (0)","Rough Estimate (0)","Design Scheduled (0)"] |
| PASS | PATCH /api/admin/lead-statuses/:key renames the label | status=200 label="PrivTest Renamed BC" | status=200 label="PrivTest Renamed BC" |
| PASS | BroadcastChannel message triggers filter dropdown to show new label | option starting with "PrivTest Renamed BC" within 7 s | found=true options: ["NEW Contact (0)","Attempted to Contact (0)","In Progress (0)","Awaiting Photos (0)","Rough Estimate (0)","Design Scheduled (0)"] |
| PASS | original label is absent from dropdown after BroadcastChannel rename | no option starting with "PrivTest Sync Label" | stalePresent=false |
| PASS | filter shows BC-renamed label before visibilitychange rename | option starting with "PrivTest Renamed BC" | found=true options: ["NEW Contact (0)","Attempted to Contact (0)","In Progress (0)","Awaiting Photos (0)","Rough Estimate (0)","Design Scheduled (0)"] |
| PASS | second PATCH renames label for visibilitychange test | status=200 label="PrivTest Renamed Vis" | status=200 label="PrivTest Renamed Vis" |
| PASS | visibilitychange triggers filter dropdown to show new label | option starting with "PrivTest Renamed Vis" within 7 s | found=true options: ["NEW Contact (0)","Attempted to Contact (0)","In Progress (0)","Awaiting Photos (0)","Rough Estimate (0)","Design Scheduled (0)"] |
| PASS | BC-renamed label is absent from dropdown after visibilitychange refresh | no option starting with "PrivTest Renamed BC" | stalePresent=false |
| PASS | all filter options carry a "(N)" count suffix after render | every non-"All statuses" option ends with (N); at least 1 option | count=15 options: ["NEW Contact (0)","Attempted to Contact (0)","In Progress (0)","Awaiting Photos (0)","Rough Estimate (0)","Design Scheduled (0)"] |

## Coverage

- **(API pre-checks)**: verifies `GET /api/admin/lead-statuses` and `GET /api/lead-statuses`
  both surface the test status before any browser tabs are opened.
- **(A) BroadcastChannel path**: renames a lead-status label via
  `PATCH /api/admin/lead-statuses/:key`, then posts a `lead_statuses_changed`
  BroadcastChannel message from a second same-browser tab, and asserts the
  `#lead-status-filter` dropdown on the Customers page reflects the new label
  text (exercising the `_lsChannel.addEventListener("message", …)` handler
  in `workflow-core.js` lines 353–361).  Also asserts the stale label is gone.
- **(B) visibilitychange path**: renames the label again server-side, then
  synthesises a hidden→visible visibilitychange event sequence and asserts
  the dropdown updates (exercising the
  `document.addEventListener("visibilitychange", …)` handler in
  `workflow-core.js` lines 340–347).  Also asserts the stale label is gone.
- **(C) count format**: verifies every filter option carries a "(N)" count
  suffix after `populateLeadStatusFilter` runs, confirming label+count are
  rendered together correctly.

## Notes

- The test server strips `HUBSPOT_TOKEN` so `loadAllContacts()` returns 503.
  Contact counts in the filter options will therefore all be 0 in CI.
  The `bootstrapFilter()` helper calls `loadLeadStatuses()` +
  `populateLeadStatusFilter()` directly in the page context to establish the
  initial filter state independently of the HubSpot contact load.