# Threat Model

## Project Overview

Measure Once is a Node.js 20 + Express dashboard that serves a static frontend from `public/` and exposes business APIs from `server.js`. The application uses local email/password authentication in `auth.js` with Passport-backed server sessions stored in PostgreSQL, HubSpot for CRM records and workflow storage, Google OAuth for per-session Gmail and Calendar access, and QuickBooks OAuth for organization-wide invoice access. Production scope is the publicly deployed Express app; mock or sandbox-only assumptions do not apply unless an area is clearly unreachable in production.

Platform assumptions for future scans: production traffic is TLS-protected by the platform; `NODE_ENV` is `production`; mockup sandboxes are not deployed; only production-reachable weaknesses should be reported.

## Assets

- **User accounts and sessions** — approved-user records, password hashes, password-set tokens, session cookies, Passport session rows, and role data in `users`. Compromise enables impersonation and persistent access to protected business data.
- **Administrative access-control data** — `allowed_emails`, `account_requests`, `ADMIN_EMAILS`, role assignments, and admin audit history. Tampering here changes who can access the application and who has elevated privileges.
- **Business CRM data** — HubSpot contacts, deals, notes, workflow state, tasks, customer contact details, and stage history. This includes PII and operational data used to run customer projects.
- **External integration credentials and tokens** — HubSpot private token, Google OAuth tokens stored in the user session, and QuickBooks OAuth tokens stored in PostgreSQL. Compromise or misuse exposes third-party accounts and can modify external business records.
- **Financial records** — QuickBooks invoice metadata, customer emails, due dates, PDFs, line items, and send actions. Unauthorized access or modification can disrupt billing or send fraudulent communications.
- **Local application data** — `workflow.json` and `data/__personal_tasks.json`. These are server-side files but currently influence shared application behavior and user-visible data.

## Trust Boundaries

- **Browser to Express server** — all client input is untrusted. Every route must authenticate, authorize, and validate request bodies, params, and query strings.
- **Public user to approved-user boundary** — public routes such as login, access-request, forgot-password, and set-password must not allow account takeover, onboarding bypass, or privilege escalation.
- **Approved user to admin boundary** — only admins should manage access control, user lifecycle, finance-sensitive actions, and organization-wide integrations. Non-admin users remain lower-trust after login.
- **Express server to PostgreSQL** — the app stores sessions, users, access requests, password-set tokens, and QuickBooks tokens in the database. Any broken auth or injection bug at the server boundary can expose or tamper with durable auth state.
- **Express server to HubSpot** — the server uses a bearer token with broad CRM privileges. Server-side authorization bugs can expose or mutate CRM records for all customers.
- **Express server to Google APIs** — Gmail and Calendar access depends on OAuth tokens stored in the acting user's session. OAuth callback integrity and session binding are security-sensitive.
- **Express server to QuickBooks APIs** — QuickBooks access is organization-wide and backed by a single stored token set. OAuth callback integrity plus strict authorization around invoice read/write/send flows are security-critical.
- **Shared server data to per-user UI boundary** — data labeled or presented as personal must be scoped server-side to the acting user, not just partitioned in the frontend.

## Scan Anchors

- **Production entry points:** `server.js`, `auth.js`, `quickbooks.js`, `visits.js`, static client in `public/`.
 - **Highest-risk areas:** auth/session lifecycle in `auth.js`; public auth routes (`/api/login`, `/api/request-access`, `/api/forgot-password`, `/api/set-password*`); admin/access-control routes in `auth.js`; profile-photo upload/approval/delivery routes in `auth.js`; Google and QuickBooks OAuth callbacks in `server.js` and `quickbooks.js`; organization-wide QuickBooks invoice routes in `quickbooks.js`; design-visit mutation routes and sign-off side effects in `design-visits.js`; client-side admin rendering in `public/admin.html`; shared HubSpot mutation routes in `server.js`, especially task mutation endpoints.
 - **Surface split:** public routes include `/login`, `/set-password`, `/onboarding`, `/api/login`, `/api/request-access`, `/api/check-email`, `/api/forgot-password`, `/api/set-password`, `/api/set-password/validate`, `/api/turnstile-config`, and the public design-visit sign-off endpoints. Most `/api/*` routes are behind the global `isAuthenticated` gate in `server.js`; `/api/admin/*` also require `requireAdmin`; QuickBooks connect, disconnect, and invoice read/write/send routes are admin-only in the current code; member-accessible design-visit routes deserve separate review because they can trigger HubSpot and customer-signoff side effects.
 - **Production-scope observations from this scan:** the QuickBooks integration uses one shared tenant token for the whole org, but direct invoice read/write/PDF/send routes are currently admin-only; revoking a user from `allowed_emails` now invalidates live sessions; the public auth Turnstile flow fails closed on missing tokens and verification outages when configured; `BOOTSTRAP_ADMIN_PASSWORD` remains a standing alternate login path for any address in `ADMIN_EMAILS` whenever that secret is set, and the consumed-token history used to retire it is not durably preserved once old `password_set_tokens` rows are cleaned up; `/api/set-password` now rechecks and consumes reset/set-password tokens transactionally, so the earlier replay-race concern appears mitigated; the approved profile-photo flow now restricts uploads to JPEG/PNG/WebP/GIF and serves them as attachments with `nosniff`, so the earlier active-SVG concern appears mitigated; `DELETE /api/tasks/:id` now includes the contact-binding/object-authorization check present on task updates; generic `innerHTML` use in `public/admin.html` and the reviewed client surfaces currently relies on context-safe escaping and fixed-format identifiers; trade-company website links in `public/admin.html` and `public/trades.js` enforce `http:`/`https:` allowlists on both server and client; WhatsApp routes in `server.js` are admin-only in the current code; design-visit submission and resubmission currently trust client-supplied `handlerConfig` for HubSpot lead-status side effects, and `POST /api/design-visits/:id/revision` is only member-gated despite an admin-only UI affordance.
- **Dev-only areas:** the `/__mockup` localhost proxy in `server.js` is out of production scope unless future evidence shows the mockup sandbox is actually reachable in production. Local-development redirect fallbacks such as localhost Google OAuth defaults remain dev-only unless proven otherwise.

## Threat Categories

### Spoofing

The app relies on local email/password authentication for primary identity and separate OAuth flows for Google and QuickBooks. Password-set and reset links must stay single-use and bound to the intended account, authentication callbacks must be bound to the correct user session, and revoked users must not continue operating on stale sessions.

### Tampering

Authenticated users can update shared workflow state, HubSpot notes, tasks, and some invoice fields. The server must ensure only appropriately privileged users can modify shared business configuration, customer records, organization-wide finance data, or external integrations. Files such as `workflow.json` and any local task storage must not let one user overwrite data belonging to other users or the organization without explicit authorization.

### Information Disclosure

The dashboard exposes customer PII, CRM notes, task data, calendar data, internal user records, and financial invoice details. Responses must be scoped to the correct user and role, and logs or error messages must not leak secrets, tokens, or more customer data than necessary. Organization-wide finance data should not be broadly readable just because a user is generally approved.

### Denial of Service

Public or lightly protected routes that mutate shared integration state or trigger external API work can disrupt business operations. The application must prevent unauthenticated users from flooding access-request or account-recovery routes, and it must place meaningful abuse controls around authenticated shared-work endpoints such as `/api/localdata/all`, `/api/visits`, and QuickBooks invoice send actions. External API calls should keep timeouts, and public request surfaces should avoid easy abuse.

### Elevation of Privilege

The main privilege boundary is between unauthenticated users, approved users, and admins, with additional sensitivity around finance and org-wide integrations. A low-privilege approved user must not gain admin-equivalent influence by persisting stale sessions after revocation, injecting script into shared admin UI, or controlling organization-wide external integrations and invoice operations. All privileged actions must be enforced server-side rather than inferred from which UI links are shown.