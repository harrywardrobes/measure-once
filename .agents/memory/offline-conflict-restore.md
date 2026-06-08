---
name: Offline conflict restore — read cache & shape mismatch
description: How "Restore server copy" reconciles the IndexedDB read cache, and the design-visit write/read key mismatch that limits per-field restore.
---

# Offline conflict restore

`resolveConflict` (src/react/lib/offlineQueue.ts) reconciles the structured
read cache after a "Restore server copy":
- **Online** (sendOrQueue res.ok): evict the cached record so the page re-fetch
  repopulates from the server.
- **Offline** (res.queued): the device can't re-fetch, so write the restored
  values into the read cache (`updateCachedRecord`) and dispatch
  `mo:offline-conflict-resolved`; the page's re-fetch hits its offline fallback
  (readRecord/readRecords) and shows the restored state.

The offline patch only includes keys present in `conflict.serverData` (the
read-shaped GET snapshot), so write-only payload keys are skipped.

## Restore replay never last-write-wins (abortOnConflict)
A queued "Restore server copy" write carries `abortOnConflict: true` plus the
conflict-check inputs (`conflictCheckUrl`/`baseVersion`/`baseUpdatedAt`, set
only when a base exists). At replay, `processEntry` re-reads the live record and
if the server advanced past the snapshot being restored it records a fresh
`flagged` conflict and **drops** the entry (`removeEntry`) — it does NOT fall
through to the write. This mirrors the online re-check in `resolveConflict`.
**Why:** the sync engine's default for a detected conflict is
last-write-wins-with-warning; a restore must never silently clobber a newer
server change just because it was queued offline.
**Scope decision:** this abort applies to **restores only**. Normal queued edits
keep last-write-wins (the established contract) — broadening it to all writes
would change that contract and needs explicit user sign-off.

## Key gotcha: write body vs read shape
**Why:** Per-field conflict diff/restore matches by key name. It only works when
the queued write body uses the same field names as the server read shape.
- **Visit edits** (GenericVisitEditModal) — body keys (`title`, `startAt`,
  `endAt`, `location`, `notes`, …) match the `Visit` read shape → restore works.
- **Design-visit edits** (DesignVisitWizard) — body is camelCase
  (`visitDate`, `durationMin`, `handlerConfig`, `rooms[].roomName`) while the
  read shape is snake_case (`visit_date`, `room_name`, …). Keys don't line up,
  so `buildFieldDiff`/`buildRestoreBody` misfire (restore to null) and the
  offline cache patch skips them. Needs a name mapping before diff/restore.

**How to apply:** Any new offline-syncable write that wants accurate conflict
diff/restore must send a body whose keys match the record's GET read shape (or
add normalisation on both sides before comparing).
