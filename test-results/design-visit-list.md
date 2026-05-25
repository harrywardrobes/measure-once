# Design Visit List (customer-detail) — E2E Test

- Run ID: `lt9x3z`
- Date: 2026-05-25T08:24:11.987Z
- Command: `npm run test:design-visit-list`

## Summary

- Passed: 12 / 12
- Failed: 0 / 12

## Results

| Result | Probe | Expected | Observed |
|---|---|---|---|
| PASS | [API] contactId filter returns only that contact's visits | status=200, ids=[25,26], no decoy | status=200, ids=[25,26] |
| PASS | [API] estimate_total_pence summed from rooms (visit A = 120000) | estimate_total_pence=120000 (8 × 15000) | estimate_total_pence=120000 |
| PASS | [API] estimate_total_pence summed from rooms (visit B = 15100) | estimate_total_pence=15100 (2 × 7550) | estimate_total_pence=15100 |
| PASS | [API] anonymous GET /api/design-visits is blocked | status=401 (or 302) | status=401 |
| PASS | [UI] Admin /customers/:id renders #design-visits-section with 2 .comment-item | present=true, error=false, items.length=2 | present=true, error=false, items.length=2 |
| PASS | [UI] Each item shows the expected status pill label | pills=["Signed off","Submitted"] | pills=["Signed off","Submitted"] |
| PASS | [UI] Each item shows the expected "Estimate: £N.NN" total | meta includes ["Estimate: £151.00","Estimate: £1200.00"] | meta=[["Estimate: £151.00"],["Estimate: £1200.00"]] |
| PASS | [UI] Each item shows the expected visit_date (en-GB d MMM yyyy) | when=["12 Aug 2024","24 May 2024"] | when=["12 Aug 2024","24 May 2024"] |
| PASS | [ADM] Admin sees both Request-revision and Delete buttons per visit | each item has Request-revision + Delete with onclick pointing at its id | buttons=[[{"text":"Review","onclick":"toggleDesignVisitReview(26)"},{"text":"Request revision","onclick":"markDesignVisitRevision(26)"},{"text":"Delete","onclick":"deleteDesignVisit(26)"}],[{"text":"Review","onclick":"toggleDesignVisitReview(25)"},{"text":"Request revision","onclick":"markDesignVisitRevision(25)"},{"text":"Delete","onclick":"deleteDesignVisit(25)"}]] |
| PASS | [ADM] Non-admin (member) sees neither Request-revision nor Delete | no Request-revision or Delete button on any item | buttons=[["Review"],["Review"]] |
| PASS | [ADM] Admin DELETE /api/design-visits/:id removes the visit from the list | visitB removed from UI and from DB | uiOk=true, dbRows=0 |
| PASS | [ADM] Admin Request-revision flips status to revision_requested | visitA status=revision_requested in DB + pill flips in UI | uiOk=true, dbStatus=revision_requested |

## Coverage

- **[API] `GET /api/design-visits?contactId=…`** — seeds two visits for one
  contact and a decoy visit for a different contact, then asserts the
  filter returns only the target contact's rows (no decoy) and that
  `estimate_total_pence` is computed from the seeded rooms.
- **[API] anonymous gate** — unauthenticated `GET /api/design-visits`
  is rejected (401/302) by `isAuthenticated`.
- **[UI] customer-detail renders the section** — navigates to
  `/customers/:id` as admin, seeds `state.selectedContactId`, calls
  `renderDesignVisits()`, and asserts the rendered `#design-visits-list`
  contains one `.comment-item` per visit with the correct status-pill
  label (`Signed off` / `Submitted`), `Estimate: £N.NN` total, and the
  visit date formatted as en-GB `d MMM yyyy`.
- **[ADM] admin-only action buttons** — asserts each item shows
  `Request revision` and `Delete` buttons whose `onclick` references the
  correct visit id when viewed as admin, and that **neither** button
  appears when the same page is viewed as a member.
- **[ADM] Delete round-trip** — invokes `deleteDesignVisit(id)` (accepts
  the `confirm()` dialog), then asserts the row disappears from the UI
  *and* from the `design_visits` table.
- **[ADM] Request-revision round-trip** — invokes
  `markDesignVisitRevision(id)` (accepts the `prompt()` dialog with a
  test note), then asserts the pill flips to `Revision requested` in the
  UI, the `Request revision` button is no longer shown for that row, and
  the database row has `status=revision_requested` with the persisted
  note.

## Notes

- The privileges harness strips `HUBSPOT_TOKEN`, so
  `GET /api/contacts/:id` 503s and the customer-detail bootstrap replaces
  `#workflow-view` with an error message. The Design-visits section is
  rendered from a separate code path (`renderDesignVisits` in
  `public/customer-detail.js`) keyed off `state.selectedContactId`, so
  the test seeds `state.selectedContactId`, re-injects the section mount
  if needed, and calls `renderDesignVisits()` directly. The renderer
  paths under test run against the live `/api/design-visits` endpoint.
- Fixtures seeded with the synthetic contact ids
  (`989800000683`, `989800000684`) are purged on exit alongside the
  standard `privtest-` user fixtures.