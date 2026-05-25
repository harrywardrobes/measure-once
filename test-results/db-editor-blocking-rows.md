# Admin Database Editor — Blocking Rows Preview E2E Test

- Run ID: `m4l2le`
- Date: 2026-05-25T08:44:17.904Z
- Command: `npm run test:db-editor-blocking-rows`

## Summary

- Passed: 16 / 16
- Failed: 0 / 16

## Results

| Result | Probe | Expected | Observed |
|---|---|---|---|
| PASS | DELETE lead_status_config returns 409 still_referenced | status=409 kind=still_referenced | status=409 kind=still_referenced |
| PASS | blockingSample contains a lead_substatuses entry | an entry with table="lead_substatuses" | sample.length=1 entries=lead_substatuses |
| PASS | blockingSample entry has refCols=[status_key], targetCols=[key] | refCols=status_key targetCols=key | refCols=status_key targetCols=key |
| PASS | blockingSample entry reports total=2 with a 2-row sample | total=2 rows.length=2 | total=2 rows.length=2 |
| PASS | blockingSample entry is marked allowed (referencing table is on the allow-list) | allowed=true | allowed=true |
| PASS | blockingSample rows expose a usable pk + label hint | every row has numeric pk; labels match seeded substatuses | pkOk=true labelOk=true rows=[{"pk":"25","label":"PrivTest blocking substatus"},{"pk":"26","label":"PrivTest second substatus"}] |
| PASS | failed FK-blocked delete does not remove the row | row still present | present=true |
| PASS | single fcol/fval filter returns only matching rows | status=200 rows=2 (both with our status_key) activeFilters=[status_key] | status=200 rows=2 af=[{"column":"status_key","value":"privtest_blocks"}] |
| PASS | composite fcol/fval (status_key + substatus_key) narrows to one row | status=200 rows=1 activeFilters=[status_key,substatus_key] | status=200 rows=1 af.cols=status_key,substatus_key |
| PASS | unknown fcol is silently dropped (no SQL error, not surfaced in activeFilters) | status=200 activeFilters=[status_key only] rows=2 (still scoped by status_key) | status=200 af=[{"column":"status_key","value":"privtest_blocks"}] rows=2 |
| PASS | GET /admin/database renders the table sidebar incl. lead_status_config | sidebar contains <button data-table="lead_status_config"> | present=true |
| PASS | lead_status_config grid loads with our fixture row | <tr data-pk="privtest_blocks"> present | present=true |
| PASS | delete drawer opens with confirm input + Delete row button | #del-confirm and #del-go present | open=true |
| PASS | delete drawer appends #del-blocking with the lead_substatuses section | #del-blocking present, mentions lead_substatuses, has Open-in-editor buttons | info={"hasWrap":true,"mentionsSub":true,"openCount":2,"hasViewAll":true,"openBtnOk":true} |
| PASS | Open-in-editor deep-link loads lead_substatuses with a status_key filter pill | title="lead_substatuses" and filter pill "status_key = privtest_blocks" | pill="status_key = privtest_blocks ×" |
| PASS | deep-linked grid shows only the rows that were blocking the delete | 2 data rows in #db-main | rows=2 |

## Coverage

- **(a) Server-side blocking sample**: a real FK constraint is installed
  between `lead_substatuses.status_key` and `lead_status_config.key` for
  the duration of the run; DELETE of the referenced status row returns
  409 with `kind="still_referenced"` and a `blockingSample` array whose
  entry exposes `table`, `refCols=[status_key]`, `targetCols=[key]`,
  `total`, `allowed=true`, and a non-empty `rows` array carrying usable
  pk + label hints. The row also remains present after the failed delete.
- **(b) fcol/fval query params**: a single filter narrows the row set and
  surfaces `activeFilters`; a composite (status_key + substatus_key)
  filter narrows further; unknown columns are silently dropped (no SQL
  error, not surfaced in `activeFilters`), so the "Open in editor"
  deep-link is safe even if the referencing schema changes.
- **(c) UI smoke (Puppeteer)**: an authenticated admin opens the delete
  drawer for the blocked row, sees `#del-blocking` with a
  `lead_substatuses` section and per-row Open-in-editor buttons, clicks
  the first one, and the editor switches to `lead_substatuses` with a
  `status_key = …` filter pill applied and the grid narrowed to the
  2 blocking rows.
