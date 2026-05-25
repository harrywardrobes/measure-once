# design-visit QB resubmit findings

Run: 2026-05-25T08:25:33.107Z
Result: PASS (10/10)

| ID | Result | Detail |
|----|--------|--------|
| A.sparse-payload | PASS | POST carried Id, SyncToken=7, sparse:true, 1 Line |
| A.id-unchanged | PASS | qb_estimate_id stayed QBPRIORA |
| A.history-empty | PASS | qb_estimate_history remained empty |
| A.status | PASS | status=submitted |
| B.create-payload | PASS | POST omitted Id / SyncToken / sparse (create-new) |
| B.id-updated | PASS | qb_estimate_id moved to QBNEW1000 |
| B.history-appended | PASS | history has 1 entry for QBPRIORB with reason prior_estimate_not_updatable |
| C.create-payload | PASS | POST omitted Id / SyncToken / sparse (create-new after 404) |
| C.id-updated | PASS | qb_estimate_id moved to QBNEW1001 |
| C.history-appended | PASS | history has 1 entry for QBPRIORC |
