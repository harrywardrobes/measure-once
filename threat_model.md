# Threat Model

## Project Overview

Measure Once is a Node.js 20 + Express dashboard that serves a static frontend from `public/` and exposes business APIs from `server.js`. The application uses local email/password authentication in `auth.js` with Passport-backed server sessions stored in PostgreSQL, HubSpot for CRM records and workflow storage, Google OAuth for per-session Gmail and Calendar access, and QuickBooks OAuth for organization-wide invoice access. Production scope is the publicly deployed Express app; mock or sandbox-only assumptions do not apply unless an area is clearly unreachable in production.

Platform assumptions for future scans: production traffic is TLS-protected by the platform; `NODE_ENV` is `production`; mockup sandboxes are not deployed; only production-reachable weaknesses should be reported.

## Assets

- **User accounts and sessions** — approved-user records, password hashes, password-set tokens, session cookies, Passport session rows, and role data in `users`. Compromise enables impersonation and persistent access to protected business data.
- **Administrative access-control data** — `allowed_emails`, `account_requests`, `ADMIN_EMAILS`, role assignments, and admin audit history. Tampering here changes who can access the application and who has elevated privileges.
- **Business CRM data** — HubSpot contacts, deals, notes, workflow state, tasks, customer contact details, customer-info submissions, design-visit details, and stage history. This includes PII and operational data used to run customer projects.
- **External integration credentials and tokens** — HubSpot private token, Google OAuth tokens stored in the user session, and QuickBooks OAuth tokens stored in PostgreSQL. Compromise or misuse exposes third-party accounts and can modify external business records.
- **Financial records** — QuickBooks invoice metadata, customer emails, due dates, PDFs, line items, and send actions. Unauthorized access or modification can disrupt billing or send fraudulent communications.
- **Public bearer links and uploaded media** — customer-info `form_link` URLs, design-visit sign-off links, signed photo URLs, and stored room/customer photos. Possession of these links can grant read or write access without an authenticated app session.
- **Local application data** — `workflow.json` and `data/__personal_tasks.json`. These are server-side files but currently influence shared application behavior and user-visible data.

## Trust Boundaries

- **Browser to Express server** — all client input is untrusted. Every route must authenticate, authorize, and validate request bodies, params, and query strings.
- **Public user to approved-user boundary** — public routes such as login, access-request, forgot-password, set-password, customer-info token endpoints, and design-visit sign-off must not allow account takeover, onboarding bypass, or unintended disclosure/tampering via bearer links.
- **Approved user to admin boundary** — only admins should manage access control, user lifecycle, finance-sensitive actions, and organization-wide integrations. Non-admin users remain lower-trust after login.
- **Viewer/member role boundary** — low-privilege approved users must not be able to read or act on customer submissions, signed media, or bearer URLs that let them impersonate customers or influence shared workflow state.
- **Express server to PostgreSQL** — the app stores sessions, users, access requests, password-set tokens, customer-info submissions, design visits, sign-off tokens, and QuickBooks tokens in the database. Any broken auth or injection bug at the server boundary can expose or tamper with durable auth state.
- **Express server to HubSpot** — the server uses a bearer token with broad CRM privileges. Server-side authorization bugs can expose or mutate CRM records for all customers.
- **Express server to Google APIs** — Gmail and Calendar access depends on OAuth tokens stored in the acting user's session. OAuth callback integrity and session binding are security-sensitive.
- **Express server to QuickBooks APIs** — QuickBooks access is organization-wide and backed by a single stored token set. OAuth callback integrity plus strict authorization around invoice read/write/send flows are security-critical.
- **Shared server data to per-user UI boundary** — data labeled or presented as personal or customer-specific must be scoped server-side to the acting user and role, not just partitioned in the frontend.

## Scan Anchors

- **Production entry points:** `server.js`, `auth.js`, `quickbooks.js`, `customer-info.js`, `photo-reviews.js`, `design-visits.js`, `visits.js`, `views/admin.ejs`, the static client in `public/`, and React islands in `src/react/`.
- **Highest-risk areas:** auth/session lifecycle in `auth.js`; public auth routes (`/api/login`, `/api/request-access`, `/api/forgot-password`, `/api/set-password*`); admin/access-control routes in `auth.js`; customer-info submission read/resend/review routes in `customer-info.js` and `photo-reviews.js`; public design-visit sign-off GET/POST flows and side effects in `design-visits.js`; Google and QuickBooks OAuth callbacks in `server.js` and `quickbooks.js`; organization-wide QuickBooks invoice routes in `quickbooks.js`; shared HubSpot mutation routes in `server.js`, especially task and contact mutation endpoints; and server-rendered/admin client rendering in `views/admin.ejs` and `src/react/pages/admin/adminApi.ts`.
- **Surface split:** public routes include `/login`, `/set-password`, `/onboarding`, `/api/login`, `/api/request-access`, `/api/check-email`, `/api/forgot-password`, `/api/set-password`, `/api/set-password/validate`, `/api/turnstile-config`, the public customer-info token endpoints, and the public design-visit sign-off endpoints. Most `/api/*` routes are behind the global `isAuthenticated` gate in `server.js`; `/api/admin/*` also require `requireAdmin`; QuickBooks connect, disconnect, and invoice read/write/send routes are admin-only in the current code; the customer-info review surfaces are reachable to authenticated viewers and therefore need explicit role checks plus careful handling of any bearer-style `form_link` values they expose.
- **Production-scope observations from this scan:** the QuickBooks integration uses one shared tenant token for the whole org, but direct invoice read/write/PDF/send routes are currently admin-only; Google OAuth state handling and Gmail/Calendar token use remain session-bound to the authenticated user; revoking a user from `allowed_emails` now invalidates live sessions, but addresses left in `ADMIN_EMAILS` still bypass normal allow-list revocation and continue to qualify for login/reset flows until operators remove them from the environment as well; the public auth Turnstile flow fails closed on missing tokens and verification outages when configured; `/api/set-password` now rechecks and consumes reset/set-password tokens transactionally, so the earlier replay-race concern there appears mitigated; the approved profile-photo flow now restricts uploads to JPEG/PNG/WebP/GIF and serves them as attachments with `nosniff`, so the earlier active-SVG concern appears mitigated; `DELETE /api/tasks/:id` now includes the contact-binding/object-authorization check present on task updates; the reviewed admin/client `innerHTML` sinks currently rely on static templates, fixed-format identifiers, or numeric counts rather than attacker-controlled HTML; trade-company website links in the reviewed admin/trades surfaces enforce `http:`/`https:` allowlists on both server and client; WhatsApp routes in `server.js` are admin-only in the current code; design-visit submission and resubmission now gate client-supplied `handlerConfig.submittedLeadStatus` behind a server-side manager/admin privilege check in `runSubmitSideEffects`; `POST /api/design-visits/:id/revision` is now admin-only (`requirePrivilege('admin')`), matching its UI affordance; the previously suspected member-facing design-visit CRUD and upload-delete ownership gaps reviewed in this scan appear fixed; and remaining confirmed risks are the `ADMIN_EMAILS` deprovisioning bypass in `auth.js` plus the non-atomic public customer-info submission flow in `customer-info.js`.
- **Dev-only areas:** the `/__mockup` localhost proxy in `server.js` is out of production scope unless future evidence shows the mockup sandbox is actually reachable in production. Local-development redirect fallbacks such as localhost Google OAuth defaults remain dev-only unless proven otherwise.

## Threat Categories

### Spoofing

The app relies on local email/password authentication for primary identity and separate OAuth flows for Google and QuickBooks. Password-set and reset links must stay single-use and bound to the intended account, authentication callbacks must be bound to the correct user session, and revoked users must not continue operating on stale sessions. Public bearer links such as customer-info forms and design-visit sign-off tokens must also remain tightly scoped, short-lived, and single-purpose so possession of an old link does not let someone pose as a customer or reopen access to sensitive material.

### Tampering

Authenticated users can update shared workflow state, HubSpot notes, tasks, and some invoice fields. The server must ensure only appropriately privileged users can modify shared business configuration, customer records, organization-wide finance data, or external integrations. Public token flows must consume tokens atomically so concurrent requests cannot race each other into conflicting state changes. Files such as `workflow.json` and any local task storage must not let one user overwrite data belonging to other users or the organization without explicit authorization.

### Information Disclosure

The dashboard exposes customer PII, CRM notes, task data, calendar data, internal user records, customer-uploaded photos, design-visit summaries, and financial invoice details. Responses must be scoped to the correct user and role, and logs or error messages must not leak secrets, tokens, or more customer data than necessary. Organization-wide finance data should not be broadly readable just because a user is generally approved, and public bearer links must not keep exposing current customer data after they are superseded or should have expired.

### Denial of Service

Public or lightly protected routes that mutate shared integration state or trigger external API work can disrupt business operations. The application must prevent unauthenticated users from flooding access-request or account-recovery routes, and it must place meaningful abuse controls around authenticated shared-work endpoints such as `/api/localdata/all`, `/api/visits`, and QuickBooks invoice send actions. External API calls should keep timeouts, and public request surfaces should avoid easy abuse.

### Elevation of Privilege

The main privilege boundary is between unauthenticated users, approved users, and admins, with additional sensitivity around finance and org-wide integrations. A low-privilege approved user must not gain higher-impact influence by persisting stale sessions after revocation, disclosing bearer links that let them impersonate customers, injecting script into shared admin UI, or controlling organization-wide external integrations and invoice operations. All privileged actions must be enforced server-side rather than inferred from which UI links are shown.
