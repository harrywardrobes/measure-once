# start_design_visit — Detailed Reference

## DB Schema (6 Tables)

### 1. `design_visit_handles` — Handle catalogue (admin-managed)

```sql
CREATE TABLE IF NOT EXISTS design_visit_handles (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  image_url   TEXT,
  sort_order  INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 2. `design_visit_furniture_ranges` — Furniture range catalogue

```sql
CREATE TABLE IF NOT EXISTS design_visit_furniture_ranges (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  sort_order  INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 3. `design_visit_door_styles` — Door style catalogue

```sql
CREATE TABLE IF NOT EXISTS design_visit_door_styles (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  image_url   TEXT,
  sort_order  INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4. `design_visits` — Master visit record

```sql
CREATE TABLE IF NOT EXISTS design_visits (
  id                   SERIAL PRIMARY KEY,
  contact_id           TEXT NOT NULL,            -- HubSpot contact ID
  contact_name         TEXT,
  contact_email        TEXT,
  created_by           TEXT NOT NULL,            -- users.email of submitter
  handle_id            INT  REFERENCES design_visit_handles(id) ON DELETE SET NULL,
  furniture_range_id   INT  REFERENCES design_visit_furniture_ranges(id) ON DELETE SET NULL,
  visit_date           TIMESTAMPTZ,
  duration_min         INT  NOT NULL DEFAULT 90,
  location             TEXT,
  notes                TEXT,
  terms_accepted       BOOLEAN NOT NULL DEFAULT FALSE,
  status               TEXT NOT NULL DEFAULT 'draft',
    -- 'draft' | 'submitted' | 'revision_requested' | 'signed_off'
  qb_estimate_id       TEXT,                     -- QuickBooks Estimate.Id
  qb_estimate_doc_num  TEXT,
  signoff_token_hash   TEXT,                     -- SHA-256 of the single-use token
  signoff_expires_at   TIMESTAMPTZ,
  signed_off_at        TIMESTAMPTZ,
  revision_note        TEXT,                     -- customer's revision request text
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS design_visits_contact_id_idx ON design_visits (contact_id);
CREATE INDEX IF NOT EXISTS design_visits_status_idx ON design_visits (status);
```

### 5. `design_visit_rooms` — Per-room breakdown

```sql
CREATE TABLE IF NOT EXISTS design_visit_rooms (
  id               SERIAL PRIMARY KEY,
  design_visit_id  INT NOT NULL REFERENCES design_visits(id) ON DELETE CASCADE,
  room_name        TEXT NOT NULL,               -- e.g. "Kitchen", "Master Bedroom"
  door_style_id    INT REFERENCES design_visit_door_styles(id) ON DELETE SET NULL,
  width_mm         INT,
  height_mm        INT,
  depth_mm         INT,
  unit_count       INT NOT NULL DEFAULT 1,
  unit_price_pence INT NOT NULL DEFAULT 0,      -- pence to avoid float rounding
  notes            TEXT,
  sort_order       INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS design_visit_rooms_visit_id_idx ON design_visit_rooms (design_visit_id);
```

### 6. `design_visit_room_images` — Photos per room

```sql
CREATE TABLE IF NOT EXISTS design_visit_room_images (
  id          SERIAL PRIMARY KEY,
  room_id     INT  NOT NULL REFERENCES design_visit_rooms(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,    -- relative path within static/upload storage
  mime_type   TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dvri_room_id_idx ON design_visit_room_images (room_id);
```

---

## QuickBooks Estimate JSON Shape

Sent to `POST /v3/company/{realmId}/estimate` via the QuickBooks v3 API (minorversion 65).

```json
{
  "TxnDate": "2026-05-24",
  "CustomerRef": {
    "value": "<qb_customer_id>"
  },
  "BillEmail": {
    "Address": "<contact_email>"
  },
  "CustomerMemo": {
    "value": "Design visit — <contact_name>\nHandle: <handle_name>\nFurniture range: <range_name>"
  },
  "Line": [
    {
      "DetailType": "SalesItemLineDetail",
      "Amount": 1250.00,
      "Description": "Kitchen — Shaker White (2400mm × 2100mm, 8 units)",
      "SalesItemLineDetail": {
        "ItemRef": { "value": "1", "name": "Design & Fit" },
        "Qty": 8,
        "UnitPrice": 156.25
      }
    }
    // one Line per design_visit_rooms row
  ],
  "ExpirationDate": "<visit_date + 30 days>"
}
```

**Notes:**
- Store the returned `Estimate.Id` in `design_visits.qb_estimate_id` and `Estimate.DocNumber` in `design_visits.qb_estimate_doc_num`.
- Use the shared QB token helpers from `quickbooks.js` (`getValidTokens`, `qbBase`).
- Wrap in try/catch: a QB failure should not roll back the visit record — log the error and set `qb_estimate_id = NULL`.

---

## Customer Confirmation Email

Sent immediately after `POST /api/design-visits` succeeds (status becomes `submitted`).

**Subject:** `Your design visit — [Contact Name]`

**From:** same `buildFromHeader()` / `buildReplyTo()` helpers used in `auth.js`

**HTML structure:**

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;color:#1f2937;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="font-size:1.4rem;margin-bottom:4px;">Your design visit summary</h1>
  <p style="color:#6b7280;margin-top:0;">Hi [First Name],</p>

  <p>Thank you for your time today. Here's a summary of the design options we discussed.</p>

  <table style="width:100%;border-collapse:collapse;margin:20px 0;">
    <thead>
      <tr style="background:#f3f4f6;">
        <th style="text-align:left;padding:8px 12px;font-size:.85rem;">Room</th>
        <th style="text-align:left;padding:8px 12px;font-size:.85rem;">Style</th>
        <th style="text-align:right;padding:8px 12px;font-size:.85rem;">Total</th>
      </tr>
    </thead>
    <tbody>
      <!-- one row per design_visit_rooms -->
      <tr>
        <td style="padding:8px 12px;border-top:1px solid #e5e7eb;">[Room Name]</td>
        <td style="padding:8px 12px;border-top:1px solid #e5e7eb;">[Door Style]</td>
        <td style="padding:8px 12px;border-top:1px solid #e5e7eb;text-align:right;">£[total]</td>
      </tr>
    </tbody>
    <tfoot>
      <tr>
        <td colspan="2" style="padding:8px 12px;font-weight:600;">Estimate total</td>
        <td style="padding:8px 12px;font-weight:600;text-align:right;">£[grand_total]</td>
      </tr>
    </tfoot>
  </table>

  <!-- CTA button -->
  <div style="text-align:center;margin:28px 0;">
    <a href="[sign_off_url]"
       style="display:inline-block;background:#8B2BFF;color:#fff;padding:14px 32px;
              border-radius:8px;text-decoration:none;font-weight:600;font-size:1rem;">
      See Your Design &amp; Sign Off
    </a>
  </div>

  <p style="font-size:.82rem;color:#6b7280;">
    This link is personal to you and expires in 7 days.
    If you have questions, reply to this email.
  </p>

  <!-- T&C block -->
  <details style="margin-top:24px;font-size:.78rem;color:#6b7280;">
    <summary style="cursor:pointer;font-weight:600;">Terms &amp; Conditions</summary>
    <div style="margin-top:8px;white-space:pre-line;">[terms_and_conditions text]</div>
  </details>
</body>
</html>
```

**Plain-text fallback:** Include all room line items, the estimate total, the sign-off URL, and the T&C text separated by dashes.

**Sign-off URL format:** `[APP_URL]/design-visit/sign-off?token=[raw_token]`

The raw token is a 32-byte `crypto.randomBytes(32).toString('hex')`. Store only the SHA-256 hash (`crypto.createHash('sha256').update(token).digest('hex')`) in `design_visits.signoff_token_hash`. Expiry: `NOW() + INTERVAL '7 days'`.

---

## Internal Team Notification Email

Sent concurrently with the customer email (or immediately after).

**Subject:** `Design visit submitted — [Contact Name]`

**To:** `ADMIN_EMAILS` (comma-separated)

**Body (HTML):**
- Who submitted it (user name + email)
- Contact name + HubSpot contact link
- Visit date/time and location
- Handle and furniture range selected
- Room breakdown table (same as customer email, without price column if desired)
- Link to the design visit detail page in the dashboard: `[APP_URL]/design-visits/[id]`

---

## Public Sign-Off Page (`public/design-visit-signoff.html`)

Served at `/design-visit/sign-off` (static HTML, no auth required).

On load:
1. Extract `?token=` from URL
2. `GET /api/design-visits/sign-off/:token` → returns visit summary JSON
3. Render room breakdown, handle/range name, T&C block
4. Two buttons: **"Looks great — sign off"** and **"Request changes"**
5. "Sign off" → `POST /api/design-visits/sign-off/:token` with `{ action: 'approve' }` → flips status to `signed_off`, invalidates token, shows thank-you message
6. "Request changes" → shows text area → `POST` with `{ action: 'revision', note: '…' }` → flips status to `revision_requested`, notifies team

**Security:** The public route must look up by token hash only, check `signoff_expires_at > NOW()`, check token not already used (status not `signed_off`), and return 404 for any miss to avoid oracle attacks.

---

## BroadcastChannel Events for `start_design_visit`

| Channel | Fired from | Listeners |
|---|---|---|
| `design_visit_handles_changed` | Admin handle CRUD | Wizard modal refreshes handle list |
| `design_visit_furniture_ranges_changed` | Admin range CRUD | Wizard modal refreshes range list |
| `design_visit_door_styles_changed` | Admin style CRUD | Wizard modal refreshes style list |
| `card_action_handlers_changed` | Handler CRUD (existing) | All card pages reload handler index |
