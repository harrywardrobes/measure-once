require('dotenv').config();
const express = require('express');
const axios = require('axios').create({ timeout: 10000 });
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { installSession, setupAuth, isAuthenticated, requireAdmin, requireManagerOrAdmin, userIdExists } = require('./auth');
const qbRoutes = require('./quickbooks');
const { router: visitsRouter, ensureVisitsTable } = require('./visits');

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

function validateHsObjectId(value, fieldName) {
  if (value === undefined || value === null) return null;
  const id = String(value).trim();
  if (!/^\d+$/.test(id)) {
    const err = new Error(`${fieldName} must be a numeric ID`);
    err.status = 400;
    throw err;
  }
  return id;
}

// ── Mockup sandbox proxy ───────────────────────────────────────────────────────
const http = require('http');
const MOCKUP_PORT = 23636;
app.use('/__mockup', (req, res) => {
  const target = '/__mockup' + (req.url || '/');
  const options = {
    hostname: 'localhost',
    port: MOCKUP_PORT,
    path: target,
    method: req.method,
    headers: { ...req.headers, host: `localhost:${MOCKUP_PORT}` },
  };
  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on('error', () => res.status(502).send('Mockup sandbox not running'));
  req.pipe(proxy, { end: true });
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());

// Clean URLs for each page (no .html extension). Must precede express.static so the
// extensionless paths win over any default static-index handling.
const PAGE_ROUTES = {
  '/':          'index.html',
  '/sales':     'sales.html',
  '/customers': 'customers.html',
  '/projects':  'projects.html',
  '/calendar':  'calendar.html',
  '/invoices':  'invoices.html',
  '/profile':   'profile.html',
  '/admin':     'admin.html',
};

// /trades is protected — handled below after auth middleware is set up
for (const [route, file] of Object.entries(PAGE_ROUTES)) {
  app.get(route, (_req, res) => res.sendFile(path.join(__dirname, 'public', file)));
}

// Dynamic customer detail page
app.get('/customers/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'customer-detail.html'));
});

app.use(express.static(path.join(__dirname, 'public')));
installSession(app);

// ── HubSpot ───────────────────────────────────────────────────────────────────
const HS = 'https://api.hubapi.com';
const hsHeaders = () => ({
  Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
  'Content-Type': 'application/json'
});

// Guard: return a clear error if no token is set
function requireHubspotToken(req, res, next) {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    return res.status(503).json({
      error: 'HUBSPOT_ACCESS_TOKEN is not set. Add it to your .env file and restart the server.'
    });
  }
  next();
}
// QuickBooks routes (auth enforced inside the router)
app.use(qbRoutes);
app.use(visitsRouter);

// Replit Auth gate for all /api/* routes (whitelist auth-flow endpoints).
const AUTH_WHITELIST = new Set(['/login', '/callback', '/auth/user', '/request-access']);
app.use('/api', (req, res, next) => {
  if (AUTH_WHITELIST.has(req.path)) return next();
  return isAuthenticated(req, res, next);
});

app.use('/api/pipeline', requireHubspotToken);
app.use('/api/deals', requireHubspotToken);
app.use('/api/contacts', requireHubspotToken);
app.use('/api/account', requireHubspotToken);
app.use('/api/open-leads', requireHubspotToken);
app.use('/api/contacts-all', requireHubspotToken);
app.use('/api/tasks', requireHubspotToken);
app.use('/api/workflow-stages', requireHubspotToken);
app.use('/api/localdata', requireHubspotToken);

// ── HubSpot Custom Properties (workflow data stored on contacts) ──────────────
// Creates measure_once_rooms and measure_once_notes properties if they don't exist
async function ensureHubSpotProperties() {
  const props = [
    { name: 'measure_once_rooms',    label: 'Measure Once Rooms',    fieldType: 'textarea', type: 'string', description: 'JSON workflow rooms data (Measure Once CRM)' },
    { name: 'measure_once_notes',    label: 'Measure Once Notes',    fieldType: 'textarea', type: 'string', description: 'Customer notes (Measure Once CRM)' },
    { name: 'measure_once_stage',    label: 'Measure Once Stage',    fieldType: 'text',     type: 'string', description: 'Current workflow stage (Measure Once CRM)' },
    { name: 'measure_once_substage', label: 'Measure Once Substage', fieldType: 'text',     type: 'string', description: 'Current workflow substage/task (Measure Once CRM)' },
    { name: 'customer_number',       label: 'Customer Number',       fieldType: 'text',     type: 'string', description: 'Unique customer number (e.g. LL01234) — Measure Once CRM' },
  ];
  for (const prop of props) {
    try {
      await axios.post(
        `${HS}/crm/v3/properties/contacts`,
        { ...prop, groupName: 'contactinformation' },
        { headers: hsHeaders() }
      );
      console.log(`  Created HubSpot property: ${prop.name}`);
    } catch (e) {
      if (e.response?.status !== 409) {
        console.warn(`  Could not create property ${prop.name}: ${e.response?.data?.message || e.message}`);
      }
    }
  }
}

// Read one contact's workflow data from HubSpot custom properties
app.get('/api/contacts/:id/localdata', async (req, res) => {
  const contactId = req.params.id;
  if (typeof contactId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(contactId)) {
    return res.status(400).json({ error: 'Invalid contact id.' });
  }

  try {
    const r = await axios.get(
      `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
      { headers: hsHeaders(), params: { properties: 'measure_once_rooms,measure_once_notes' } }
    );
    const roomsJson = r.data.properties?.measure_once_rooms;
    const notes     = r.data.properties?.measure_once_notes || '';
    if (!roomsJson) return res.json(null);
    const rooms = JSON.parse(roomsJson);
    return res.json({ rooms, notes });
  } catch { return res.json(null); }
});

// Save one contact's workflow data to HubSpot custom properties
app.post('/api/contacts/:id/localdata', async (req, res) => {
  try {
    const { rooms, notes, stage, substage } = req.body;
    const contactId = req.params.id;
    if (!/^[A-Za-z0-9_-]+$/.test(contactId)) {
      return res.status(400).json({ error: 'Invalid contact id' });
    }
    await axios.patch(
      `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
      {
        properties: {
          measure_once_rooms:    JSON.stringify(rooms),
          measure_once_notes:    notes    || '',
          measure_once_stage:    stage    || '',
          measure_once_substage: substage || '',
        }
      },
      { headers: hsHeaders() }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read all contacts' stage summaries from HubSpot (for list-panel stage badges)
// Cache: one shared result, refreshed at most every 60 seconds.
// Concurrency guard: if a scan is already in progress, new requests wait for
// the same promise rather than each launching an independent HubSpot crawl.
const LOCALDATA_CACHE_TTL_MS = 60_000;
let _localdataCache = null;       // { data, expiresAt }
let _localdataInflight = null;    // Promise while a scan is running

async function fetchLocaldataFromHubspot() {
  const allResults = [];
  let after;
  do {
    const body = {
      properties: ['measure_once_rooms'],
      limit: 100
    };
    if (after) body.after = after;
    const r = await axios.post(`${HS}/crm/v3/objects/contacts/search`, body, { headers: hsHeaders() });
    allResults.push(...(r.data.results || []));
    after = r.data.paging?.next?.after;
  } while (after);

  const result = {};
  for (const contact of allResults) {
    const roomsJson = contact.properties?.measure_once_rooms;
    if (!roomsJson) continue;
    try {
      const rooms = JSON.parse(roomsJson);
      if (Array.isArray(rooms)) {
        result[contact.id] = rooms.map(r => ({
          room: r.room || 'Main', stageKey: r.stageKey || 'sales', roomStatus: r.roomStatus || 'active',
          assignedFitterId: r.assignedFitterId || null
        }));
      }
    } catch {}
  }
  return result;
}

// Assign (or unassign) a fitter to a specific room on a contact (manager or admin only)
app.patch('/api/contacts/:id/rooms/:roomIdx/fitter', isAuthenticated, requireManagerOrAdmin, requireHubspotToken, async (req, res) => {
  const contactId = req.params.id;
  const roomIdx   = parseInt(req.params.roomIdx, 10);
  const { fitterId } = req.body; // string id or null/'' to unassign

  if (!/^[A-Za-z0-9_-]+$/.test(contactId)) {
    return res.status(400).json({ error: 'Invalid contact id' });
  }
  if (isNaN(roomIdx) || roomIdx < 0) {
    return res.status(400).json({ error: 'Invalid room index' });
  }

  try {
    const r = await axios.get(
      `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
      { headers: hsHeaders(), params: { properties: 'measure_once_rooms' } }
    );
    const roomsJson = r.data.properties?.measure_once_rooms;
    if (!roomsJson) return res.status(404).json({ error: 'No rooms found' });
    const rooms = JSON.parse(roomsJson);
    if (!Array.isArray(rooms) || roomIdx >= rooms.length) {
      return res.status(404).json({ error: 'Room not found' });
    }

    if (fitterId) {
      const exists = await userIdExists(fitterId);
      if (!exists) return res.status(400).json({ error: 'Fitter user not found' });
      rooms[roomIdx].assignedFitterId = fitterId;
    } else {
      delete rooms[roomIdx].assignedFitterId;
    }

    await axios.patch(
      `${HS}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
      { properties: { measure_once_rooms: JSON.stringify(rooms) } },
      { headers: hsHeaders() }
    );

    // Bust cache so next /api/localdata/all reflects the new assignment
    _localdataCache = null;

    res.json({ success: true, rooms });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/localdata/all', async (req, res) => {
  try {
    // Serve from cache if still fresh
    if (_localdataCache && Date.now() < _localdataCache.expiresAt) {
      return res.json(_localdataCache.data);
    }

    // If a scan is already running, piggyback on it
    if (!_localdataInflight) {
      _localdataInflight = fetchLocaldataFromHubspot().finally(() => {
        _localdataInflight = null;
      });
    }

    const data = await _localdataInflight;
    _localdataCache = { data, expiresAt: Date.now() + LOCALDATA_CACHE_TTL_MS };
    res.json(data);
  } catch {
    res.json({});
  }
});

// ── Local storage for personal tasks only ─────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ── Google OAuth ──────────────────────────────────────────────────────────────
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;


const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar'
];

// ── Auth Routes ───────────────────────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: GOOGLE_SCOPES,
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    req.session.googleTokens = tokens;
    res.redirect('/?connected=true');
  } catch (e) {
    if (req.isAuthenticated && req.isAuthenticated()) {
      res.redirect('/?error=google_auth_failed');
    } else {
      res.redirect('/?access_requested=1');
    }
  }
});

app.get('/auth/logout-google', (req, res) => {
  delete req.session.googleTokens;
  res.json({ success: true });
});


app.get('/auth/status', (req, res) => {
  res.json({
    google:  !!req.session.googleTokens,
    hubspot: !!process.env.HUBSPOT_ACCESS_TOKEN
  });
});

// ── HubSpot: Account ──────────────────────────────────────────────────────────
app.get('/api/account', async (req, res) => {
  try {
    const r = await axios.get(`${HS}/account-info/v3/details`, { headers: hsHeaders() });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HubSpot: Pipeline ─────────────────────────────────────────────────────────
app.get('/api/pipeline', async (req, res) => {
  try {
    const r = await axios.get(`${HS}/crm/v3/pipelines/deals`, { headers: hsHeaders() });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HubSpot: Deals ────────────────────────────────────────────────────────────
function normalizeHubspotObjectId(id) {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return encodeURIComponent(trimmed);
}

app.get('/api/deals', async (req, res) => {
  try {
    const r = await axios.get(`${HS}/crm/v3/objects/deals`, {
      headers: hsHeaders(),
      params: {
        limit: 100,
        properties: 'dealname,dealstage,amount,closedate,pipeline,hs_lastmodifieddate,createdate,hubspot_owner_id',
        associations: 'contacts'
      }
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/deals/:id', async (req, res) => {
  try {
    const safeDealId = normalizeHubspotObjectId(req.params.id);
    if (!safeDealId) {
      return res.status(400).json({ error: 'Invalid deal id' });
    }
    const r = await axios.get(`${HS}/crm/v3/objects/deals/${safeDealId}`, {
      headers: hsHeaders(),
      params: {
        properties: 'dealname,dealstage,amount,closedate,pipeline,hs_lastmodifieddate,createdate',
        associations: 'contacts,notes'
      }
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/deals/:id', async (req, res) => {
  try {
    const safeDealId = normalizeHubspotObjectId(req.params.id);
    if (!safeDealId) {
      return res.status(400).json({ error: 'Invalid deal id' });
    }
    const r = await axios.patch(
      `${HS}/crm/v3/objects/deals/${safeDealId}`,
      { properties: req.body },
      { headers: hsHeaders() }
    );
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HubSpot: All Contacts (no lead status filter) ─────────────────────────────
app.get('/api/contacts-all', isAuthenticated, async (req, res) => {
  try {
    const allResults = [];
    let after = undefined;
    do {
      const body = {
        properties: ['firstname', 'lastname', 'email', 'phone', 'hs_lead_status', 'city', 'customer_number', 'createdate'],
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
        limit: 100
      };
      if (after) body.after = after;
      const r = await axios.post(
        `${HS}/crm/v3/objects/contacts/search`,
        body,
        { headers: hsHeaders() }
      );
      allResults.push(...(r.data.results || []));
      after = r.data.paging?.next?.after;
    } while (after);
    res.json({ results: allResults, total: allResults.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HubSpot: Open Leads (contacts with hs_lead_status = OPEN_DEAL) ────────────
app.get('/api/open-leads', async (req, res) => {
  try {
    const allResults = [];
    let after = undefined;
    do {
      const body = {
        filterGroups: [{
          filters: [{ propertyName: 'hs_lead_status', operator: 'EQ', value: 'OPEN_DEAL' }]
        }],
        properties: ['firstname', 'lastname', 'email', 'phone', 'hs_lead_status', 'city', 'customer_number', 'createdate'],
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
        limit: 100
      };
      if (after) body.after = after;
      const r = await axios.post(
        `${HS}/crm/v3/objects/contacts/search`,
        body,
        { headers: hsHeaders() }
      );
      allResults.push(...(r.data.results || []));
      after = r.data.paging?.next?.after;
    } while (after);
    res.json({ results: allResults, total: allResults.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HubSpot: Contacts ─────────────────────────────────────────────────────────

// Create a new contact in HubSpot and generate a customer number
app.post('/api/contacts', async (req, res) => {
  const { firstname, lastname, email, phone, postcode } = req.body || {};

  if (!firstname || !email || !postcode) {
    return res.status(400).json({ error: 'First name, email, and postcode are required.' });
  }

  // Extract the area letters from the postcode (leading alpha chars before first digit)
  const areaMatch = postcode.trim().match(/^([A-Za-z]+)/);
  const areaPrefix = areaMatch ? areaMatch[1].toUpperCase() : 'XX';

  try {
    // Create the contact in HubSpot
    const createBody = {
      properties: {
        firstname,
        lastname:       lastname  || '',
        email,
        phone:          phone     || '',
        zip:            postcode,
        hs_lead_status: 'OPEN_DEAL',
      }
    };
    const createRes = await axios.post(
      `${HS}/crm/v3/objects/contacts`,
      createBody,
      { headers: hsHeaders() }
    );
    const contact = createRes.data;
    const contactId = contact.id;

    // Generate customer number: area letters + zero-padded contact ID (5 digits min)
    const numPart = contactId.padStart(5, '0');
    const customerNumber = `${areaPrefix}${numPart}`;

    // Patch the contact with the generated customer number
    await axios.patch(
      `${HS}/crm/v3/objects/contacts/${contactId}`,
      { properties: { customer_number: customerNumber } },
      { headers: hsHeaders() }
    );

    contact.properties.customer_number = customerNumber;
    return res.status(201).json(contact);
  } catch (e) {
    const status = e.response?.status;
    if (status === 409) {
      return res.status(409).json({ error: 'A contact with this email address already exists in HubSpot.' });
    }
    const msg = e.response?.data?.message || e.message;
    return res.status(500).json({ error: msg });
  }
});

app.get('/api/contacts/:id', async (req, res) => {
  try {
    const contactId = String(req.params.id || '');
    if (!/^\d+$/.test(contactId)) {
      return res.status(400).json({ error: 'Invalid contact id.' });
    }
    const safeContactId = encodeURIComponent(contactId);
    const r = await axios.get(`${HS}/crm/v3/objects/contacts/${safeContactId}`, {
      headers: hsHeaders(),
      params: { properties: 'firstname,lastname,email,phone,address,city,zip,customer_number,hs_lead_status,createdate' }
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/contacts/:id', isAuthenticated, requireHubspotToken, async (req, res) => {
  try {
    const contactId = String(req.params.id || '');
    if (!/^\d+$/.test(contactId)) {
      return res.status(400).json({ error: 'Invalid contact id.' });
    }
    const allowed = ['hs_lead_status', 'firstname', 'lastname', 'email', 'phone', 'address', 'city', 'zip'];
    const properties = {};
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        properties[key] = req.body[key];
      }
    }
    if (Object.keys(properties).length === 0) {
      return res.status(400).json({ error: 'No valid properties to update.' });
    }
    const safeContactId = encodeURIComponent(contactId);
    const r = await axios.patch(
      `${HS}/crm/v3/objects/contacts/${safeContactId}`,
      { properties },
      { headers: hsHeaders() }
    );
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── HubSpot: Notes (for checklist storage) ────────────────────────────────────
app.get('/api/deals/:id/notes', async (req, res) => {
  try {
    const dealId = req.params.id;
    if (!/^\d+$/.test(dealId)) {
      return res.status(400).json({ error: 'Invalid deal id' });
    }

    const assocR = await axios.get(
      `${HS}/crm/v3/objects/deals/${dealId}/associations/notes`,
      { headers: hsHeaders() }
    );
    const noteIds = assocR.data.results?.map(r => r.id) || [];
    if (!noteIds.length) return res.json({ results: [] });

    const noteR = await axios.post(
      `${HS}/crm/v3/objects/notes/batch/read`,
      {
        properties: ['hs_note_body', 'hs_timestamp'],
        inputs: noteIds.map(id => ({ id }))
      },
      { headers: hsHeaders() }
    );
    res.json(noteR.data);
  } catch (e) {
    res.json({ results: [] });
  }
});

app.post('/api/deals/:id/checklist', async (req, res) => {
  try {
    const { checklistData, existingNoteId } = req.body;
    const noteBody = `WORKFLOW_CHECKLIST:${JSON.stringify(checklistData)}`;
    const dealId = String(req.params.id || '');

    // HubSpot deal IDs are numeric; reject anything else to prevent URL/path injection.
    if (!/^\d+$/.test(dealId)) {
      return res.status(400).json({ error: 'Invalid deal id' });
    }

    if (existingNoteId) {
      const validatedExistingNoteId = String(existingNoteId);
      if (!/^[A-Za-z0-9_-]+$/.test(validatedExistingNoteId)) {
        return res.status(400).json({ error: 'Invalid existingNoteId' });
      }

      const r = await axios.patch(
        `${HS}/crm/v3/objects/notes/${validatedExistingNoteId}`,
        { properties: { hs_note_body: noteBody } },
        { headers: hsHeaders() }
      );
      return res.json(r.data);
    }

    // Create note then associate
    const noteR = await axios.post(
      `${HS}/crm/v3/objects/notes`,
      { properties: { hs_note_body: noteBody, hs_timestamp: new Date().toISOString() } },
      { headers: hsHeaders() }
    );
    await axios.put(
      `${HS}/crm/v3/objects/notes/${noteR.data.id}/associations/deals/${dealId}/note_to_deal`,
      {},
      { headers: hsHeaders() }
    );
    res.json(noteR.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Gmail ─────────────────────────────────────────────────────────────────────
function getGoogleClient(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
  client.setCredentials(tokens);
  return client;
}

app.get('/api/emails', async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated with Google' });
  try {
    const auth = getGoogleClient(req.session.googleTokens);
    const gmail = google.gmail({ version: 'v1', auth });
    const { email } = req.query;
    const q = email ? `from:${email} OR to:${email}` : '';
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 15 });

    if (!list.data.messages?.length) return res.json({ messages: [] });

    const messages = await Promise.all(list.data.messages.map(async m => {
      const msg = await gmail.users.messages.get({
        userId: 'me', id: m.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Date']
      });
      const h = msg.data.payload.headers;
      const get = name => h.find(x => x.name === name)?.value || '';
      return {
        id: m.id,
        subject: get('Subject'),
        from: get('From'),
        to: get('To'),
        date: get('Date'),
        snippet: msg.data.snippet
      };
    }));

    res.json({ messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/emails/send', async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated with Google' });
  try {
    const auth = getGoogleClient(req.session.googleTokens);
    const gmail = google.gmail({ version: 'v1', auth });
    const { to, subject, body } = req.body;

    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
    ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Google Calendar ───────────────────────────────────────────────────────────
app.get('/api/events', async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated with Google' });
  try {
    const auth = getGoogleClient(req.session.googleTokens);
    const calendar = google.calendar({ version: 'v3', auth });
    const events = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: 20,
      singleEvents: true,
      orderBy: 'startTime',
      q: req.query.search || undefined
    });
    res.json(events.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/events', async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated with Google' });
  try {
    const auth = getGoogleClient(req.session.googleTokens);
    const calendar = google.calendar({ version: 'v3', auth });
    const event = await calendar.events.insert({ calendarId: 'primary', requestBody: req.body });
    res.json(event.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HubSpot: Contact Notes + Workflow Data ────────────────────────────────────
app.get('/api/contacts/:id/notes', async (req, res) => {
  const contactId = String(req.params.id || '');
  if (!/^\d+$/.test(contactId)) {
    return res.status(400).json({ error: 'Invalid contact id' });
  }
  try {
    const assocR = await axios.get(
      `${HS}/crm/v3/objects/contacts/${contactId}/associations/notes`,
      { headers: hsHeaders() }
    );
    const noteIds = assocR.data.results?.map(r => r.id) || [];
    if (!noteIds.length) return res.json({ results: [] });

    const noteR = await axios.post(
      `${HS}/crm/v3/objects/notes/batch/read`,
      {
        properties: ['hs_note_body', 'hs_timestamp'],
        inputs: noteIds.map(id => ({ id }))
      },
      { headers: hsHeaders() }
    );
    res.json(noteR.data);
  } catch (e) {
    res.json({ results: [] });
  }
});

app.post('/api/contacts/:id/workflow', async (req, res) => {
  try {
    const { data, existingNoteId } = req.body;
    const contactId = String(req.params.id || '');
    if (!/^\d+$/.test(contactId)) {
      return res.status(400).json({ error: 'Invalid contact id' });
    }

    const noteBody = `WORKFLOW_DATA:${JSON.stringify(data)}`;

    if (existingNoteId) {
      const safeExistingNoteId = validateHsObjectId(existingNoteId, 'existingNoteId');
      const r = await axios.patch(
        `${HS}/crm/v3/objects/notes/${safeExistingNoteId}`,
        { properties: { hs_note_body: noteBody } },
        { headers: hsHeaders() }
      );
      return res.json(r.data);
    }

    const noteR = await axios.post(
      `${HS}/crm/v3/objects/notes`,
      { properties: { hs_note_body: noteBody, hs_timestamp: new Date().toISOString() } },
      { headers: hsHeaders() }
    );
    await axios.put(
      `${HS}/crm/v3/objects/notes/${noteR.data.id}/associations/contacts/${encodeURIComponent(contactId)}/note_to_contact`,
      {},
      { headers: hsHeaders() }
    );
    res.json(noteR.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Workflow Data (per-deal status + comments) ────────────────────────────────
app.post('/api/deals/:id/workflow', async (req, res) => {
  try {
    const { data, existingNoteId } = req.body;
    const safeDealId = validateHsObjectId(req.params.id, 'id');
    const noteBody = `WORKFLOW_DATA:${JSON.stringify(data)}`;

    if (existingNoteId) {
      const safeExistingNoteId = validateHsObjectId(existingNoteId, 'existingNoteId');
      const r = await axios.patch(
        `${HS}/crm/v3/objects/notes/${safeExistingNoteId}`,
        { properties: { hs_note_body: noteBody } },
        { headers: hsHeaders() }
      );
      return res.json(r.data);
    }

    const noteR = await axios.post(
      `${HS}/crm/v3/objects/notes`,
      { properties: { hs_note_body: noteBody, hs_timestamp: new Date().toISOString() } },
      { headers: hsHeaders() }
    );
    await axios.put(
      `${HS}/crm/v3/objects/notes/${noteR.data.id}/associations/deals/${safeDealId}/note_to_deal`,
      {},
      { headers: hsHeaders() }
    );
    res.json(noteR.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HubSpot: Tasks ────────────────────────────────────────────────────────────
app.get('/api/contacts/:id/tasks', async (req, res) => {
  try {
    const contactId = req.params.id;
    if (!/^\d+$/.test(contactId)) {
      return res.status(400).json({ error: 'Invalid contact id' });
    }

    const assocR = await axios.get(
      `${HS}/crm/v3/objects/contacts/${contactId}/associations/tasks`,
      { headers: hsHeaders() }
    );
    const taskIds = assocR.data.results?.map(r => r.id) || [];
    if (!taskIds.length) return res.json({ results: [] });

    const taskR = await axios.post(
      `${HS}/crm/v3/objects/tasks/batch/read`,
      {
        properties: ['hs_task_subject', 'hs_timestamp', 'hs_task_status', 'hs_task_body'],
        inputs: taskIds.map(id => ({ id }))
      },
      { headers: hsHeaders() }
    );
    res.json(taskR.data);
  } catch (e) {
    res.json({ results: [] });
  }
});

app.post('/api/contacts/:id/tasks', async (req, res) => {
  try {
    const { subject, dueDate, stageKey } = req.body;
    const contactId = req.params.id;
    if (!/^\d+$/.test(contactId)) {
      return res.status(400).json({ error: 'Invalid contact id' });
    }

    const properties = {
      hs_task_subject: subject,
      hs_task_status: 'NOT_STARTED',
      hs_task_type: 'TODO'
    };
    if (dueDate) properties.hs_timestamp = new Date(dueDate + 'T12:00:00').toISOString();
    if (stageKey) properties.hs_task_body = `TASK_STAGE:${stageKey}`;

    const taskR = await axios.post(
      `${HS}/crm/v3/objects/tasks`,
      { properties },
      { headers: hsHeaders() }
    );
    await axios.put(
      `${HS}/crm/v3/objects/tasks/${taskR.data.id}/associations/contacts/${contactId}/task_to_contact`,
      {},
      { headers: hsHeaders() }
    );
    res.json(taskR.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/tasks/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    if (!/^\d+$/.test(taskId)) {
      return res.status(400).json({ error: 'Invalid task id' });
    }

    const r = await axios.patch(
      `${HS}/crm/v3/objects/tasks/${taskId}`,
      { properties: req.body },
      { headers: hsHeaders() }
    );
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    if (!/^\d+$/.test(taskId)) {
      return res.status(400).json({ error: 'Invalid task id' });
    }

    await axios.delete(
      `${HS}/crm/v3/objects/tasks/${taskId}`,
      { headers: hsHeaders() }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HubSpot: Batch Workflow Stages (for customer list pre-population) ─────────
app.get('/api/workflow-stages', async (req, res) => {
  try {
    // Search for all notes that store workflow data
    const searchR = await axios.post(
      `${HS}/crm/v3/objects/notes/search`,
      {
        filterGroups: [{ filters: [{ propertyName: 'hs_note_body', operator: 'CONTAINS_TOKEN', value: 'WORKFLOW_DATA' }] }],
        properties: ['hs_note_body'],
        limit: 200
      },
      { headers: hsHeaders() }
    );

    const notes = (searchR.data.results || []).filter(n =>
      n.properties?.hs_note_body?.startsWith('WORKFLOW_DATA:')
    );
    if (!notes.length) return res.json({});

    // Batch read note → contact associations
    const assocR = await axios.post(
      `${HS}/crm/v4/associations/notes/contacts/batch/read`,
      { inputs: notes.map(n => ({ id: n.id })) },
      { headers: hsHeaders() }
    );

    // Parse each note into rooms array
    const noteData = {};
    notes.forEach(n => {
      try {
        const json = JSON.parse(n.properties.hs_note_body.slice('WORKFLOW_DATA:'.length));
        const arr = Array.isArray(json)
          ? json
          : [{ room: 'Main', stageKey: json.stageKey || 'sales', roomStatus: json.roomStatus || 'active' }];
        noteData[n.id] = arr.map(r => ({
          room:       r.room       || 'Main',
          stageKey:   r.stageKey   || 'sales',
          roomStatus: r.roomStatus || 'active'
        }));
      } catch {}
    });

    // Build contactId → rooms map
    const result = {};
    (assocR.data.results || []).forEach(r => {
      const noteId    = r.from?.id;
      const contactId = r.to?.[0]?.toObjectId;
      if (noteId && contactId && noteData[noteId]) {
        result[String(contactId)] = noteData[noteId];
      }
    });

    res.json(result);
  } catch (e) {
    res.json({});
  }
});

// ── Workflow Config ───────────────────────────────────────────────────────────
const WORKFLOW_FILE = path.join(__dirname, 'workflow.json');

app.get('/api/workflow', (req, res) => {
  try {
    const data = fs.existsSync(WORKFLOW_FILE)
      ? JSON.parse(fs.readFileSync(WORKFLOW_FILE, 'utf8'))
      : null;
    res.json(data);
  } catch {
    res.json(null);
  }
});

const IDENTIFIER_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validateWorkflow(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid workflow object';
  if (!body.stages || typeof body.stages !== 'object' || Array.isArray(body.stages)) return 'Missing or invalid stages';
  for (const [stageKey, stage] of Object.entries(body.stages)) {
    if (!IDENTIFIER_RE.test(stageKey)) return `Invalid stage key: "${stageKey}"`;
    if (stage && Array.isArray(stage.statuses)) {
      for (const status of stage.statuses) {
        if (status.id !== undefined && !IDENTIFIER_RE.test(String(status.id))) {
          return `Invalid status id: "${status.id}" in stage "${stageKey}"`;
        }
      }
    }
  }
  return null;
}

app.post('/api/workflow', requireAdmin, (req, res) => {
  const err = validateWorkflow(req.body);
  if (err) return res.status(400).json({ error: err });
  fs.writeFileSync(WORKFLOW_FILE, JSON.stringify(req.body, null, 2));
  res.json({ success: true });
});

// ── Personal Tasks (local JSON) ───────────────────────────────────────────────
const PERSONAL_TASKS_FILE = path.join(DATA_DIR, '__personal_tasks.json');

function readPersonalTasks() {
  try { return JSON.parse(fs.readFileSync(PERSONAL_TASKS_FILE, 'utf8')); } catch { return []; }
}
function writePersonalTasks(tasks) {
  fs.writeFileSync(PERSONAL_TASKS_FILE, JSON.stringify(tasks, null, 2));
}

app.get('/api/personal-tasks', (req, res) => {
  const userId = req.user.claims.sub;
  res.json(readPersonalTasks().filter(t => t.userId === userId));
});

app.post('/api/personal-tasks', (req, res) => {
  const userId = req.user.claims.sub;
  const tasks = readPersonalTasks();
  const task = {
    id: Date.now().toString(),
    userId,
    title: (req.body.title || '').trim(),
    dueDate: req.body.dueDate || null,
    done: false,
    createdAt: new Date().toISOString()
  };
  if (!task.title) return res.status(400).json({ error: 'Title required' });
  tasks.push(task);
  writePersonalTasks(tasks);
  res.json(task);
});

app.patch('/api/personal-tasks/:id', (req, res) => {
  const userId = req.user.claims.sub;
  const tasks = readPersonalTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id && t.userId === userId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const { userId: _uid, id: _id, createdAt: _ca, ...allowed } = req.body;
  tasks[idx] = { ...tasks[idx], ...allowed };
  writePersonalTasks(tasks);
  res.json(tasks[idx]);
});

app.delete('/api/personal-tasks/:id', (req, res) => {
  const userId = req.user.claims.sub;
  const tasks = readPersonalTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id && t.userId === userId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  writePersonalTasks(tasks.filter(t => t.id !== req.params.id || t.userId !== userId));
  res.json({ success: true });
});

// ── Trades Directory ──────────────────────────────────────────────────────────
const _tradesPool = new (require('pg').Pool)({ connectionString: process.env.DATABASE_URL });

async function ensureTradesTable() {
  await _tradesPool.query(`
    CREATE TABLE IF NOT EXISTS trade_contacts (
      id             SERIAL PRIMARY KEY,
      name           VARCHAR NOT NULL,
      trade_type     VARCHAR NOT NULL,
      phone          VARCHAR,
      email          VARCHAR,
      areas_served   TEXT,
      company_name   VARCHAR,
      timescale      VARCHAR,
      invoice_method VARCHAR,
      payment_terms  VARCHAR,
      notes          TEXT,
      created_by     VARCHAR,
      created_at     TIMESTAMP DEFAULT NOW()
    );
  `);
  await _tradesPool.query(`
    CREATE TABLE IF NOT EXISTS trade_companies (
      id             SERIAL PRIMARY KEY,
      company_name   VARCHAR NOT NULL,
      trade_type     VARCHAR NOT NULL,
      areas_served   TEXT,
      timescale      VARCHAR,
      invoice_method VARCHAR,
      payment_terms  VARCHAR,
      notes          TEXT,
      created_by     VARCHAR,
      created_at     TIMESTAMP DEFAULT NOW(),
      legacy_id      INTEGER
    );
  `);
  await _tradesPool.query(`
    CREATE TABLE IF NOT EXISTS trade_company_contacts (
      id         SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES trade_companies(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      name       VARCHAR NOT NULL,
      role       VARCHAR,
      phone      VARCHAR,
      email      VARCHAR
    );
  `);
  const { rows: unmigratedRows } = await _tradesPool.query(`
    SELECT * FROM trade_contacts
    WHERE id NOT IN (
      SELECT legacy_id FROM trade_companies WHERE legacy_id IS NOT NULL
    )
    ORDER BY created_at ASC
  `);
  for (const row of unmigratedRows) {
    const coName = (row.company_name || '').trim() || row.name;
    const { rows: [co] } = await _tradesPool.query(
      `INSERT INTO trade_companies
        (company_name, trade_type, areas_served, timescale, invoice_method, payment_terms, notes, created_by, created_at, legacy_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [coName, row.trade_type, row.areas_served || '', row.timescale || '',
       row.invoice_method || '', row.payment_terms || '', row.notes || '',
       row.created_by, row.created_at, row.id]
    );
    await _tradesPool.query(
      `INSERT INTO trade_company_contacts (company_id, sort_order, name, role, phone, email)
       VALUES ($1, 0, $2, '', $3, $4)`,
      [co.id, row.name, row.phone || '', row.email || '']
    );
  }
}

app.get('/trades', isAuthenticated, requireManagerOrAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'trades.html'));
});

app.get('/api/trades', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
  try {
    const { rows: companies } = await _tradesPool.query(
      `SELECT * FROM trade_companies ORDER BY created_at DESC`
    );
    const { rows: contacts } = await _tradesPool.query(
      `SELECT * FROM trade_company_contacts ORDER BY company_id, sort_order, id`
    );
    const contactMap = {};
    for (const c of contacts) {
      if (!contactMap[c.company_id]) contactMap[c.company_id] = [];
      contactMap[c.company_id].push(c);
    }
    const result = companies.map(co => ({
      ...co,
      contacts: contactMap[co.id] || []
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/trades', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
  const { company_name, trade_type, areas_served, timescale, invoice_method, payment_terms, notes, contacts } = req.body || {};
  if (!company_name || !company_name.trim()) return res.status(400).json({ error: 'Company name is required.' });
  if (!trade_type || !trade_type.trim()) return res.status(400).json({ error: 'Trade type is required.' });
  const validContacts = (contacts || []).filter(c => c && (c.name || '').trim());
  if (!validContacts.length) return res.status(400).json({ error: 'At least one contact person with a name is required.' });
  if (validContacts.length > 3) return res.status(400).json({ error: 'A maximum of 3 contacts per company is allowed.' });
  const client = await _tradesPool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [co] } = await client.query(
      `INSERT INTO trade_companies
        (company_name, trade_type, areas_served, timescale, invoice_method, payment_terms, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [company_name.trim(), trade_type.trim(), (areas_served || '').trim(),
       (timescale || '').trim(), (invoice_method || '').trim(),
       (payment_terms || '').trim(), (notes || '').trim(),
       req.user?.claims?.sub || null]
    );
    const insertedContacts = [];
    for (let i = 0; i < validContacts.length; i++) {
      const ct = validContacts[i];
      const { rows: [cc] } = await client.query(
        `INSERT INTO trade_company_contacts (company_id, sort_order, name, role, phone, email)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [co.id, i, ct.name.trim(), (ct.role || '').trim(), (ct.phone || '').trim(), (ct.email || '').trim()]
      );
      insertedContacts.push(cc);
    }
    await client.query('COMMIT');
    res.status(201).json({ ...co, contacts: insertedContacts });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.put('/api/trades/:id', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id.' });
  const { company_name, trade_type, areas_served, timescale, invoice_method, payment_terms, notes, contacts } = req.body || {};
  if (!company_name || !company_name.trim()) return res.status(400).json({ error: 'Company name is required.' });
  if (!trade_type || !trade_type.trim()) return res.status(400).json({ error: 'Trade type is required.' });
  const validContacts = (contacts || []).filter(c => c && (c.name || '').trim());
  if (!validContacts.length) return res.status(400).json({ error: 'At least one contact person with a name is required.' });
  if (validContacts.length > 3) return res.status(400).json({ error: 'A maximum of 3 contacts per company is allowed.' });
  const client = await _tradesPool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [co], rowCount } = await client.query(
      `UPDATE trade_companies
       SET company_name=$1, trade_type=$2, areas_served=$3, timescale=$4,
           invoice_method=$5, payment_terms=$6, notes=$7
       WHERE id=$8 RETURNING *`,
      [company_name.trim(), trade_type.trim(), (areas_served || '').trim(),
       (timescale || '').trim(), (invoice_method || '').trim(),
       (payment_terms || '').trim(), (notes || '').trim(), id]
    );
    if (!rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Company not found.' }); }
    await client.query(`DELETE FROM trade_company_contacts WHERE company_id=$1`, [id]);
    const insertedContacts = [];
    for (let i = 0; i < validContacts.length; i++) {
      const ct = validContacts[i];
      const { rows: [cc] } = await client.query(
        `INSERT INTO trade_company_contacts (company_id, sort_order, name, role, phone, email)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, i, ct.name.trim(), (ct.role || '').trim(), (ct.phone || '').trim(), (ct.email || '').trim()]
      );
      insertedContacts.push(cc);
    }
    await client.query('COMMIT');
    res.json({ ...co, contacts: insertedContacts });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.delete('/api/trades/:id', isAuthenticated, requireManagerOrAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id.' });
  try {
    const r = await _tradesPool.query(`DELETE FROM trade_companies WHERE id=$1`, [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Company not found.' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Google Calendar: upcoming events (14-day window) ──────────────────────────
app.get('/api/calendar/upcoming', async (req, res) => {
  if (!req.session.googleTokens) return res.json({ events: [], connected: false });
  try {
    const auth = getGoogleClient(req.session.googleTokens);
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: twoWeeks.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50
    });
    res.json({ events: response.data.items || [], connected: true });
  } catch (e) {
    res.json({ events: [], connected: false, error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const ok = await setupAuth(app);
    if (ok) console.log('  Replit Auth initialized');
  } catch (e) {
    console.error('  Replit Auth setup failed:', e.message);
  }

  app.listen(PORT, HOST, async () => {
    console.log(`\n  Measure Once`);
    console.log(`  Running at: http://localhost:${PORT}\n`);
    await ensureHubSpotProperties();
    try { await ensureVisitsTable(); console.log('  Visits table ready'); }
    catch (e) { console.error('  Visits table setup failed:', e.message); }
    try { await ensureTradesTable(); console.log('  Trades table ready'); }
    catch (e) { console.error('  Trades table setup failed:', e.message); }
  });
})();
