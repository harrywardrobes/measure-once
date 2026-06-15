---
name: design-visit E2E catalog migration fallout
description: How the catalog rename/refactor broke the design-visit E2E test, and a latent server crash it exposed.
---

# design-visit E2E vs catalog refactor

The catalog migration renamed `design_visit_handles`/`door_styles`/`furniture_ranges`
to `catalog_handles`/`catalog_doors`/`catalog_ranges` and dropped the old tables.
The E2E setup (`test/design-visit/run.js`) had two stale couplings that both had to
be fixed for it to run on a fresh isolated DB:

1. **Table refs** — `waitForTable`/cleanup/seeding referenced the dropped
   `design_visit_*` catalog tables; switch them to `catalog_*`.
2. **Endpoint paths** — the test probed `/api/admin/design-visit-handles|door-styles|furniture-ranges`,
   which are now `catalogAdminAlias` **308 redirects** to the canonical
   `/api/admin/catalog/{handles,doors,ranges}`. The harness client uses
   `redirect:'manual'`, so the test saw a 308 and failed.

## Gotcha: 308 aliases silently skip the real handler
Because the old admin catalog paths 308-redirect and the test client does not
follow redirects, any test still hitting the old paths *never exercises the real
catalog CRUD handlers*. This masked a real production crash for a long time.

**Why it matters:** when a test "passes" against an aliased/redirected path, it is
testing the redirect, not the endpoint. Point E2E probes at the canonical path.

## Latent server crash this exposed (now fixed)
`catalogUpdateFields` in `design-visits.js` was written to *mutate* passed-in
`sets`/`vals` arrays and return nothing, but its sole caller (the catalog PATCH
handler) destructured a `{ sets, vals }` return value — and did so *before* the
route's try/catch. So **every** PATCH to `/api/admin/catalog/{handles,doors,ranges,finishes}`
threw `TypeError: Cannot destructure ... undefined` synchronously → unhandled
rejection → whole server process down. Fix: make the function build and return a
fresh `{ sets, vals }`. The caller then prepends `name` and renumbers placeholders.

**Lesson:** a synchronous throw *before* the `try` in an async Express handler is
not caught by the handler's try/catch and can crash the process; guard arg-shape
mismatches at the top of the handler or keep destructuring inside the try.
