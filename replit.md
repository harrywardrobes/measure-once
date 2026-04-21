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

## Required Secrets (optional, for full functionality)
- `HUBSPOT_TOKEN` — HubSpot private app token (otherwise `/api/*` endpoints return 503)
- `SESSION_SECRET` — express-session secret
- `GOOGLE_*` — Google OAuth credentials for calendar integration
