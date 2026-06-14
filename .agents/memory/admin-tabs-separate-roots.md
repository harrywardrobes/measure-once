---
name: Admin tabs are separate, non-unmounting React roots
description: Why admin config tabs cannot share a React context, and how to dedupe shared data across them.
---

Each admin tab panel (`#tab-*` in `views/admin.ejs`) is mounted as its **own**
`createRoot` in `src/react/main.tsx`'s `MOUNTS`. `switchTab` in admin.ejs only
toggles a `.active` CSS class and calls `__reactIslandMount`; it never unmounts.
Once a tab is opened (`dataset.dsRendered='1'`) its root persists for the page
lifetime, hidden via CSS.

**Consequence:** a React context/provider cannot be shared across admin tabs.
Wrapping each tab mount in a provider like `WorkflowDataProvider` would create a
**separate provider instance per tab**, and because roots never unmount, opening
several tabs accumulates multiple live instances — multiple SSE connections
(`/api/hubspot/webhook-events`, which has per-user caps), duplicate
`/api/localdata/all` fetches, and board-only stale-data banners surfacing on
config pages. That is a net traffic *increase*, not a reduction.

**How to apply:** to share read-mostly data (e.g. the `/api/workflow`
definition) across admin tabs, use a **module-level cache** (a memoized promise),
not a React provider. See `fetchWorkflowCached()` in `lib/workflowConfig.ts` and
the lightweight `hooks/useWorkflow.ts` — board pages consume the same cache via
`WorkflowDataContext`, so the whole page issues a single fetch. Only the full
board pages (home, customers, customer-detail) — which are single full-page
roots, not tabs — are wrapped in `WorkflowDataProvider`.
