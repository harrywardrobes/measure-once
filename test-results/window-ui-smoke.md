# window.UI — Smoke Test

- Date: 2026-05-25T08:17:29.668Z
- Command: `npm run test:window-ui-smoke`

## Summary

- Passed: 10 / 11
- Failed: 1 / 11

## Results

| Result | Probe | Expected | Observed |
|---|---|---|---|
| PASS | / — window.UI defined with required helpers | object with skeletonLine, renderPill, renderEmptyState, renderTabBar | present |
| PASS | /customers — window.UI defined with required helpers | object with skeletonLine, renderPill, renderEmptyState, renderTabBar | present |
| PASS | /sales — window.UI defined with required helpers | object with skeletonLine, renderPill, renderEmptyState, renderTabBar | present |
| PASS | /survey — window.UI defined with required helpers | object with skeletonLine, renderPill, renderEmptyState, renderTabBar | present |
| PASS | /projects — window.UI defined with required helpers | object with skeletonLine, renderPill, renderEmptyState, renderTabBar | present |
| PASS | /calendar — window.UI defined with required helpers | object with skeletonLine, renderPill, renderEmptyState, renderTabBar | present |
| PASS | /invoices — window.UI defined with required helpers | object with skeletonLine, renderPill, renderEmptyState, renderTabBar | present |
| PASS | /trades — window.UI defined with required helpers | object with skeletonLine, renderPill, renderEmptyState, renderTabBar | present |
| PASS | /ideas — window.UI defined with required helpers | object with skeletonLine, renderPill, renderEmptyState, renderTabBar | present |
| PASS | /admin — window.UI defined with required helpers | object with skeletonLine, renderPill, renderEmptyState, renderTabBar | present |
| FAIL | /profile — window.UI defined with required helpers | object with skeletonLine, renderPill, renderEmptyState, renderTabBar | {"typeofUI":"undefined"} |

## Coverage

Visits each dashboard route below with an admin session and asserts that
`window.UI` is an object and that `skeletonLine`, `renderPill`,
`renderEmptyState`, and `renderTabBar` are all functions:

- `/`
- `/customers`
- `/sales`
- `/survey`
- `/projects`
- `/calendar`
- `/invoices`
- `/trades`
- `/ideas`
- `/admin`
- `/profile`

## Relevant files

- `public/components.js` — defines `window.UI`
- `public/chrome.js` — shared chrome included before `components.js`
- Each dashboard HTML page in `public/` includes both via explicit
  `<script>` tags; this smoke catches a missing tag on any of them.