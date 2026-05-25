# New Customer Counts Retry — Integration Test

- Run ID: `072uz0`
- Date: 2026-05-25T18:47:30.059Z
- Command: `npm run test:new-customer-counts-retry`

## Summary

- Passed: 4 / 4
- Failed: 0 / 4

## Results

| Result | Probe | Expected | Observed |
|---|---|---|---|
| PASS | [D] all retries fail — Snackbar "Couldn't refresh live data…" appears | Snackbar visible after all retries | snackbar=visible |
| PASS | [E] second attempt succeeds — Snackbar does NOT appear | Snackbar absent after successful retry | snackbar=never appeared (good) |
| PASS | [F] Snackbar auto-dismisses after autoHideDuration (8 s) | Snackbar appears then auto-dismisses | snackbar=appeared then dismissed (good) |
| PASS | [G] Snackbar survives tab-hide — still auto-dismisses when tab returns visible | Snackbar appears, stays visible while hidden (>8 s), then dismisses on tab-show | visible_while_hidden=yes — timer paused (good), final=dismissed after tab-show (good) |

## Coverage

- **[D] All retries fail**: after `NewCustomerDialog.onCreated` fires,
  `loadLeadStatusCounts` is called immediately and twice more (3 total,
  `MAX_CREATED_RETRIES=2`).  When every attempt returns HTTP 502 the
  `bgRefreshFailed` Snackbar ("Couldn't refresh live data…") must appear.
  Large `setTimeout` delays (30 s) are collapsed to 10 ms via
  `evaluateOnNewDocument`; `/api/contacts-lead-status-counts` is
  intercepted at the Puppeteer layer and always returns 502.
- **[E] Second attempt succeeds**: first `onCreated` counts call returns
  502, the retry (second call) returns 200.  The Snackbar must NOT appear.
- **[F] Snackbar auto-dismisses**: same always-fail scenario as [D];
  after the Snackbar appears the test waits for it to disappear.  The
  `autoHideDuration={8000}` on the MUI Snackbar uses `setTimeout`
  internally, which the fast-timer override collapses to ~10 ms.  The
  Snackbar must be gone from the DOM within 5 s of appearing.
- **[G] Snackbar survives tab-hide**: all counts calls fail so the Snackbar
  appears.  Both `document.visibilityState` and `document.hidden` are
  overridden and a `visibilitychange` event is dispatched — simulating the
  user switching away from the tab.  MUI Snackbar clears its
  `autoHideDuration` timer in response.  The test waits **9.5 s** while
  the document is hidden — longer than the 8 s `autoHideDuration`.  If
  the pause logic were absent the timer would have fired during this
  window; a Snackbar that is still visible at 9.5 s proves the timer was
  paused.  The document is then restored to `'visible'`; MUI restarts the
  full 8 s `autoHideDuration` and the Snackbar must dismiss within 12 s.
  Fast-timers use `thresholdMs=10000` so the 30 s retry gaps collapse to
  10 ms while the 8 s `autoHideDuration` stays at its real value —
  making the 9.5 s hidden-wait a discriminating (not vacuous) assertion.