---
name: Bundle-size gate & idb
description: Why offlineDb/idb must be dynamically imported, not statically pulled into main.js
---
`scripts/check-bundle-sizes.mjs` enforces a per-chunk gzip threshold on the
always-loaded `public/react/main.js` (~40kB) and fails the build when exceeded.

**Rule:** Anything imported (transitively) by `src/react/main.tsx` lands in the
always-loaded bundle. `idb` is ~2kB gzip on its own and tipped main.js over the
gate. Keep `offlineDb.ts` (and its `idb` dep) out of main by importing it only
from lazy page chunks, or via dynamic `import('./offlineDb')` where a
top-level-reachable module (e.g. registerServiceWorker's logout cleanup) needs it.

**Why:** A static `import { clearOfflineDb } from './offlineDb'` in a module that
main.tsx loads eagerly pulls all of idb into main.js and breaks the size gate.
The write-through call sites (CustomerDetailPage, usePaginatedContacts,
ReviewCustomerPhotosDrawer) are already lazy chunks, so static imports there are fine.

**How to apply:** When adding a dependency reachable from main.tsx, run
`npm run build:react` and watch the "always-loaded" total + per-chunk spike
warning. If a dep is only needed on a rare path (logout, error handler), reach it
through `await import(...)` so it splits into its own chunk.
