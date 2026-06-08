---
name: Offline Phase 2 bundle constraints
description: How the offline write-queue/sync code is kept out of the always-loaded main.js bundle.
---

# Offline Phase 2 — keeping the queue out of main.js

The always-loaded `main.js` gzip gate (`scripts/check-bundle-sizes.mjs`) sits
right at its limit — a previous PASS was ~38.8 kB against a 40 kB cap, so even a
~1.5 kB always-loaded UI addition fails the gate.

**Rule:** anything that pulls in `idb`/`offlineDb`/`offlineQueue`/`syncEngine`
must be reached via dynamic `import()` or `React.lazy`, never a static import
from a module that lands in `main.js`.

**Why:** `GlobalHeader` is in the main bundle. Statically importing the
pending-sync indicator (which uses the `useOfflineQueue` hook + MUI icons) tipped
main.js over the 40 kB cap. Fix was to split the indicator into its own
`src/react/components/SyncPill.tsx` and `React.lazy(() => import('./SyncPill'))`
it inside a `<Suspense fallback={null}>`. The hook itself dynamic-imports the
queue so `idb` stays lazy.

**How to apply:** when adding offline-aware UI to a main-bundle component, lazy
the leaf component; from lazy page/modal chunks a static or `await import()` is
fine. After any such change run `npm run build:react` and confirm main.js is
under its limit in the bundle table.
