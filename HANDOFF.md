# Harry Wardrobes CRM — Session Handoff

## What was built
A custom project management web app that uses HubSpot as the backend, with Gmail and Google Calendar integration. It replaces the Excel workflow spreadsheet with a live Kanban board.

## Project location
```
C:\Users\User\Projects\harry-wardrobes-crm\
```
> ⚠️ Do NOT move this to H:\My Drive\ (Google Drive) — npm install fails due to Drive syncing conflicts.

## Tech stack
- **Backend:** Node.js + Express (`server.js`)
- **Frontend:** Vanilla HTML/CSS/JS + Tailwind CSS CDN (`public/`)
- **HubSpot:** REST API v3 via Private App token
- **Google:** OAuth2 for Gmail + Calendar (`googleapis` npm package)
- **Port:** 3456

## File structure
```
harry-wardrobes-crm/
├── server.js          ← Express server — all API proxying lives here
├── package.json
├── workflow.json      ← The 9-stage checklists (editable in-app)
├── .env               ← Exists but HUBSPOT_TOKEN needs replacing (see below)
├── .env.example       ← Template
├── README.md
└── public/
    ├── index.html     ← App shell (Tailwind CDN, modals, tabs)
    ├── app.js         ← All frontend logic (Kanban, checklist, Gmail, Calendar)
    └── style.css      ← Custom styles
```

## Current status
- ✅ App installs and runs (`npm run dev`)
- ✅ UI renders correctly (Kanban board, deal panel, checklist tabs)
- ❌ HubSpot token invalid — needs replacing (see below)
- ❌ Google not connected yet (optional step after HubSpot is working)

## ⚠️ The one thing needed to make it work: HubSpot Private App token

The `.env` currently has an expired CLI access token. Replace it with a **Private App token**:

1. Go to: **https://app-eu1.hubspot.com/private-apps/146683693**
2. Click **Create a private app**
3. Name it e.g. `Wardrobe Dashboard`
4. Under **Scopes**, add:
   - `crm.objects.deals.read` + `crm.objects.deals.write`
   - `crm.objects.contacts.read`
   - `crm.objects.notes.read` + `crm.objects.notes.write`
   - `crm.pipelines.orders.read`
5. Click **Create app** → copy the token (starts with `pat-eu1-...`)
6. Open `C:\Users\User\Projects\harry-wardrobes-crm\.env`
7. Replace the `HUBSPOT_TOKEN=` line with the new token
8. Restart the server

## HubSpot account details
- **Portal ID:** 146683693
- **UI Domain:** app-eu1.hubspot.com (EU server)
- **Email:** harry@harrywardrobes.co.uk
- **Name:** Harry Gautier
- **Currency:** GBP

## How to run
```bash
cd C:\Users\User\Projects\harry-wardrobes-crm
npm run dev
```
Then open: http://localhost:3456

## HubSpot pipeline stages (from the spreadsheet)
The app auto-matches HubSpot stage names to these workflow keys. Name your HubSpot pipeline stages:
1. Sales
2. Design Visit
3. Survey
4. Order
5. Workshop
6. Packing
7. Delivery
8. Installation
9. Aftercare

## How Google (Gmail + Calendar) works
- Click **+ Connect Google** in the top nav bar
- Redirects to Google OAuth consent screen
- Tokens stored in Express session
- Shows email threads per customer and upcoming calendar events
- Can send emails and create calendar events from within the app

### To set up Google OAuth (do this after HubSpot is working):
1. Go to https://console.cloud.google.com
2. Create project → Enable **Gmail API** and **Google Calendar API**
3. APIs & Services → Credentials → Create OAuth 2.0 Client ID
4. Application type: **Web application**
5. Authorised redirect URI: `http://localhost:3456/auth/google/callback`
6. Copy Client ID and Secret into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

## How checklists work
- Each deal has a checklist per pipeline stage (e.g. Survey has 8 tasks)
- Task completion is saved as a HubSpot Note on the deal (prefixed `WORKFLOW_CHECKLIST:`)
- In-app you can edit the default tasks per stage via **Checklist → Edit tasks**
- Edits save to `workflow.json`

## Other tools the user uses
- **HubSpot** — contacts, deals, pipeline (this app is the frontend)
- **Zapier** — new lead automations (runs independently, no change needed)
- **Gmail** — integrated via Google OAuth in this app
- **Google Calendar** — integrated via Google OAuth in this app
- **QuickBooks** — for estimates/invoices (referenced in checklists, no direct integration yet)
