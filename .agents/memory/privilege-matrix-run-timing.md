---
name: privilege matrix run timing
description: Why test:privileges(:ci) appears to "time out" and which output line actually confirms your new route rows pass.
---

The privilege test (`test/privileges/run.js`) runs in phases: an API-route
audit, the capability matrix, adversarial probes, then a **headless puppeteer
UI smoke**. The full run regularly exceeds a 120s shell cap — almost always
because of the puppeteer phase at the end, NOT a failure.

**The line that matters for route/middleware authorization changes is:**
`matrix: NNNN/NNNN ok (0 inconclusive — see report)` plus
`API-route audit: N /api/* route(s) all covered by the matrix.`
If the matrix reaches `1325/1325 ok` (or whatever the current total is) and the
route-audit count matches, your added matrix rows pass — even if the command is
later killed by the timeout during the puppeteer smoke.

**Why:** when adding rows for a new router (e.g. mirroring design-visits with
survey-visits in `test/privileges/matrix.js`), the relevant gate is the matrix
phase, which completes well before the slow UI smoke.

**How to apply:** run with output redirected to a file
(`npm run test:privileges:ci > /tmp/x.log 2>&1`) and inspect the matrix line;
don't treat the 124/timeout exit as a matrix failure. The shared-DB variant
(`PRIVTEST_ALLOW_SHARED_DB=1 npm run test:privileges`) can also flake with an
ECONNREFUSED mid-run as the shared server drops — prefer the isolated `:ci`
variant for a clean matrix result.
