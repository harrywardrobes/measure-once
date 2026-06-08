---
name: Offline design-visit per-visit state
description: Gotchas when surfacing queued design-visit writes in the customer-detail list UI
---

# Per-visit offline pending/synced state

The customer-detail design-visit list derives pending/synced badges from the
offline outbox (`useOfflineVisitEntries.ts` → `DesignVisitsList.tsx`), not from
a server field. Non-obvious constraints:

- **Filter queued entries by URL, not just area.** Both design-visit submits and
  arrange-visit outcomes use `area: 'visit'`. Distinguish design-visit writes by
  `url.startsWith('/api/design-visits')`; arrange-visit posts elsewhere.
- **`failed` status does not auto-retry.** The periodic flush + `online` event
  only replay `pending` entries; `failed` (exhausted attempts / terminal 4xx)
  stays parked until manual intervention. UI copy must not promise auto-retry.
- **Refresh on drain, not on success event alone.** When a write confirms (2xx)
  the sync engine dispatches `mo:offline-sync-ok` and removes the outbox entry.
  The list refetches `/api/design-visits` when it detects an entry id
  disappeared between renders, so the real server card replaces the pending one.

**Why:** a visit captured offline has no server row, so it's invisible until it
syncs; field users need to see it's saved-but-not-yet-uploaded without relying on
the global header pill.
