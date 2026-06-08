# Manual Test: Conflict Review UI — Server-Changed Rooms

**Purpose:** Verify the full end-to-end conflict resolution flow when the server
changes which rooms exist on a design visit while an offline edit is queued.

**Scope:** This scenario exercises the path from queued offline edit →
server-side room set change → conflict detected → conflict review UI diff →
user per-room resolution → cache patch applied → page re-renders with the
correct rooms.

---

## Room-toggle index semantics (ID-based pairing)

The conflict review UI pairs rooms by **ID** (not by array position). This
means:

- Each offline-edited room appears in the diff matched with the server's room
  sharing the same `id`, regardless of where either sits in the array.
- Rooms the server **added** (absent from the offline edit) appear *after* all
  the offline-edited rooms in the diff list, labelled "Only on server".
- Rooms the user **added offline** (absent on the server) appear in their
  normal position, labelled "Added in your edit".

Example — server added room id:99 while user had rooms [id:1, id:2]:

| Diff index | Your edit | Server copy | Status |
|---|---|---|---|
| 0 | Room 1 (id:1) | Room 1 (id:1) | No changes |
| 1 | Room 2 (id:2) | Room 2 (id:2) | No changes |
| 2 | *(none)* | Room id:99 | Only on server |

To **accept** the server-added room, the user flips the toggle at **index 2**
to "Restore room". To **ignore** it (keep only their own rooms), no action is
needed (default is "Keep mine", which drops the absent-from-edit room).

---

## Prerequisites

- A test account with **manager or admin** privilege (design visits require it).
- A design visit in **submitted** or **revision requested** state with at least
  two rooms, each having a distinct `id`.
- Browser DevTools available (to toggle offline mode).
- The app is loaded and the service worker is active (check DevTools →
  Application → Service Workers; status should be "activated and is running").

---

## Scenario A — Server Added a Room

### Setup

1. Open the design visit detail page for a visit that has exactly **two rooms**
   (e.g. "Kitchen" (id:1) and "Bathroom" (id:2)).
2. Note the current room names and any editable fields (visit date, duration).

### Steps

**Step 1 — Go offline**

3. In DevTools → Network, set the throttle to **Offline**.
4. Confirm the "Offline" pill appears in the app header.

**Step 2 — Make an edit while offline**

5. Edit the **visit date** field on the design visit (any small change).
6. Save/submit the edit.
7. Confirm the pending-sync pill appears in the header (e.g. "1 pending").
8. The local page should reflect your edited visit date immediately.

**Expected (offline state):**
- Visit date shows your edited value.
- Sync pill shows 1 pending write.
- No "Conflicts" pill yet.

**Step 3 — Server adds a room while you are offline**

9. In a **second browser tab** (or via the API), add a third room to the same
   design visit (e.g. a "Utility" room, id:99). Use an admin session that is
   still online.
   - API: `PATCH /api/design-visits/<id>` with
     `{ rooms: [...existingRooms, { roomName: "Utility", ... }] }`
10. Confirm in the second tab that the visit now shows three rooms.

**Step 4 — Come back online**

11. In the first tab (offline tab), restore the network: DevTools → Network →
    set throttle back to **No throttling**.
12. The sync engine replays the queued edit. Since the server now has a
    different room set, a conflict is detected.

**Expected (after sync):**
- The "Offline" pill disappears.
- The pending-sync pill disappears (edit replayed).
- A **"Conflicts"** pill appears in the header (orange/red).

**Step 5 — Open the conflict review UI**

13. Click the **Conflicts** pill in the header. The conflict review dialog opens.
14. Locate the conflict card for your design visit.

**Expected (conflict card):**
- The card is labelled with the design visit's name.
- An explanation reads something like: *"Your queued edit was applied but the
  server record had changed. Review the fields below to confirm or restore."*
- The **"Compare fields"** toggle is visible (shows the number of changed fields
  in parentheses).

**Step 6 — Inspect the rooms diff**

15. Click **"Compare fields"** to expand the field-level diff.
16. Scroll to the **Rooms** section.

**Expected (rooms diff — server added room):**
- **Room 1 (Kitchen):** status chip "No changes" — no individual toggle.
- **Room 2 (Bathroom):** status chip "No changes" — no individual toggle.
- **Room 3 (Utility):** status chip "Only on server" — a per-room toggle shows
  **"Keep mine" / "Restore room"** (default: "Keep mine" drops it).
- A bulk bar reads "1 room changed" with "Keep all mine" / "Use server for all"
  buttons.

**Step 7a — Resolve: keep your edit (drop the server-added room)**

17. Click **"Keep my edit"** (the plain-text button at the bottom of the card),
    or leave all toggles at "Keep mine" and click "Restore selected".

**Expected:**
- Conflict card disappears.
- Conflicts pill disappears (no more conflicts).
- Design visit page shows **two rooms** (Kitchen + Bathroom) — the
  server-added Utility room is not present because it was absent from the
  queued edit.

**Step 7b — Alternative: resolve by accepting the new room**

> Restart from Step 5 if you already completed 7a.

17. In the Rooms diff, flip the **Room 3 (Utility)** toggle to **"Restore room"**.
18. Click **"Restore selected"**.

**Expected:**
- Conflict card disappears.
- Design visit page now shows **three rooms** (Kitchen, Bathroom, Utility).
- The Utility room shows the server's data (door style name, dimensions, etc.).

---

## Scenario B — Server Removed a Room

### Setup

Same as Scenario A setup (design visit with two rooms: Kitchen id:1, Bathroom id:2).

### Steps

**Steps 1–2:** Same — go offline, edit the visit date.

**Step 3 — Server removes a room while you are offline**

9. In the second tab, remove the second room (Bathroom id:2) from the design
   visit: `PATCH /api/design-visits/<id>` with `{ rooms: [<kitchenRoomOnly>] }`.
10. Confirm the visit now shows one room.

**Steps 4–5:** Same — come back online, open the Conflicts dialog.

**Step 6 — Inspect the rooms diff**

**Expected (rooms diff — server removed room):**
- **Room 1 (Kitchen):** status chip "No changes" — no toggle.
- **Room 2 (Bathroom):** status chip "Added in your edit" (present in your
  offline edit, absent on the server) — per-room toggle shows
  **"Keep added" / "Drop room"** (default: "Keep added" retains it).

**Step 7a — Accept server deletion (drop Bathroom)**

17. Flip Room 2's toggle to **"Drop room"**.
18. Click **"Restore selected"**.

**Expected:**
- Conflict dismissed.
- Design visit page shows **one room** (Kitchen only). Bathroom is gone.

**Step 7b — Override server deletion (keep Bathroom)**

17. Click **"Keep my edit"** without flipping any room toggles.

**Expected:**
- Conflict dismissed.
- Design visit page still shows **two rooms** (Kitchen + Bathroom). Your
  offline-queued rooms are preserved.

---

## Cache-Patch Verification

After any resolution, verify the page update is immediate and correct
**without a manual reload**:

- If the device was online when resolving: the cache entry is evicted and
  the next navigation re-fetches from the server.
- If the device was offline when resolving: the read cache is patched
  immediately (`buildRestoredCachePatch` → `updateCachedRecord`). Navigate
  away and back to the design visit — the rooms count should still match
  the resolved state (no flicker back to the pre-resolution value).

---

## Automated Unit Coverage

The pure logic functions that drive this flow are covered by
`src/react/components/ConflictsReview.test.ts` (19 tests, run via
`npm run test:conflicts-review-logic`):

| Tested function    | What it covers |
|--------------------|----------------|
| `buildFieldDiff`   | Rooms marked changed when server added/removed/replaced a room; `serverRaw` preserves server-only fields (`door_style_name`); noise keys dropped; envelope unwrapping; scalar field changed/unchanged detection. |
| `buildRestoreBody` | "Keep mine" path (user rooms preserved, server-added room dropped); "Accept server room" path via the correct diff index (index = position in the id-based diff, not array position); room drop when server counterpart is null; non-room fields preserved verbatim. |

`buildRestoredCachePatch` (the cache-patch step) is covered by
`src/react/lib/offlineQueue.test.ts` with all room add/remove/reorder/replace
variants.
