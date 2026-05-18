# Threat Model

## Project Overview

Measure Once is a Node.js 20 + Express dashboard that serves a static frontend from `public/` and exposes business APIs from `server.js`. The application integrates with Replit Auth for primary authentication, PostgreSQL for sessions and access-control data, HubSpot for CRM records and workflow storage, Google OAuth for per-session Gmail/Calendar access, and QuickBooks OAuth for invoice access. Production scope is the deployed Express app; mock or sandbox-only assumptions do not apply unless an area is clearly unreachable in production.

Platform assumptions for future scans: production traffic is TLS-protected by the platform; `NODE_ENV` is `production`; mockup sandboxes are not deployed; only production-reachable weaknesses should be reported.

## Assets

- **User accounts and sessions** — Replit-authenticated sessions, session cookies, refresh tokens, and the allow-list of approved users. Compromise enables impersonation and access to all protected business data.
- **Business CRM data** — HubSpot contacts, deals, notes, workflow state, tasks, customer contact details, and stage history. This includes PII and operational data used to run customer projects.
- **External integration credentials and tokens** — HubSpot private token, Google OAuth tokens stored in session, and QuickBooks OAuth tokens stored in PostgreSQL. Compromise or misuse exposes third-party accounts and can modify external business records.
- **Financial records** — QuickBooks invoice metadata, customer emails, due dates, PDFs, and send actions. Unauthorized access or modification can disrupt billing or send fraudulent communications.
- **Local application data** — `workflow.json` and `data/__personal_tasks.json`. These are server-side files but currently influence shared application behavior and user-visible data.
- **Administrative access-control data** — `allowed_emails`, `account_requests`, and `ADMIN_EMAILS`-derived admin status. Tampering here changes who can access the application.

## Trust Boundaries

- **Browser to Express server** — All client input is untrusted. Every route must authenticate, authorize, and validate request bodies, params, and query strings.
- **Express server to PostgreSQL** — The app stores sessions, users, access requests, and QuickBooks tokens in the database. Any broken auth or injection bug at the server boundary can expose or tamper with durable auth state.
- **Express server to HubSpot** — The server uses a bearer token with broad CRM privileges. Server-side authorization bugs can expose or mutate CRM records for all customers.
- **Express server to Google APIs** — Gmail and Calendar access depends on OAuth tokens stored in the user session. OAuth callback integrity and session binding are security-sensitive.
- **Express server to QuickBooks APIs** — QuickBooks access is organization-wide and backed by a single stored token set. OAuth callback integrity and authorization for connect/disconnect flows are security-critical.
- **Authenticated user to admin boundary** — Only admins should manage access-control decisions. Non-admin users are lower-trust even after login.
- **Shared server data to per-user UI boundary** — Data labeled or presented as personal must be scoped server-side to the acting user, not just partitioned in the frontend.

## Scan Anchors

- **Production entry points:** `server.js`, `auth.js`, `quickbooks.js`, `visits.js`, static client in `public/`.
- **Highest-risk areas:** OAuth callbacks and token persistence (`auth.js`, Google routes in `server.js`, QuickBooks routes in `quickbooks.js`); admin/access-control routes in `auth.js`; shared local file storage and workflow config in `server.js`; client HTML sinks in `public/app.js`; abuse-prone shared-work endpoints such as `POST /api/request-access`, `GET /api/localdata/all`, and `POST /api/quickbooks/invoice/:id/send`.
- **Surface split:** Public routes include `/api/login`, `/api/callback`, `/api/request-access`, `/auth/google*`, and static assets. Most `/api/*` routes are behind `isAuthenticated`; `/api/admin/*` also require `requireAdmin`; QuickBooks connect/disconnect routes require admin but invoice operations currently do not.
- **Dev-only areas:** None identified so far beyond local development defaults such as localhost redirect fallback values. Reassess only if a route is proven unreachable in production.

## Threat Categories

### Spoofing

The app relies on Replit OIDC for primary identity and separate OAuth flows for Google and QuickBooks. Authentication callbacks must be bound to the correct user/session, and global integrations must not be connectable or replaceable by unauthenticated users. Session cookies must remain hard to steal or replay, and protected routes must not trust frontend state.

### Tampering

Authenticated users can update workflow state, HubSpot notes, tasks, and invoice details. The server must ensure only authorized users can modify shared business configuration, customer records, or organization-wide integrations. Files such as `workflow.json` and any local task storage must not let one user overwrite data belonging to other users or the organization without explicit authorization.

### Information Disclosure

The dashboard exposes customer PII, CRM notes, task data, calendar data, and financial invoice details. Responses must be scoped to the correct user and role, and logs or error messages must not leak secrets, tokens, or more customer data than necessary. Data presented as personal must not be globally readable by other authenticated users.

### Denial of Service

Public or lightly protected routes that mutate shared integration state or trigger external API work can disrupt business operations. The application must prevent unauthenticated users from flooding `POST /api/request-access`, and it must place meaningful abuse controls around authenticated shared-work endpoints such as `GET /api/localdata/all`, `POST /api/visits`, and `POST /api/quickbooks/invoice/:id/send`. External API calls should keep timeouts, and public request surfaces should avoid easy abuse.

### Elevation of Privilege

The main privilege boundary is between unauthenticated users, approved users, and admins. A low-privilege approved user must not gain admin-equivalent influence by modifying global configuration, injecting script into shared UI, or controlling organization-wide external integrations. All privileged actions must be enforced server-side rather than inferred from which UI links are shown.
