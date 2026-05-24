# Design Visit Catalogue Admin Modals — E2E Test

- Run ID: `wv8anv`
- Date: 2026-05-24T20:11:59.499Z
- Command: `npm run test:dv-catalogue-admin`

## Summary

- Passed: 24 / 24
- Failed: 0 / 24

## Results

| Result | Probe | Expected | Observed |
|---|---|---|---|
| PASS | GET /api/admin/design-visit-handles responds for admin | status=200, JSON array | status=200 type=array |
| PASS | GET /api/admin/design-visit-furniture-ranges responds for admin | status=200, JSON array | status=200 type=array |
| PASS | GET /api/admin/design-visit-door-styles responds for admin | status=200, JSON array | status=200 type=array |
| PASS | admin page exposes switchTab + loadDvCatalogue | both globals available | ready=true |
| PASS | design-visit catalogue lists load (no "Loading…") | all three wraps replaced their Loading placeholders | ready=true |
| PASS | [H] click + Add opens the modal | modal with #dvie-name appears | clicked=true |
| PASS | [H] modal renders #dvie-name + #dvie-save | modal inputs present | ready=true |
| PASS | [H] Save button is disabled and shows "Saving…" while POST is in flight | #dvie-save.disabled === true && text === "Saving…" | state={"disabled":true,"text":"Saving…"} |
| PASS | [H] no full page reload (window.__pageLoadToken preserved) | __pageLoadToken === "5l8pcerb754" | preserved=true |
| PASS | [H] list at #dv-handles-wrap grew by ≥1 row after save | row count > 0 | state={"rows":1,"text":"\n      \n        \n          \n            Image\n            Name\n            Style\n            \n            \n          \n        \n        \n          \n            \n              \n                —\n              \n              privtest-dvca handle\n              Bar\n              \n                ▲\n                ▼\n              \n              \n                Edit\n                Delete\n              \n            \n        \n      "} |
| PASS | [H] new row shows the values entered in the modal | wrap contains "privtest-dvca handle" and "Bar" | text-includes=name=true style=true |
| PASS | [H] style dropdown value persisted in DB and returned by API | handle.style === "Bar" | got={"id":1,"name":"privtest-dvca handle","style":"Bar"} |
| PASS | [F] click + Add opens the modal | modal with #dvie-name appears | clicked=true |
| PASS | [F] modal renders #dvie-name + #dvie-save | modal inputs present | ready=true |
| PASS | [F] Save button is disabled and shows "Saving…" while POST is in flight | #dvie-save.disabled === true && text === "Saving…" | state={"disabled":true,"text":"Saving…"} |
| PASS | [F] no full page reload (window.__pageLoadToken preserved) | __pageLoadToken === "5l8pcerb754" | preserved=true |
| PASS | [F] list at #dv-furniture-wrap grew by ≥1 row after save | row count > 0 | state={"rows":1,"text":"\n      \n        \n          \n            NameDescription\n            \n            \n          \n        \n        \n          \n            \n              privtest-dvca furnitureprivtest-dvca furniture description\n              \n                ▲\n                ▼\n              \n              \n                Edit\n                Delete\n              \n            \n        \n      "} |
| PASS | [F] new row shows the values entered in the modal | wrap contains "privtest-dvca furniture" and "privtest-dvca furniture description" | text-includes=name=true desc=true |
| PASS | [D] click + Add opens the modal | modal with #dvie-name appears | clicked=true |
| PASS | [D] modal renders #dvie-name + #dvie-save | modal inputs present | ready=true |
| PASS | [D] Save button is disabled and shows "Saving…" while POST is in flight | #dvie-save.disabled === true && text === "Saving…" | state={"disabled":true,"text":"Saving…"} |
| PASS | [D] no full page reload (window.__pageLoadToken preserved) | __pageLoadToken === "5l8pcerb754" | preserved=true |
| PASS | [D] list at #dv-door-styles-wrap grew by ≥1 row after save | row count > 0 | state={"rows":1,"text":"\n      \n        \n          \n            NameImage URL\n            \n            \n          \n        \n        \n          \n            \n              privtest-dvca doorhttps://example.invalid/privtest-door.png\n              \n                ▲\n                ▼\n              \n              \n                Edit\n                Delete\n              \n            \n        \n      "} |
| PASS | [D] new row shows the values entered in the modal | wrap contains "privtest-dvca door" and the image URL | text-includes=name=true url=true |

## Coverage

- **(API pre-checks)**: `GET /api/admin/design-visit-handles`,
  `/api/admin/design-visit-furniture-ranges`, and
  `/api/admin/design-visit-door-styles` respond 200 + array for admin.
- **(H/F/D) Add via modal**: for handle, furniture range, and door style:
  - The "+ Add …" button opens the editor modal (`#dvie-name`,
    `#dvie-save` present).
  - With the POST request held open via Puppeteer request interception,
    `#dvie-save.disabled === true` and its label flips to "Saving…"
    (regression guard against the double-save / non-locking bug).
  - After the response is released, the modal closes and the matching
    catalogue wrap (`#dv-handles-wrap` / `#dv-furniture-wrap` /
    `#dv-door-styles-wrap`) gains at least one row whose text contains
    the values entered in the modal — *without a full page reload*
    (`window.__pageLoadToken` is preserved across the save).
- **(H) Style dropdown persistence**: after saving the handle, the
  follow-up `GET /api/admin/design-visit-handles` returns the row with
  `style === "Bar"`, proving the dropdown value reached the database.

## Notes

- Fixtures use the `privtest-dvca` name prefix and are purged in
  `cleanupAndExit()` (including on signal / crash). The harness strips
  `HUBSPOT_TOKEN` / `SMTP_*` / OAuth credentials; the design-visit
  catalogue endpoints are PostgreSQL-only, so no third-party access is
  needed.