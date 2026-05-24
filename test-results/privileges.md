# Privilege Adversarial Test Suite — Report

- Run ID: `jhmoan`
- Started: 2026-05-24T18:29:21.629Z
- Finished: 2026-05-24T18:30:41.667Z
- Harness: `npm run test:privileges` (boots a dedicated server on a separate port, seeds four users, runs probes, exits non-zero on findings).

## Summary

- Capability matrix: 563/570 passed (0 inconclusive — guard fired before authz, see below)
- Adversarial probes: 133/141 passed
- **Findings**: 15
  - medium: 8
  - info: 7

## Findings

| Severity | Source | Name | Expected | Observed | Detail |
|---|---|---|---|---|---|
| medium | probe | xss · admin requests API returns the payload verbatim (must be HTML-escaped client-side) | name === "x');fetch('https://x')//@xss-jhmoan.bc" | found=true name="X');fetch('https://x')//@xss-jhmoan.bc" | Check public/admin.html escaping — this is data confirmation, not a render test. |
| medium | probe | captcha · turnstile tampering probe (REQUIRED coverage) | captcha tampering matrix executed against 3 endpoints × 5 payloads | captcha pass-through not enabled — probe could NOT be executed | Run with PRIVTEST_USE_TURNSTILE_SECRET_KEY=1 TURNSTILE_SECRET_KEY=… npm run test:privileges to exercise the captcha gate path. |
| medium | probe | ui-smoke · pagination advances to page 2 on Next click | info text contains "Showing 26" (the 26th item) | text="Showing 1–25 of 26" |  |
| medium | probe | ui-smoke · returning to /customers restores page 2 from sessionStorage | pagination info still shows "Showing 26" after back-navigation | text="Showing 1–25 of 26" |  |
| medium | probe | ui-smoke · filter applied on page 2 resets customer list to page 1 | pagination info shows "Showing 1–25 of 26" after filter change from page 2 | onPage2="Showing 1–25 of 26" afterFilter="Showing 1–25 of 26" filterApplied=true |  |
| medium | probe | ui-smoke · lead-status filter change on page 2 resets customer list to page 1 | pagination info shows "Showing 1–" after lead-status dropdown change from page 2 | onPage2="Showing 1–25 of 26" afterFilter="" filterApplied=false |  |
| medium | probe | ui-smoke · pagination bar does not overflow at 420 px with 9 pages (narrowest breakpoint) | scrollWidth <= clientWidth on .cl-pagination at 420 px with 201 contacts on page 8 | pagination bar not found |  |
| medium | probe | ui-smoke · .cl-pagination-info is hidden at 420 px viewport width | display:none or not visible per computed style | pagination bar not found |  |
| info | matrix | GET /trades (as viewer, requires manager) | 401/403 from privilege gate | status=200 (privilege-escalation) |  |
| info | matrix | GET /trades (as member, requires manager) | 401/403 from privilege gate | status=200 (privilege-escalation) |  |
| info | matrix | GET /api/trades (as viewer, requires manager) | 401/403 from privilege gate | status=200 (privilege-escalation) |  |
| info | matrix | GET /api/trades (as member, requires manager) | 401/403 from privilege gate | status=200 (privilege-escalation) |  |
| info | matrix | GET /api/quickbooks/invoices (as manager, requires manager) | any non-403 (auth gate passes) | status=403 (unexpected-denial) |  |
| info | matrix | GET /api/quickbooks/invoice/0 (as manager, requires manager) | any non-403 (auth gate passes) | status=403 (unexpected-denial) |  |
| info | matrix | GET /api/quickbooks/invoice/0/pdf (as manager, requires manager) | any non-403 (auth gate passes) | status=403 (unexpected-denial) |  |

## Capability matrix

Each cell shows the HTTP status observed for the given (role × route).
A FAIL means a role gained access it should not have (privilege escalation) or was denied access it should have (legitimate-access regression).

| Route | Requires | unauth | viewer | member | manager | admin |
|---|---|---|---|---|---|---|
| GET /api/turnstile-config | public | 200 | 200 | 200 | 200 | 200 |
| GET /api/check-email?email=foo%40bar.com | public | 200 | 200 | 200 | 200 | 200 |
| GET /api/set-password/validate?token=zzz | public | 404 | 404 | 404 | 404 | 404 |
| GET /auth/status | public | 200 | 200 | 200 | 200 | 200 |
| POST /api/login | public | 401 | 401 | 401 | 401 | 401 |
| POST /api/request-access | public | 429 | 429 | 429 | 429 | 429 |
| POST /api/forgot-password | public | 429 | 429 | 429 | 429 | 429 |
| POST /api/set-password | public | 410 | 410 | 410 | 410 | 410 |
| GET /api/auth/user | auth | 401 | 200 | 200 | 200 | 200 |
| POST /api/change-password | auth | 401 | 401 | 401 | 401 | 401 |
| GET /api/onboarding/me | auth | 401 | 200 | 200 | 200 | 200 |
| POST /api/onboarding/complete | auth | 401 | 400 | 400 | 400 | 400 |
| GET /api/job-roles | auth | 401 | 200 | 200 | 200 | 200 |
| GET /api/platform-users | auth | 401 | 200 | 200 | 200 | 200 |
| GET /api/users/me/prefs | auth | 401 | 200 | 200 | 200 | 200 |
| PATCH /api/users/me/prefs | auth | 401 | 200 | 200 | 200 | 200 |
| POST /api/users/me/photo | auth | 401 | 400 | 400 | 400 | 400 |
| GET /api/google/status | auth | 401 | 200 | 200 | 200 | 200 |
| GET /auth/google | auth | 401 | 302 | 302 | 302 | 302 |
| GET /auth/google/callback?code=x&state=y | auth | 401 | 302 | 302 | 302 | 302 |
| POST /auth/logout-google | auth | 401 | 200 | 200 | 200 | 200 |
| GET /api/quickbooks/status | auth | 401 | 200 | 200 | 200 | 200 |
| GET /api/hubspot/status | auth | 401 | 200 | 200 | 200 | 200 |
| GET /api/account | auth | 401 | 503 | 503 | 503 | 503 |
| GET /api/pipeline | auth | 401 | 503 | 503 | 503 | 503 |
| GET /api/deals | auth | 401 | 503 | 503 | 503 | 503 |
| GET /api/deals/0 | auth | 401 | 503 | 503 | 503 | 503 |
| GET /api/deals/0/notes | auth | 401 | 503 | 503 | 503 | 503 |
| GET /api/contacts-all | auth | 401 | 503 | 503 | 503 | 503 |
| GET /api/open-leads | auth | 401 | 503 | 503 | 503 | 503 |
| GET /api/contacts/0 | auth | 401 | 503 | 503 | 503 | 503 |
| GET /api/contacts/0/localdata | auth | 401 | 503 | 503 | 503 | 503 |
| GET /api/contacts/0/notes | auth | 401 | 503 | 503 | 503 | 503 |
| GET /api/contacts/0/tasks | auth | 401 | 503 | 503 | 503 | 503 |
| GET /api/emails | auth | 401 | 401 | 401 | 401 | 401 |
| GET /api/events | auth | 401 | 401 | 401 | 401 | 401 |
| GET /api/calendar/upcoming | auth | 401 | 200 | 200 | 200 | 200 |
| GET /api/localdata/all | auth | 401 | 503 | 503 | 503 | 503 |
| GET /api/workflow | auth | 401 | 200 | 200 | 200 | 200 |
| GET /api/card-action-handlers | auth | 401 | 200 | 200 | 200 | 200 |
| GET /api/workflow-stages | auth | 401 | 503 | 503 | 503 | 503 |
| GET /api/personal-tasks | auth | 401 | 200 | 200 | 200 | 200 |
| GET /api/visits | auth | 401 | 400 | 400 | 400 | 400 |
| GET /api/users/f44a7b43-2c31-488c-99db-798c10dd7455/profile | self-or-admin | 401 | 403 | 403 | 403 | 200 |
| GET /api/users/f44a7b43-2c31-488c-99db-798c10dd7455/photo | auth | 401 | 404 | 404 | 404 | 404 |
| PATCH /api/users/f44a7b43-2c31-488c-99db-798c10dd7455/profile | self-or-admin | 401 | 403 | 403 | 403 | 200 |
| POST /api/contacts | member | 401 | 403 | 503 | 503 | 503 |
| POST /api/contacts/0/localdata | member | 401 | 403 | 503 | 503 | 503 |
| PATCH /api/contacts/0 | member | 401 | 403 | 503 | 503 | 503 |
| PATCH /api/deals/0 | member | 401 | 403 | 503 | 503 | 503 |
| POST /api/deals/0/checklist | member | 401 | 403 | 503 | 503 | 503 |
| POST /api/contacts/0/workflow | member | 401 | 403 | 503 | 503 | 503 |
| POST /api/deals/0/workflow | member | 401 | 403 | 503 | 503 | 503 |
| POST /api/contacts/0/tasks | member | 401 | 403 | 503 | 503 | 503 |
| PATCH /api/tasks/0 | member | 401 | 403 | 503 | 503 | 503 |
| DELETE /api/tasks/0 | member | 401 | 403 | 503 | 503 | 503 |
| POST /api/emails/send | member | 401 | 403 | 401 | 401 | 401 |
| POST /api/events | member | 401 | 403 | 401 | 401 | 401 |
| POST /api/personal-tasks | member | 401 | 403 | 400 | 400 | 400 |
| PATCH /api/personal-tasks/0 | member | 401 | 403 | 404 | 404 | 404 |
| DELETE /api/personal-tasks/0 | member | 401 | 403 | 404 | 404 | 404 |
| POST /api/visits | member | 401 | 403 | 400 | 400 | 400 |
| POST /api/card-actions/phone-call-summary | member | 401 | 403 | 503 | 503 | 503 |
| PATCH /api/visits/0 | member | 401 | 403 | 400 | 400 | 400 |
| DELETE /api/visits/0 | member | 401 | 403 | 404 | 404 | 404 |
| POST /api/workflow | manager | 401 | 403 | 403 | 400 | 400 |
| PATCH /api/contacts/0/rooms/0/fitter | manager | 401 | 403 | 403 | 503 | 503 |
| GET /trades | manager | 401 | 200 ⚠ | 200 ⚠ | 200 | 200 |
| GET /api/trades | manager | 401 | 200 ⚠ | 200 ⚠ | 200 | 200 |
| POST /api/trades | manager | 401 | 403 | 403 | 400 | 400 |
| PUT /api/trades/0 | manager | 401 | 403 | 403 | 400 | 400 |
| GET /api/trades/0/audit | manager | 401 | 403 | 403 | 200 | 200 |
| DELETE /api/trades/0 | manager | 401 | 403 | 403 | 404 | 404 |
| POST /api/trades/submissions | manager | 401 | 403 | 403 | 400 | 400 |
| GET /api/quickbooks/invoices | manager | 401 | 403 | 403 | 403 ⚠ | 503 |
| GET /api/quickbooks/invoice/0 | manager | 401 | 403 | 403 | 403 ⚠ | 503 |
| GET /api/quickbooks/invoice/0/pdf | manager | 401 | 403 | 403 | 403 ⚠ | 503 |
| GET /admin | admin | 302 | 403 | 403 | 403 | 200 |
| GET /api/admin/requests | admin | 401 | 403 | 403 | 403 | 200 |
| POST /api/admin/requests/0/approve | admin | 401 | 403 | 403 | 403 | 404 |
| POST /api/admin/requests/0/reject | admin | 401 | 403 | 403 | 403 | 404 |
| GET /api/admin/allowed | admin | 401 | 403 | 403 | 403 | 200 |
| POST /api/admin/allowed | admin | 401 | 403 | 403 | 403 | 400 |
| DELETE /api/admin/allowed/test-noop@privtest.local | admin | 401 | 403 | 403 | 403 | 200 |
| GET /api/admin/users | admin | 401 | 403 | 403 | 403 | 200 |
| GET /api/admin/audit-log | admin | 401 | 403 | 403 | 403 | 200 |
| GET /api/admin/capabilities | admin | 401 | 403 | 403 | 403 | 200 |
| PATCH /api/admin/capabilities | admin | 401 | 403 | 403 | 403 | 400 |
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
| GET /api/admin/audit-log-unified | admin | 401 | 403 | 403 | 403 | 200 |
| POST /api/admin/trades/migrate | admin | 401 | 403 | 403 | 403 | 200 |
| PATCH /api/trades/0/category | admin | 401 | 403 | 403 | 403 | 400 |
| POST /api/admin/users/foo@bar.com/resend-set-password | admin | 401 | 403 | 403 | 403 | 404 |
| POST /api/admin/users/foo@bar.com/force-password-reset | admin | 401 | 403 | 403 | 403 | 404 |
| GET /auth/quickbooks | admin | 401 | 403 | 403 | 403 | 503 |
| GET /auth/quickbooks/callback?code=x&state=y&realmId=1 | admin | 401 | 403 | 403 | 403 | 302 |
| POST /auth/quickbooks/disconnect | admin | 401 | 403 | 403 | 403 | 200 |
| POST /api/quickbooks/invoice/0 | admin | 401 | 403 | 403 | 403 | 503 |
| POST /api/quickbooks/invoice/0/send | admin | 401 | 403 | 403 | 403 | 503 |
| POST /api/admin/dv-handles/0/image | admin | 401 | 403 | 403 | 403 | 400 |
| GET /api/admin/card-action-handlers | admin | 401 | 403 | 403 | 403 | 200 |
| POST /api/admin/card-action-handlers | admin | 401 | 403 | 403 | 403 | 201 |
| PATCH /api/admin/card-action-handlers/0 | admin | 401 | 403 | 403 | 403 | 400 |
| DELETE /api/admin/card-action-handlers/0 | admin | 401 | 403 | 403 | 403 | 400 |
| POST /api/logout | auth | 401 | 200 | 200 | 200 | 200 |

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
| PASS | critical | member privilege_level + email unchanged after escalation attempts | privilege_level=member email=privtest-member-jhmoan@privtest.local | privilege_level=member email=privtest-member-jhmoan@privtest.local |  |

### idor

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | high | viewer cannot read /profile of admin uuid | status in {400,403,404} (no data leak) | status=403 |  |
| PASS | high | viewer can read /photo of admin uuid (auth-level, team roster) | status not in {401,403} | status=404 |  |
| PASS | high | viewer cannot read /profile of manager uuid | status in {400,403,404} (no data leak) | status=403 |  |
| PASS | high | viewer can read /photo of manager uuid (auth-level, team roster) | status not in {401,403} | status=404 |  |
| PASS | high | viewer cannot read /profile of guessed uuid | status in {400,403,404} (no data leak) | status=403 |  |
| PASS | high | viewer can read /photo of guessed uuid (auth-level, team roster) | status not in {401,403} | status=404 |  |
| PASS | high | viewer cannot read /profile of numeric id 0 | status in {400,403,404} (no data leak) | status=403 |  |
| PASS | high | viewer can read /photo of numeric id 0 (auth-level, team roster) | status not in {401,403} | status=404 |  |
| PASS | high | viewer cannot read /profile of numeric id 1 | status in {400,403,404} (no data leak) | status=403 |  |
| PASS | high | viewer can read /photo of numeric id 1 (auth-level, team roster) | status not in {401,403} | status=404 |  |
| PASS | high | viewer cannot read /profile of numeric id 99999 | status in {400,403,404} (no data leak) | status=403 |  |
| PASS | high | viewer can read /photo of numeric id 99999 (auth-level, team roster) | status not in {401,403} | status=404 |  |
| PASS | high | viewer cannot read admin's photo | 403 forbidden (or 404 no-photo) | status=404 |  |
| PASS | medium | viewer can read their own photo endpoint | status in {200,404} (self-access permitted) | status=404 |  |

### change-password

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | high | wrong current password | status=401 | status=401 |  |
| PASS | high | empty body | status=400 | status=400 |  |
| PASS | high | oversized password | status=400 | status=400 |  |
| PASS | high | whitespace password | status=400 | status=400 |  |
| PASS | high | identical to current | status=400 | status=400 |  |
| PASS | high | swapped keys (current↔new) | status=401 | status=401 |  |
| PASS | high | snake_case keys | status=400 | status=400 |  |
| PASS | high | camelCase + extra "password" key (mass-assignment shape) | status=200 | status=200 |  |
| PASS | critical | another user's session cannot change a third party's password (no req.body.email/userId bypass) | viewer.password_hash unchanged | viewer.hash.changed=false |  |

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
| PASS | critical | viewer cannot approve an account-request | 403 forbidden | status=403 |  |
| PASS | critical | viewer cannot reject an account-request | 403 forbidden | status=403 |  |
| PASS | critical | member cannot approve an account-request | 403 forbidden | status=403 |  |
| PASS | critical | member cannot reject an account-request | 403 forbidden | status=403 |  |
| PASS | critical | manager cannot approve an account-request | 403 forbidden | status=403 |  |
| PASS | critical | manager cannot reject an account-request | 403 forbidden | status=403 |  |
| PASS | critical | account_request status unchanged after non-admin approve/reject attempts | status='pending' | status=pending |  |
| PASS | critical | admin can approve an account-request (happy path) | status in {200,201} | status=200 |  |
| PASS | critical | approving an account-request creates a users row with onboarding_status=more_info_required | row exists, onboarding_status=more_info_required | exists=true onboarding_status=more_info_required privilege_level=member |  |
| PASS | high | admin can resend the set-password link to the new user | status=200 | status=200 |  |
| PASS | high | resend issues a fresh password_set_tokens row | count >= 1 | count=2 |  |
| PASS | high | admin can force a password reset on the new user | status=200 | status=200 |  |
| PASS | critical | admin can revoke the new user (DELETE /api/admin/allowed/:email) | status in {200,204} | status=200 |  |
| PASS | critical | revoke removes the allow-list entry (login surface is shut) | allowed_emails row gone | remaining=0 |  |

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
| FAIL | medium | turnstile tampering probe (REQUIRED coverage) | captcha tampering matrix executed against 3 endpoints × 5 payloads | captcha pass-through not enabled — probe could NOT be executed | Run with PRIVTEST_USE_TURNSTILE_SECRET_KEY=1 TURNSTILE_SECRET_KEY=… npm run test:privileges to exercise the captcha gate path. |

### xss

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | info | request-access accepts arbitrary name string | status in {200,409} | status=200 |  |
| FAIL | medium | admin requests API returns the payload verbatim (must be HTML-escaped client-side) | name === "x');fetch('https://x')//@xss-jhmoan.bc" | found=true name="X');fetch('https://x')//@xss-jhmoan.bc" | Check public/admin.html escaping — this is data confirmation, not a render test. |
| PASS | info | admin can attach an arbitrary note to an allow-list entry | status=200 | status=200 |  |
| PASS | medium | admin allow-list API returns note payload verbatim (admin.html must HTML-escape) | note === "\"><img src=x onerror=fetch('https://x?n=jhmoan')>" | found=true note="\"><img src=x onerror=fetch('https://x?n=jhmoan')>" | Check public/admin.html: the allow-list table must escape the note column. |

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
| PASS | critical | google callback with stale/forged state is rejected (no token exchange) | 302 to /?error=google_auth_failed | status=302 location=/?error=google_auth_failed |  |
| PASS | critical | quickbooks callback with stale/forged state is rejected (no token persist) | 302 to /?qb=error&reason=invalid_state | status=302 location=/?qb=error&reason=invalid_state |  |
| PASS | info | quickbooks state from another user's session cannot be replayed | state captured from admin /auth/quickbooks redirect | init-status=503 (QB_CLIENT_ID not set, no state to leak) | Re-run with QB_CLIENT_ID to exercise the cross-user state path. |
| PASS | critical | google state from another user's session cannot be replayed | 302 to /?error=google_auth_failed | status=302 location=/?error=google_auth_failed |  |

### csrf

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | critical | google callback without state is rejected | 302 to /?error=google_auth_failed | status=302 location=/?error=google_auth_failed |  |
| PASS | critical | quickbooks callback without state is rejected | 302 to /?qb=error&reason=invalid_state | status=302 location=/?qb=error&reason=invalid_state |  |
| PASS | medium | GET /api/admin/allowed does not behave like a write | status in {200,404,405,503} | status=200 |  |
| PASS | medium | GET /api/admin/job-roles does not behave like a write | status in {200,404,405,503} | status=200 |  |
| PASS | medium | GET /api/workflow does not behave like a write | status in {200,404,405,503} | status=200 |  |
| PASS | medium | GET /api/contacts does not behave like a write | status in {200,404,405,503} | status=404 |  |
| PASS | medium | GET /api/users/me/photo does not behave like a write | status in {200,404,405,503} | status=404 |  |
| PASS | critical | google callback with cross-origin Origin/Referer + forged state is still rejected | 302 to /?error=google_auth_failed | status=302 location=/?error=google_auth_failed |  |
| PASS | critical | quickbooks callback with cross-origin Origin/Referer + forged state is still rejected | 302 to /?qb=error&reason=invalid_state | status=302 location=/?qb=error&reason=invalid_state |  |

### downgrade

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | high | admin can demote manager via PATCH /api/users/:id/profile | status=200 | status=200 |  |
| PASS | critical | demoted manager's existing session loses manager-only access on next request | before=200 after in {401,403} | before=200 after=401 |  |

### rate-limit

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | critical | loginLimiter engages within 25 bad-password attempts on /api/login | first 429 ≤ attempt 25, last status = 429 | firstLimited=11 lastStatus=429 | Configured cap: max 20 attempts per 15 minutes (auth.js loginLimiter). A cap deviation means unauthenticated login hammering is not blocked. |
| PASS | critical | accessRequestLimiter blocks the 6th request within 1 hour on /api/request-access | first 429 between attempts 4 and 7 (cap = 5/hr) | firstLimited=6 | Configured cap: max 5 attempts per hour (auth.js accessRequestLimiter). A cap deviation means the access-request flood path is unprotected. |
| PASS | critical | /api/forgot-password engages the accessRequestLimiter within 7 attempts | first 429 between attempts 4 and 7 (cap = 5/hr) | firstLimited=6 | Configured cap: max 5 attempts per hour shared with /api/request-access. A cap deviation means the forgot-password flood path is unprotected. |

### ui-smoke

| Result | Severity | Probe | Expected | Observed | Notes |
|---|---|---|---|---|---|
| PASS | critical | unauth /admin bounces to /login | /login redirect (or 302) | url=http://127.0.0.1:5050/login status=200 |  |
| PASS | critical | viewer can sign in via /api/login (server-side jar) | session cookie set | cookieSet=true |  |
| PASS | critical | viewer /admin returns 403 in the browser | status=403 | status=403 |  |
| PASS | medium | viewer loads /admin without browser console errors | consoleErrors.length === 0 | count=0 sample=[] |  |
| PASS | critical | member can sign in via /api/login (server-side jar) | session cookie set | cookieSet=true |  |
| PASS | critical | member /admin returns 403 in the browser | status=403 | status=403 |  |
| PASS | medium | member loads /admin without browser console errors | consoleErrors.length === 0 | count=0 sample=[] |  |
| PASS | critical | manager can sign in via /api/login (server-side jar) | session cookie set | cookieSet=true |  |
| PASS | critical | manager /admin returns 403 in the browser | status=403 | status=403 |  |
| PASS | medium | manager loads /admin without browser console errors | consoleErrors.length === 0 | count=0 sample=[] |  |
| PASS | critical | admin can sign in via /api/login (server-side jar) | session cookie set | cookieSet=true |  |
| PASS | critical | admin /admin returns 200 in the browser | status=200 | status=200 |  |
| PASS | high | admin sees the Admin Panel HTML after navigation | page HTML contains "Admin Panel" and URL is /admin | url=http://127.0.0.1:5050/admin hasHeading=true |  |
| PASS | high | admin /admin renders .app-header (shared chrome) | .app-header element present in DOM | hasAppHeader=true |  |
| PASS | high | admin /admin .header-page-title contains "Admin" | .header-page-title text includes "Admin" | pageTitleText="Admin" |  |
| PASS | medium | admin /admin has no legacy bespoke "Sign out" nav-btn | no .nav-btn element with "Sign out" text | hasLegacySignOut=false |  |
| PASS | high | admin /admin renders auth avatar (.header-avatar-btn) in #auth-status | #auth-status .header-avatar-btn element present in DOM | hasAuthAvatar=true |  |
| PASS | medium | admin loads /admin without browser console errors | consoleErrors.length === 0 | count=0 sample=[] |  |
| PASS | critical | admin /admin renders the stored XSS payload as text, not script | no pageerror, no fetch to sentinel host, no raw <img onerror> in DOM | pageerrors=0 sentinelHits=0 xssFired=false rawTag=false |  |
| PASS | critical | demoted manager loses access from an already-open page (UI staleness) | before=200 (manager) → after in {401,403} (viewer) | before=200 after=401 |  |
| PASS | medium | pagination bar appears when contacts > 25 | .cl-pagination element visible in DOM | found=true |  |
| PASS | medium | pagination info shows correct total on page 1 | text contains "of 26" | text="Showing 1–25 of 26" |  |
| FAIL | medium | pagination advances to page 2 on Next click | info text contains "Showing 26" (the 26th item) | text="Showing 1–25 of 26" |  |
| PASS | medium | clicking a contact on page 2 navigates to /customers/:id | url matches /customers/<id> | url=http://127.0.0.1:5050/customers/pag-test-1 |  |
| FAIL | medium | returning to /customers restores page 2 from sessionStorage | pagination info still shows "Showing 26" after back-navigation | text="Showing 1–25 of 26" |  |
| FAIL | medium | filter applied on page 2 resets customer list to page 1 | pagination info shows "Showing 1–25 of 26" after filter change from page 2 | onPage2="Showing 1–25 of 26" afterFilter="Showing 1–25 of 26" filterApplied=true |  |
| FAIL | medium | lead-status filter change on page 2 resets customer list to page 1 | pagination info shows "Showing 1–" after lead-status dropdown change from page 2 | onPage2="Showing 1–25 of 26" afterFilter="" filterApplied=false |  |
| PASS | medium | pagination bar does not overflow at 360 px viewport width | scrollWidth <= clientWidth on .cl-pagination at 360 px | scrollWidth=360 clientWidth=360 |  |
| PASS | medium | pagination bar does not overflow at 360 px with 9 pages (high page-number variant) | scrollWidth <= clientWidth on .cl-pagination at 360 px with 201 contacts on page 8 | scrollWidth=360 clientWidth=360 |  |
| PASS | medium | pagination bar does not overflow at 540 px with 9 pages (tablet breakpoint variant) | scrollWidth <= clientWidth on .cl-pagination at 540 px with 201 contacts on page 8 | scrollWidth=540 clientWidth=540 |  |
| FAIL | medium | pagination bar does not overflow at 420 px with 9 pages (narrowest breakpoint) | scrollWidth <= clientWidth on .cl-pagination at 420 px with 201 contacts on page 8 | pagination bar not found |  |
| FAIL | medium | .cl-pagination-info is hidden at 420 px viewport width | display:none or not visible per computed style | pagination bar not found |  |

## Coverage notes

- The capability matrix walks the full route inventory of `auth.js`, `server.js`, `quickbooks.js`, and `visits.js` (every gate type — `isAuthenticated`, `requirePrivilege(member|manager)`, `requireManagerOrAdmin`, `requireAdmin`, `self-or-admin` — × five actors). `self-or-admin` cells target a *foreign* user id so the IDOR path is what gets exercised; happy-path self-access is covered separately in the probe log.
- Routes that depend on third-party tokens (HubSpot, Google, QuickBooks) are run with empty credentials by default; an authorized 401/503 from those handlers is bucketed as `handler-401-unverified` / `hubspot-guard-503-inconclusive` instead of a finding. Re-run with `PRIVTEST_USE_HUBSPOT_TOKEN=1 HUBSPOT_TOKEN=… npm run test:privileges` (and the analogous Google/QB pairs) to resolve those cells deterministically.
- Dedicated probe categories cover the adversarial checklist: `rate-limit` hammers `loginLimiter` (20/15min) and `accessRequestLimiter` (5/hr, shared with `/api/forgot-password`); `csrf` confirms the OAuth callbacks reject missing/forged state and that mutation routes are not reachable as GETs; `oauth` exercises stale-state and cross-user state-replay against both Google and QuickBooks callbacks; `downgrade` demotes a manager mid-session and verifies the next request reflects the new privilege level (the #290 regression class).
- A headless Puppeteer UI smoke runs `/login` → `/` → `/admin` per role: unauth bounces to `/login`, viewer/member/manager see the access-denied banner, admin loads the admin UI, and per-role browser console errors are captured. Screenshots are written to `test-results/screenshots/<runId>-<role>-{login,home,admin}.png` (plus an `unauth-admin` capture).
- Captcha enforcement: the harness strips `TURNSTILE_SECRET_KEY` by default. Set `PRIVTEST_USE_TURNSTILE_SECRET_KEY=1 TURNSTILE_SECRET_KEY=… npm run test:privileges` to pass the real key through to the spawned server — the `captcha` probe then exercises the tampering path (no-token / forged-token / empty-token logins).
- Test DB isolation: `DATABASE_URL_TEST=…` is the default contract — the harness refuses to run against the shared DATABASE_URL unless `PRIVTEST_ALLOW_SHARED_DB=1` is also set (opt-in). In shared-DB mode every synthetic row is namespaced with the `privtest-` email prefix (`users`, `allowed_emails`, `password_set_tokens`, `account_requests`, `sessions` rows whose payload references `@privtest.local`); `cleanupTestData` runs on boot, on signal exit, and on uncaught exception.

## Harness server log (tail)

```
[SECURITY] TURNSTILE_SECRET_KEY and/or TURNSTILE_SITE_KEY are not set. Captcha protection is disabled on all public auth endpoints. Set both secrets in production to enable bot and credential-stuffing protection.
  Auth (email + password) initialized

  Measure Once
  Running at: http://localhost:5050

  Could not create property measure_once_rooms: Authentication credentials not found. This API supports OAuth 2.0 authentication and you can find more details at https://developers.hubspot.com/docs/methods/auth/oauth-overview
  Could not create property measure_once_notes: Authentication credentials not found. This API supports OAuth 2.0 authentication and you can find more details at https://developers.hubspot.com/docs/methods/auth/oauth-overview
  Could not create property measure_once_stage: Authentication credentials not found. This API supports OAuth 2.0 authentication and you can find more details at https://developers.hubspot.com/docs/methods/auth/oauth-overview
  Could not create property measure_once_substage: Authentication credentials not found. This API supports OAuth 2.0 authentication and you can find more details at https://developers.hubspot.com/docs/methods/auth/oauth-overview
  Could not create property customer_number: Authentication credentials not found. This API supports OAuth 2.0 authentication and you can find more details at https://developers.hubspot.com/docs/methods/auth/oauth-overview
  Visits table ready
  Trades table ready
  Ideas tables ready
  Lead status config table ready
  Stage action labels table ready
  Stage action labels defaults seeded
  Lead sub-statuses table ready
  hw_test_user HubSpot property ready (dev)
  hw_lead_substatus HubSpot property ready
  hw_lead_substatus options synced
  Card action handlers tables ready
  Search settings table ready
  Workshop settings table ready
  App settings table ready
  WhatsApp messages table ready
  Design visit tables ready
QB invoices error: QuickBooks not connected
QB invoice detail error: QuickBooks not connected
  SMTP not configured — skipping set-password email for privtest-viewer-jhmoan@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=171786eb7ea9d10a1487197ae5f7c7aff0f41fff3527ed54cc96bc484b62a72b
  Password reset link issued for privtest-viewer-jhmoan@privtest.local
[set-password] Cleared 1 other session(s) for privtest-viewer-jhmoan@privtest.local.
[change-password] Cleared 1 other session(s) for privtest-viewer-jhmoan@privtest.local.
[change-password] Cleared 1 other session(s) for privtest-member-jhmoan@privtest.local.
  SMTP not configured — skipping set-password email for privtest-member-jhmoan@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=f185c5b4843a48b40beaa032547bd20fe8523e9349235c2763e879a45fa83de9
[change-password] Cleared 2 other session(s) for privtest-manager-jhmoan@privtest.local.
  SMTP not configured — skipping set-password email for privtest-lifecycle-jhmoan@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=858ca61f32e6811ab557d9d3f0a9522ff7fe852dae7bdf2f159c6d0355765b71
  SMTP not configured — skipping set-password email for privtest-lifecycle-jhmoan@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=1c47fbe33e6adbd3c01af17de5be56d2b1d22530b3f995eca7b8ae51d771504c
  SMTP not configured — skipping set-password email for privtest-lifecycle-jhmoan@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=ecd7cc746e073bf7c2db5800ab9487c6c101b3b1e4611fcf82098823d0ec642d
  SMTP not configured — skipping set-password email for privtest-req-jhmoan@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=91512ab9efb45583532cd83ed0c395b636d5edf3889a9cb6f3178fb338e3bd9e
  SMTP not configured — skipping set-password email for privtest-req-jhmoan@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=55246fc89f812c75c7ae3aaab8a97ebf5f4f9c031f2b0fe698ee351709f00408
  SMTP not configured — skipping set-password email for privtest-req-jhmoan@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=5349b6b00d97cf5b2d9264560f7813967c21aa6730ec56d02a586f41a0c864a4
  Access request: X');fetch('https://x')//@xss-jhmoan.bc <privtest-xss-jhmoan@privtest.local>
  SMTP not configured — skipping set-password email for privtest-xss-note-jhmoan@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=3867c3369db293fa5df862d2eae5938e911bb48ad1c448abcdd2b25e786b4dba
  Access request: Rate Test <privtest-rl0-jhmoan@privtest.local>
  Access request: Rate Test <privtest-rl1-jhmoan@privtest.local>
  Access request: Rate Test <privtest-rl2-jhmoan@privtest.local>
  Access request: Rate Test <privtest-rl3-jhmoan@privtest.local>
  Access request: Rate Test <privtest-rl4-jhmoan@privtest.local>
  SMTP not configured — skipping set-password email for privtest-viewer-jhmoan@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=5d5b637e3681402f63136296f2ecaa45a2837e3bde15ffae7fb18eea8bf9e313
  Password reset link issued for privtest-viewer-jhmoan@privtest.local
  SMTP not configured — skipping set-password email for privtest-viewer-jhmoan@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=fd51972070b4d238aeee9f75cf9eb5265fa6f6977978a6fb3d8bc44e07ff7dd7
  Password reset link issued for privtest-viewer-jhmoan@privtest.local
  SMTP not configured — skipping set-password email for privtest-viewer-jhmoan@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=b02ab51ec033c8694076e83d2ebf4e4c00cb6b16169cd743affaa3d1267310af
  Password reset link issued for privtest-viewer-jhmoan@privtest.local
  SMTP not configured — skipping set-password email for privtest-viewer-jhmoan@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=2d562446578ddfdd24cbf3de9c00314b9059697469a813ed62db0b4e02851dce
  Password reset link issued for privtest-viewer-jhmoan@privtest.local
  SMTP not configured — skipping set-password email for privtest-viewer-jhmoan@privtest.local.
  Set-password link (manual delivery): http://127.0.0.1:5050/set-password?token=7ae173c99a0247aee555d9acc44a722d3c5175cb32d6fc354204704b6053a440
  Password reset link issued for privtest-viewer-jhmoan@privtest.local

```
