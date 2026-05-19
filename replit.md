# Measure Once

Project management dashboard (HubSpot CRM integration).

## Stack
- Node.js 20 + Express
- Static frontend in `public/` (vanilla JS + Tailwind via CDN)
- Single server file: `server.js` serves both API and static assets

## Replit Setup
- Workflow: `Start application` runs `npm start`
- Server binds to `0.0.0.0:5000` (PORT env var override supported)
- Deployment: VM target, `node server.js`

## Authentication
Replit Auth (OpenID Connect) is wired in via `auth.js`. Login/logout endpoints:
- `GET /api/login` — start login
- `GET /api/callback` — OIDC callback
- `POST /api/logout` — log out
- `GET /api/auth/user` — current user (requires session)

Sessions and users are stored in PostgreSQL (`sessions` and `users` tables, auto-created on boot). Protect routes by importing `isAuthenticated` from `./auth` and adding it as middleware.

## Required Secrets
- `DATABASE_URL`, `SESSION_SECRET`, `REPL_ID`, `REPLIT_DOMAINS` — provided by Replit; required for auth
- `HUBSPOT_TOKEN` — HubSpot private app token (otherwise `/api/*` HubSpot endpoints return 503)
- `GOOGLE_*` — Google OAuth credentials for calendar integration
