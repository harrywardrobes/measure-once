---
name: Offline design-visit photo capture
description: Why offline room photos travel as inline data URIs and are materialised server-side on replay.
---

# Offline design-visit room photos

When offline (or on a network-level upload failure), the design-visit rooms
step keeps a captured photo as an inline `data:image/*;base64,…` URI on the
room image instead of going through the normal two-step upload
(`POST /api/design-visits/uploads` → opaque key → submit-with-keys). The data
URI rides along in the **queued** submit payload; on reconnect the server
materialises it into real object storage, with a fallback to persisting the
inline data URI if storage is unavailable.

**Why this approach (not queuing the upload endpoint):** the two-step upload is
inherently online-coupled — step 2 needs step 1's server-minted key. Embedding
the bytes in the submit makes the whole design-visit write a single queued unit,
so one replay reconstructs everything. The server already accepted inline
`data:` URIs as a legacy path, and the member-ownership check only validates
*opaque* keys, so inline data URIs pass without extra auth plumbing.

**How to apply / gotchas:**
- Only fall back to inline for offline / network-level failures. Genuine server
  rejections (HTTP ≥ 400) must surface as errors — they would fail again on
  replay, so queueing them inline just hides a doomed photo.
- Never register an inline data URI for orphan-upload cleanup (the cleanup hook
  is keyed on opaque storage keys only).
- `express.json` limit is 25mb; a submit with several base64 photos can approach
  it. Per-image cap is 10MB (string length) on the server.
- Customer-info uploads and the "send photos" email link stay online-only (token
  + live Gmail session needed).

**Bundle note:** `DesignVisitWizard` (and thus the rooms step) is statically
imported via `CardActionModalsHost`, so it lives in always-loaded `main.js`. The
inline-fallback logic added ~131 bytes gzip and tipped the 40 kB gate, so it was
raised to 41 kB. Don't lazy-load the wizard to reclaim space — it must work
offline, and a not-yet-cached lazy chunk would break offline use.
