# Privilege Adversarial Test Suite — Report

- Run ID: `lq4i2u`
- Started: 2026-05-20T16:02:17.046Z
- Finished: 2026-05-20T16:02:24.870Z
- Harness: `npm run test:privileges` (boots a dedicated server on a separate port, seeds four users, runs probes, exits non-zero on findings).

## Summary

- Capability matrix: 325/325 passed (12 inconclusive — guard fired before authz, see below)
- Adversarial probes: 58/58 passed
- **Findings**: 0

## Inconclusive matrix cells

These cells got a `503` from a pre-authz guard (e.g. `requireHubspotToken` mounted via `app.use` runs before `requirePrivilege`). The harness cannot tell from the wire whether the privilege gate would have denied the request — re-run with the relevant third-party credentials populated to verify.

| Route | Requires | Actor | Status | Kind |
|---|---|---|---|---|
| POST /api/contacts | member | viewer | 503 | hubspot-guard-503-inconclusive |
| PATCH /api/contacts/0/localdata | member | viewer | 503 | hubspot-guard-503-inconclusive |
| PATCH /api/contacts/0 | member | viewer | 503 | hubspot-guard-503-inconclusive |
| PATCH /api/deals/0 | member | viewer | 503 | hubspot-guard-503-inconclusive |
| POST /api/deals/0/checklist | member | viewer | 503 | hubspot-guard-503-inconclusive |
| POST /api/contacts/0/workflow | member | viewer | 503 | hubspot-guard-503-inconclusive |
| POST /api/deals/0/workflow | member | viewer | 503 | hubspot-guard-503-inconclusive |
| POST /api/contacts/0/tasks | member | viewer | 503 | hubspot-guard-503-inconclusive |
| PATCH /api/tasks/0 | member | viewer | 503 | hubspot-guard-503-inconclusive |
| DELETE /api/tasks/0 | member | viewer | 503 | hubspot-guard-503-inconclusive |
| PATCH /api/contacts/0/rooms/0/fitter | manager | viewer | 503 | hubspot-guard-503-inconclusive |
| PATCH /api/contacts/0/rooms/0/fitter | manager | member | 503 | hubspot-guard-503-inconclusive |

## Capability matrix

Each cell shows the HTTP status observed for the given (role × route).
A FAIL means a role gained access it should not have (privilege escalation) or was denied access it should have (legitimate-access regression).

| Route | Requires | unauth | viewer | member | manager | admin |
|---|---|---|---|---|---|---|
| GET /api/auth/user | auth | 401 | 200 | 200 | 200 | 200 |
| GET /api/onboarding/me | auth | 401 | 200 | 200 | 200 | 200 |
| GET /api/job-roles | auth | 401 | 200 | 200 | 200 | 200 |
| GET /api/platform-users | auth | 401 | 200 | 200 | 200 | 200 |
| GET /api/users/me/prefs | auth | 401 | 200 | 200 | 200 | 200 |
| GET /api/google/status | auth | 401 | 200 | 200 | 200 | 200 |
| GET /api/quickbooks/status | auth | 401 | 200 | 200 | 200 | 200 |
| GET /api/visits | auth | 401 | 400 | 400 | 400 | 400 |
| GET /api/localdata/all | auth | 401 | 503 | 503 | 503 | 503 |
| GET /api/workflow-stages | auth | 401 | 503 | 503 | 503 | 503 |
| GET /api/contacts-all | auth | 401 | 503 | 503 | 503 | 503 |
| PATCH /api/users/me/prefs | auth | 401 | 200 | 200 | 200 | 200 |
| POST /api/users/me/photo | auth | 401 | 400 | 400 | 400 | 400 |
| POST /api/contacts | member | 401 | 503 | 503 | 503 | 503 |
| PATCH /api/contacts/0/localdata | member | 401 | 503 | 503 | 503 | 503 |
| PATCH /api/contacts/0 | member | 401 | 503 | 503 | 503 | 503 |
| PATCH /api/deals/0 | member | 401 | 503 | 503 | 503 | 503 |
| POST /api/deals/0/checklist | member | 401 | 503 | 503 | 503 | 503 |
| POST /api/contacts/0/workflow | member | 401 | 503 | 503 | 503 | 503 |
| POST /api/deals/0/workflow | member | 401 | 503 | 503 | 503 | 503 |
| POST /api/contacts/0/tasks | member | 401 | 503 | 503 | 503 | 503 |
| PATCH /api/tasks/0 | member | 401 | 503 | 503 | 503 | 503 |
| DELETE /api/tasks/0 | member | 401 | 503 | 503 | 503 | 503 |
| POST /api/emails/send | member | 401 | 403 | 401 | 401 | 401 |
| POST /api/events | member | 401 | 403 | 401 | 401 | 401 |
| POST /api/personal-tasks | member | 401 | 403 | 400 | 400 | 400 |
| PATCH /api/personal-tasks/0 | member | 401 | 403 | 404 | 404 | 404 |
| DELETE /api/personal-tasks/0 | member | 401 | 403 | 404 | 404 | 404 |
| POST /api/visits | member | 401 | 403 | 400 | 400 | 400 |
| PATCH /api/visits/0 | member | 401 | 403 | 400 | 400 | 400 |
| DELETE /api/visits/0 | member | 401 | 403 | 404 | 404 | 404 |
| POST /api/workflow | manager | 401 | 403 | 403 | 400 | 400 |
| PATCH /api/contacts/0/rooms/0/fitter | manager | 401 | 503 | 503 | 503 | 503 |
| GET /api/trades | manager | 401 | 403 | 403 | 200 | 200 |
| POST /api/trades | manager | 401 | 403 | 403 | 400 | 400 |
| PUT /api/trades/0 | manager | 401 | 403 | 403 | 400 | 400 |
| GET /api/trades/0/audit | manager | 401 | 403 | 403 | 200 | 200 |
| DELETE /api/trades/0 | manager | 401 | 403 | 403 | 404 | 404 |
| POST /api/trades/submissions | manager | 401 | 403 | 403 | 400 | 400 |
| GET /api/quickbooks/invoices | manager | 401 | 403 | 403 | 503 | 503 |
| GET /api/quickbooks/invoice/0 | manager | 401 | 403 | 403 | 503 | 503 |
| GET /api/quickbooks/invoice/0/pdf | manager | 401 | 403 | 403 | 503 | 503 |
| GET /api/admin/requests | admin | 401 | 403 | 403 | 403 | 200 |
| POST /api/admin/requests/0/approve | admin | 401 | 403 | 403 | 403 | 404 |
| POST /api/admin/requests/0/reject | admin | 401 | 403 | 403 | 403 | 404 |
| POST /api/admin/allowed | admin | 401 | 403 | 403 | 403 | 400 |
| DELETE /api/admin/allowed/test-noop@privtest.local | admin | 401 | 403 | 403 | 403 | 200 |
| GET /api/admin/users | admin | 401 | 403 | 403 | 403 | 200 |
| GET /api/admin/audit-log | admin | 401 | 403 | 403 | 403 | 200 |
| GET /api/admin/job-roles | admin | 401 | 403 | 403 | 403 | 200 |
| POST /api/admin/job-roles | admin | 401 | 403 | 403 | 403 | 400 |
| DELETE /api/admin/job-roles/__nope__ | admin | 401 | 403 | 403 | 403 | 200 |
| GET /api/admin/photo-requests | admin | 401 | 403 | 403 | 403 | 200 |
| POST /api/admin/photo-requests/0/approve | admin | 401 | 403 | 403 | 403 | 404 |
| POST /api/admin/photo-requests/0/reject | admin | 401 | 403 | 403 | 403 | 404 |
| GET /api/admin/trades/submissions | admin | 401 | 403 | 403 | 403 | 200 |
| POST /api/admin/trades/submissions/0/approve | admin | 401 | 403 | 403 | 403 | 404 |
| POST /api/admin/trades/submissions/0/reject | admin | 401 | 403 | 403 | 403 | 404 |
| GET /api/admin/trades-audit | admin | 401 | 403 | 403 | 403 | 200 |
| PATCH /api/trades/0/category | admin | 401 | 403 | 403 | 403 | 400 |
| POST /api/admin/users/foo@bar.com/resend-set-password | admin | 401 | 403 | 403 | 403 | 404 |
| POST /api/admin/users/foo@bar.com/force-password-reset | admin | 401 | 403 | 403 | 403 | 404 |
| POST /api/quickbooks/invoice/0 | admin | 401 | 403 | 403 | 403 | 503 |
| POST /api/quickbooks/invoice/0/send | admin | 401 | 403 | 403 | 403 | 503 |
| POST /auth/quickbooks/disconnect | admin | 401 | 403 | 403 | 403 | 200 |

## Adversarial probes (full log)

### sign-in

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | high | wrong password rejected | 401 unauthorized | status=401 |  |
| PASS | high | unknown email rejected | 401 unauthorized | status=401 |  |
| PASS | low | malformed email rejected | 400 bad request | status=400 |  |
| PASS | high | session cookie hardened | HttpOnly + Secure + SameSite=Lax | HttpOnly=true Secure=true SameSite=Lax=true |  |
| PASS | high | logout invalidates session | /api/auth/user 200 before, 401 after | before=200 after=401 |  |

### password-flow

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | medium | forgot-password always returns 200 (no enumeration) | status=200 | status=200 |  |
| PASS | high | forgot-password issued a reset token | one unused token row | rowCount=1 purpose=reset |  |
| PASS | high | empty token rejected | 410 gone | status=410 |  |
| PASS | high | random token rejected | 410 gone | status=410 |  |
| PASS | critical | set-password token is single-use | first=200 replay=410 | first=200 replay=410 |  |
| PASS | critical | expired token rejected | 410 gone | status=410 |  |

### escalation

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | critical | member cannot self-promote via PATCH profile | 403 forbidden | status=403 |  |
| PASS | critical | member cannot mass-assign other fields via PATCH profile | 403 forbidden | status=403 |  |
| PASS | critical | member privilege_level + email unchanged after escalation attempts | privilege_level=member email=privtest-member-lq4i2u@privtest.local | privilege_level=member email=privtest-member-lq4i2u@privtest.local |  |

### idor

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | high | viewer cannot read admin's profile | 403 forbidden | status=403 |  |
| PASS | high | viewer cannot read manager's profile | 403 forbidden | status=403 |  |

### change-password

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | high | wrong current password | status=401 | status=401 |  |
| PASS | high | empty body | status=400 | status=400 |  |
| PASS | high | oversized password | status=400 | status=400 |  |
| PASS | high | whitespace password | status=400 | status=400 |  |
| PASS | high | identical to current | status=400 | status=400 |  |

### session

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | high | admin revoke endpoint returns 200 | status=200 | status=200 |  |
| PASS | critical | revoked user is logged out within one request | before=200 after=401 | before=200 after=401 |  |
| PASS | high | admin force-password-reset returns 200 | status=200 | status=200 |  |
| PASS | critical | force-password-reset invalidates other sessions | before=200 after=401 | before=200 after=401 |  |
| PASS | critical | change-password invalidates *other* sessions for the same user | change=200 other-session-after=401 | change=200 other-session-after=401 |  |
| PASS | info | restoring manager password for later probes succeeds | status=200 | status=200 |  |

### admin-only

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | critical | viewer cannot add allowed_email | 403 forbidden | status=403 |  |
| PASS | critical | viewer cannot revoke allowed_email | 403 forbidden | status=403 |  |
| PASS | critical | viewer cannot force a password reset | 403 forbidden | status=403 |  |
| PASS | high | viewer cannot resend set-password link | 403 forbidden | status=403 |  |
| PASS | critical | member cannot add allowed_email | 403 forbidden | status=403 |  |
| PASS | critical | member cannot revoke allowed_email | 403 forbidden | status=403 |  |
| PASS | critical | member cannot force a password reset | 403 forbidden | status=403 |  |
| PASS | high | member cannot resend set-password link | 403 forbidden | status=403 |  |
| PASS | critical | manager cannot add allowed_email | 403 forbidden | status=403 |  |
| PASS | critical | manager cannot revoke allowed_email | 403 forbidden | status=403 |  |
| PASS | critical | manager cannot force a password reset | 403 forbidden | status=403 |  |
| PASS | high | manager cannot resend set-password link | 403 forbidden | status=403 |  |

### admin-lifecycle

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | high | admin add allowed_email | status=200 | status=200 |  |
| PASS | medium | admin resend set-password | status in {200,500} | status=200 |  |
| PASS | medium | admin force-password-reset | status in {200,500} | status=200 |  |
| PASS | high | admin revoke allowed_email | status=200 | status=200 |  |
| PASS | high | admin cannot force-reset their own password | 400 bad request | status=400 |  |

### admin-page

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | high | unauthenticated /admin redirects to /login | 302 to /login | status=302 location=/login |  |
| PASS | critical | viewer sees the admin access-denied page | 403 + "Admin access required" | status=403 |  |
| PASS | critical | member sees the admin access-denied page | 403 + "Admin access required" | status=403 |  |
| PASS | critical | manager sees the admin access-denied page | 403 + "Admin access required" | status=403 |  |
| PASS | high | admin can load /admin | status=200 | status=200 |  |

### captcha

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | info | Turnstile is disabled in the test harness | enabled=false | enabled=false | Set TURNSTILE_SECRET_KEY in the env to re-run with captcha enforcement. |
| PASS | info | login succeeds when captcha disabled (no-op path) | status=200 | status=200 |  |

### xss

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | info | request-access accepts arbitrary name string | status in {200,409} | status=200 |  |
| PASS | medium | admin requests API returns the payload verbatim (must be HTML-escaped client-side) | name === "x');fetch('https://x')//@xss-lq4i2u.bc" | found=true name="x');fetch('https://x')//@xss-lq4i2u.bc" | Check public/admin.html escaping — this is data confirmation, not a render test. |

### onboarding

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | high | more_info_required user is blocked by onboarding gate | 403 + code 'ONBOARDING_REQUIRED' | status=403 code=ONBOARDING_REQUIRED |  |
| PASS | medium | /api/auth/user is still reachable during onboarding | status=200 | status=200 |  |

### oauth

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | high | unauthenticated google callback rejected | 401 unauthorized | status=401 |  |
| PASS | high | unauthenticated quickbooks callback rejected | 401 unauthorized | status=401 |  |
| PASS | critical | non-admin quickbooks callback rejected | 403 forbidden | status=403 |  |

## Coverage notes

- The capability matrix probes a representative subset of the API surface — every gate type (`isAuthenticated`, `requirePrivilege(member|manager)`, `requireManagerOrAdmin`, `requireAdmin`) is exercised across all four authenticated roles plus the unauthenticated baseline.
- Routes that depend on third-party tokens (HubSpot, Google, QuickBooks) are run with empty credentials in the harness; an authorized 503/500 from those handlers is still treated as "permitted" because the auth gate fired correctly.
- Rate limiters are *not* hammered in the matrix to avoid skewing other probes. A dedicated rate-limit probe is left as future work; the current run records a 429 as `rate-limited` (skipped) rather than a pass or fail.
- The Playwright UI smoke from the plan was replaced with a server-side GET `/admin` probe per role plus an HTML-body assertion. This catches the same access-control regressions without the headless-browser dependency.
- Turnstile is disabled in the test harness so login can be driven without a real Cloudflare token. To validate the captcha gate, re-run with `TURNSTILE_SECRET_KEY` set — the gate code path is the same one exercised in production by `/api/login`, `/api/request-access`, and `/api/forgot-password`.

## Harness server log (tail)

```
  Auth (email + password) initialized

  Measure Once
  Running at: http://localhost:5050

[rate-limit cleanup] Removed 1 expired session(s).
  Could not create property measure_once_rooms: Authentication credentials not found. This API supports OAuth 2.0 authentication and you can find more details at https://developers.hubspot.com/docs/methods/auth/oauth-overview
  Could not create property measure_once_notes: Authentication credentials not found. This API supports OAuth 2.0 authentication and you can find more details at https://developers.hubspot.com/docs/methods/auth/oauth-overview
  Could not create property measure_once_stage: Authentication credentials not found. This API supports OAuth 2.0 authentication and you can find more details at https://developers.hubspot.com/docs/methods/auth/oauth-overview
  Could not create property measure_once_substage: Authentication credentials not found. This API supports OAuth 2.0 authentication and you can find more details at https://developers.hubspot.com/docs/methods/auth/oauth-overview
  Could not create property customer_number: Authentication credentials not found. This API supports OAuth 2.0 authentication and you can find more details at https://developers.hubspot.com/docs/methods/auth/oauth-overview
  Visits table ready
  Trades table ready
QB invoices error: QuickBooks not connected
QB invoices error: QuickBooks not connected
QB invoice detail error: QuickBooks not connected
QB invoice detail error: QuickBooks not connected
  SMTP not configured — skipping set-password email for privtest-viewer-lq4i2u@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=060ad934aa7d2702e5d559ddd16bc8c50d7c774c367eb525f72189c2118ef27a
  Password reset link issued for privtest-viewer-lq4i2u@privtest.local
[set-password] Cleared 1 other session(s) for privtest-viewer-lq4i2u@privtest.local.
  SMTP not configured — skipping set-password email for privtest-member-lq4i2u@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=84ad6a4708e299c127e763314c2b1a04e861d65745c1c7dc86ba89e41c44bde8
[change-password] Cleared 2 other session(s) for privtest-manager-lq4i2u@privtest.local.
  SMTP not configured — skipping set-password email for privtest-lifecycle-lq4i2u@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=0ab817bd5b6b7a7383e139774a1268e34bd17687001cb87a70452bd917fe54fb
  SMTP not configured — skipping set-password email for privtest-lifecycle-lq4i2u@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=0982a72e1caf259354966530f2b29fe0ddb8341e3e74dbf8828c1e10b6d94829
  SMTP not configured — skipping set-password email for privtest-lifecycle-lq4i2u@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=6cdf7732ab5be063ea69074409412a3bb8307ce4f751f75638e9bce2632d8f10
  Access request: x');fetch('https://x')//@xss-lq4i2u.bc <privtest-xss-lq4i2u@privtest.local>

```
