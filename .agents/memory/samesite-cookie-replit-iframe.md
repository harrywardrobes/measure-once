---
name: SameSite cookie + Replit preview iframe
description: Why session auth loops in the Replit preview but works in a standalone tab, and the cookie settings that fix it.
---

# Session-cookie auth loop in Replit's embedded preview

**Symptom:** Login succeeds, home renders briefly, then bounces back to
login — an endless redirect loop. A valid session row WITH `passport.user`
exists in the DB, yet `/api/auth/user` logs `hasSession: true,
passportAuth: false` (Passport never deserialises because the request
arrives without the session cookie, so a fresh empty session is created).

**Root cause:** Replit's in-IDE preview pane embeds the running app in a
**cross-origin iframe** (top-level `replit.com` embedding the app on
`replit.dev`). A cookie set with `SameSite=Lax` is **not sent** on
cross-site subframe fetch/XHR requests (Lax only allows same-site requests
and cross-site *top-level* GET navigations). So every `/api/*` call from the
React islands goes out cookieless → 401 → redirect. The cookie is still
*stored* by the browser (SameSite never blocks Set-Cookie), which is why the
DB session looks valid — it just never travels back. The same app works in a
standalone browser tab (same-origin → Lax is fine), which masks the bug.

**Fix:** session cookie must be `SameSite=None; Secure`, and express-session
needs `proxy: true` so it trusts Replit's `X-Forwarded-Proto: https` and
actually emits the `Secure` flag (SameSite=None is rejected by browsers
without Secure).

```js
session({
  ...,
  proxy: true,
  cookie: { httpOnly: true, secure: true, sameSite: 'none', maxAge: ttl },
})
```

**Why:** Lax cookies are invisible to cross-site iframe subrequests; None+Secure
are sent in every context. `proxy: true` is required because the dev/prod
server speaks HTTP behind Replit's TLS-terminating proxy — without it
`req.secure` is false and the Secure flag (and thus the whole cookie) is dropped.

**How to apply:** Any session/auth cookie on an app meant to run inside the
Replit preview must use `SameSite=None; Secure` + `proxy: true`. Do NOT
gate `secure` on `NODE_ENV` — the dev preview is also cross-origin HTTPS, so
`secure` must be true in dev too. After changing the setting, the user must do
a **fresh login**: the browser still holds the old Lax cookie, which can't be
upgraded in place — only a new Set-Cookie issues the None/Secure variant.

**Diagnostic tell:** a single long-lived DB session with passport data while
every request logs `passportAuth: false` == the cookie is stored but not being
sent == SameSite/cross-site issue, not a session-store or save-race issue.
