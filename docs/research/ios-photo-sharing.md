# Getting WhatsApp photos into Harry Wardrobes — iOS & Android options

**Question (from the task batch):** "If I get a WhatsApp message with some photos, I
should be able to share the photos with the application. Is this possible without
being an iOS app?" Plus an in-app "Add photos" button on Home and the Customers
page, assigning the photos to a customer.

**Status:** research only — no photo-upload code was shipped in this batch. This
document records what is feasible and recommends a build order. It pairs with the
follow-up task *"direct staff photo upload to a contact"* (no upload-to-contact
endpoint exists yet — the app currently only sends the **customer** a link to
upload their own photos).

---

## TL;DR

- **Android:** yes — an installed PWA can appear in WhatsApp's share sheet via a
  Web App Manifest `share_target`. Shared photos POST straight to our endpoint.
- **iOS (iPhone/iPad):** **no** — Safari does **not** support the Web Share
  *Target* API, so a web app can never appear as a share destination. The
  practical workaround is a one-time **iOS Shortcut** that staff install; it
  shows up in the WhatsApp share sheet and POSTs the photos to our endpoint.
- **Everywhere:** an in-app **"Add photos"** button (pick a customer → upload)
  works identically on every device and needs no OS integration. This is the
  reliable baseline and should be built first.

All three paths need the **same foundation**: an authenticated endpoint that
accepts image files and associates them with a contact. Build that once.

---

## Findings

### 1. Web Share Target API (receive a share into the app)
- Requires the app to be an **installed PWA** with a `share_target` entry in the
  Web App Manifest. The OS then lists the app in other apps' share sheets and
  delivers the shared files to a URL we specify (typically a `POST` with
  `multipart/form-data`).
- **Android / Chromium:** supported. This is the clean "share from WhatsApp"
  experience the task describes.
- **iOS / Safari:** **not supported.** WebKit bug
  [194593 — "Add support for Web Share Target API"](https://bugs.webkit.org/show_bug.cgi?id=194593)
  has been open for years and is still unimplemented in 2026. Apple supports the
  Web Share API (*sending* from the app) but not *receiving* a share. So on
  iPhone there is no way to make our web app appear in WhatsApp's share sheet.

### 2. iOS Shortcuts (the iOS workaround)
- The **Shortcuts** app can publish a custom action into the iOS share sheet.
  A shortcut can "Receive images from the Share Sheet", then use
  *Get Contents of URL* with method `POST` and a **File** request body to upload
  them to an HTTP endpoint.
- This is a well-trodden pattern (people use it to post photos to WordPress, CDNs,
  custom APIs). It is the realistic answer to "share WhatsApp photos to the app on
  an iPhone without building a native app."
- **Cost:** each staff member installs the shortcut once (we distribute an
  iCloud share link). The shortcut can't choose a customer interactively in a
  great UX, so the simplest design is: it uploads to an **inbox** and the photos
  are assigned to a customer afterwards in the app (see recommendation).
- **Auth is the catch:** a Shortcut's `POST` does not carry the staff member's
  browser session cookie. It needs its own credential — e.g. a per-user **upload
  token** (generated in the app, pasted into the shortcut once, sent as a header
  / query param the endpoint verifies). Plan for this.

### 3. In-app upload button (universal baseline)
- A plain `<input type="file" accept="image/*" multiple>` (camera + library on
  mobile) with an "Add photos" button on Home and Customers. Pick a customer,
  upload. No OS share integration, works on every device including iPhone.
- This is the dependable baseline and the same endpoint everything else reuses.

### 4. Native / wrapper app
- A native or wrapped (Capacitor/PWABuilder) iOS app *can* register as a share
  target, but that means App Store distribution and maintenance — out of scope
  for "without being an iOS app".

---

## Recommendation & build order

1. **Upload endpoint + storage + association (foundation).** An authenticated
   `POST` that accepts image files and links them to a contact (object storage
   already exists for customer-info photos — reuse it). Add a way to view a
   contact's uploaded photos. This unblocks every option below and is the
   deferred *direct-staff-photo-upload* follow-up.
2. **In-app "Add photos" buttons** on Home and the Customers page (choose a
   customer → upload). Universal; ship this first after the endpoint.
3. **Android `share_target`** in the manifest pointing at the upload endpoint, so
   an installed Android PWA receives WhatsApp shares directly. (The app already
   ships a service worker, so it's a PWA — confirm/extend the manifest.)
4. **iOS Shortcut recipe** distributed to staff: receives images from the share
   sheet and POSTs them with a per-user upload token to an **inbox**; the app then
   prompts to assign the inbox photos to a customer. Document the install steps.

**Effort:** step 1 is the bulk of the work (endpoint, storage wiring, viewer,
auth/token). Steps 2–3 are small once 1 exists. Step 4 is mostly documentation
plus the token mechanism from step 1.

## Sources
- [share_target — Web app manifest (MDN)](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target)
- [WebKit bug 194593 — Add support for Web Share Target API](https://bugs.webkit.org/show_bug.cgi?id=194593)
- [PWA iOS limitations & Safari support (2026)](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide)
- [About share actions in Shortcuts (Apple Support)](https://support.apple.com/guide/shortcuts/share-actions-apdaf74d75a5/ios)
- [Request your first API in Shortcuts (Apple Support)](https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios)
