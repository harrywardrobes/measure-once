# iOS: share WhatsApp photos into Harry Wardrobes (Shortcut setup)

iPhones and iPads **cannot** add a web app to the share sheet (Safari doesn't
support the Web Share *Target* API). The supported workaround is a one-time
**Shortcut** each staff member installs. It appears in WhatsApp's (and Photos')
share sheet and uploads the selected images straight into your **Photo inbox**
in the app, where you then assign them to a customer.

> **Android users don't need this.** On Android the installed app already shows
> up in the share sheet (via the Web Share Target). See the share_target entry
> in `public/manifest.json`.

---

## 1. Generate your upload token (one-time)

The Shortcut can't sign in to the app, so it authenticates with a personal
**upload token**.

1. In the app, open **Profile** (top-right avatar → Profile).
2. Find **Photo upload token** → tap **Generate token**.
3. **Copy the token now** — it's shown only once. (You can regenerate it any
   time; regenerating invalidates the old one. **Revoke** removes it entirely.)

Keep the token private — anyone with it can upload to *your* inbox. If a device
is lost, **Revoke** then **Generate** a fresh one.

---

## 2. Build the Shortcut (one-time, ~2 minutes)

Open the **Shortcuts** app → **+** (new shortcut) → add these actions in order:

1. **Receive** — tap the shortcut's settings (ⓘ at the bottom) → **Show in Share
   Sheet** → set **Share Sheet Types** to **Images** only.
2. **Get Contents of URL** — add this action and expand **Show More**:
   - **URL:** `https://measure.harrywardrobes.co.uk/api/photo-inbox/upload`
   - **Method:** `POST`
   - **Headers:** add one — key `X-Upload-Token`, value = the token you copied.
   - **Request Body:** `Form`
   - Add a field: tap **Add new field** → **File** → name it **`photos`** →
     value = **Shortcut Input** (the shared images). To send several photos,
     the field must repeat per image — see "Multiple photos" below.
3. (Optional) **Show Notification** — text e.g. "Sent to Harry Wardrobes inbox"
   so you get confirmation.

Name the shortcut something like **"Send to Harry Wardrobes"** and save.

### Multiple photos

`Get Contents of URL` sends one `photos` field per file when its value is a
list of files. If you select several images in WhatsApp and the field value is
**Shortcut Input** (a list), each image is sent as a separate `photos` part —
which is exactly what the endpoint expects (`photos` may repeat up to 15 times).
If your Shortcuts version only sends the first image, add a **Repeat with Each**
over **Shortcut Input** and POST one file per iteration instead.

---

## 3. Use it

1. In **WhatsApp**, open the photo(s) → **Share** (or **Forward → Share**).
2. Choose **Send to Harry Wardrobes** from the share sheet.
3. Open the app → **Home** → **Photo inbox**. Your photos are there.
4. Tap **Assign to customer**, pick the customer, done — the photos now appear
   on that customer's detail page alongside their other photos.

---

## How it works (for maintainers)

- **Endpoint:** `POST /api/photo-inbox/upload` (`customer-info.js`). Auth is the
  `X-Upload-Token` header (this Shortcut) **or** a session cookie (Android PWA /
  in-app). Viewers are rejected.
- **Token:** stored as a SHA-256 hash on `users.upload_token_hash`
  (migration `1786006000000`); one active token per user. Managed via
  `GET/POST/DELETE /api/users/me/upload-token`.
- **Storage:** each upload becomes a `customer_info_submissions` row with
  `contact_id NULL`, `source='staff'`, `is_generic=false` — it shows only in the
  uploader's Photo inbox until assigned (`POST /api/photo-inbox/:id/assign`),
  which sets `contact_id` so it surfaces in `CustomerInfoSubmissionsRail`.
- **Limits:** up to 15 files/request, 15 MB each (same as the customer upload
  flow). Per-IP rate limit shared with the customer photo upload.

See [docs/research/ios-photo-sharing.md](research/ios-photo-sharing.md) for the
original feasibility research and why a native app isn't required.
