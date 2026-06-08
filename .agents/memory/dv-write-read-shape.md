---
name: Design-visit write vs read field-name mismatch
description: Why offline conflict diff/restore/cache-patch needs camelCase↔snake_case normalisation for design visits only.
---
Design-visit *edits* (DesignVisitWizard PUT/POST body) use camelCase field names
(`visitDate`, `durationMin`, `handleId`, `furnitureRangeId`, `handlerConfig`,
`rooms[].roomName`, `widthMm`, …). The server *read* (`GET /api/design-visits/:id`,
returned raw — no envelope) uses snake_case (`visit_date`, `duration_min`,
`rooms[].room_name`, …) — except room **image** sub-objects, which the server
already returns camelCase (`{storageKey, mimeType, viewUrl}`). Customer and
calendar-visit edits are unaffected: their write and read names already match.

**Rule:** any code that compares or copies a queued edit body against the server
snapshot keyed by field name must normalise the two shapes first. Match each
write-shape key against its `toSnakeKey` counterpart; project/reshape nested
values (the `rooms` array) so server-only metadata (`id`, `door_style_name`,
`sort_order`) doesn't read as "changed" and a restore writes a body the endpoint
accepts.

**Why:** matching purely by key name made every design-visit field look
overwritten and restored fields to `null`, and the offline read-cache patch
skipped them entirely (camel keys never matched the snake cached record).

**How to apply:** the PUT/POST handler accepts *both* cases for room fields
(`rm.roomName || rm.room_name`), so a camelCase restore body is safe. The
offline read cache for design visits is the snake_case list shape
(`DesignVisit` type, store `visits`, id `dv:<id>`), so a cache patch must be
snake_case. See `buildFieldDiff`/`buildRestoreBody` (ConflictsReview.tsx) and
`buildRestoredCachePatch` (offlineQueue.ts).
