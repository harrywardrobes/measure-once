# React Admin Tabs — Smoke Test

- Run ID: `pczivr`
- Date: 2026-05-25T14:25:47.105Z
- Command: `npm run test:react-admin-tabs`

## Summary

- Passed: 7 / 8
- Failed: 1 / 8

## Results

| Result | Probe | Expected | Observed |
|---|---|---|---|
| PASS | GET /react/main.js serves the built bundle | status=200 with non-empty body | status=200 length=523037 |
| PASS | #tab-search mount point exists in admin.html | element with id="tab-search" present | present=true |
| PASS | React island flags #tab-search as mounted (data-ds-rendered="1") | data-ds-rendered="1" on #tab-search | flagged=true |
| PASS | #tab-search renders SearchSettingsPage rows (.ss-action-row) | at least one .ss-action-row inside #tab-search | appeared=true rowCount=15 |
| PASS | #tab-designsystem mount point exists in admin.html | element with id="tab-designsystem" present | present=true |
| PASS | React island flags #tab-designsystem as mounted (data-ds-rendered="1") | data-ds-rendered="1" on #tab-designsystem | flagged=true |
| FAIL | #tab-designsystem renders DesignSystemPage sections (.ds-section) | at least one .ds-section inside #tab-designsystem | appeared=false sectionCount=0 |
| PASS | no uncaught page errors while React island mounts | 0 pageerror / console.error events | count=0 |

## Coverage

- **(static)** Confirms Express serves the built `/react/main.js` bundle.
- **(Search tab)** Asserts `#tab-search` exists, is flagged by
  `src/react/main.tsx` with `data-ds-rendered="1"`, and contains at
  least one `.ss-action-row` rendered by `<SearchSettingsPage/>`.
- **(Design System tab)** Asserts `#tab-designsystem` exists, is
  flagged the same way, and contains at least one `.ds-section`
  rendered by `<DesignSystemPage/>`.
- **(runtime errors)** Asserts the React mount produced no `pageerror`
  or `console.error` events.

## Notes

- Requires `public/react/main.js` to exist; the test pre-flights for it
  and refuses to run otherwise. Run `npm run build:react` first.
- The test server strips `HUBSPOT_TOKEN`, but the React island does not
  depend on HubSpot for either panel, so both tabs render normally.