require('dotenv').config();
const express = require('express');
const axios = require('axios').create({ timeout: 10000 });
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { installSession, setupAuth, isAuthenticated } = require('./auth');

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
installSession(app);

// ── HubSpot ───────────────────────────────────────────────────────────────────
const HS = 'https://api.hubapi.com';
const hsHeaders = () => ({
  Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`,
  'Content-Type': 'application/json'
});

// Guard: return a clear error if no token is set
function requireHubspotToken(req, res, next) {
  if (!process.env.HUBSPOT_TOKEN) {
    return res.status(503).json({
      error: 'HUBSPOT_TOKEN is not set. Add it to your .env file and restart the server.'
    });
  }
  next();
}
// Replit Auth gate for all /api/* routes (whitelist auth-flow endpoints).
const AUTH_WHITELIST = new Set(['/login', '/callback', '/auth/user']);
app.use('/api', (req, res, next) => {
  if (AUTH_WHITELIST.has(req.path)) return next();
  return isAuthenticated(req, res, next);
});

app.use('/api/pipeline', requireHubspotToken);
app.use('/api/deals', requireHubspotToken);
app.use('/api/contacts', requireHubspotToken);
app.use('/api/account', requireHubspotToken);
app.use('/api/open-leads', requireHubspotToken);
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
  try {
    const r = await axios.get(
      `${HS}/crm/v3/objects/contacts/${req.params.id}`,
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
    await axios.patch(
      `${HS}/crm/v3/objects/contacts/${req.params.id}`,
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
app.get('/api/localdata/all', async (req, res) => {
  try {
    const allResults = [];
    let after;
    do {
      const body = {
        filterGroups: [{ filters: [{ propertyName: 'hs_lead_status', operator: 'EQ', value: 'OPEN_DEAL' }] }],
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
            room: r.room || 'Main', stageKey: r.stageKey || 'sales', roomStatus: r.roomStatus || 'active'
          }));
        }
      } catch {}
    }
    res.json(result);
  } catch { res.json({}); }
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
    res.redirect('/?error=google_auth_failed');
  }
});

app.get('/auth/logout-google', (req, res) => {
  delete req.session.googleTokens;
  res.json({ success: true });
});


app.get('/auth/status', (req, res) => {
  res.json({
    google:  !!req.session.googleTokens,
    hubspot: !!process.env.HUBSPOT_TOKEN
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
    const r = await axios.get(`${HS}/crm/v3/objects/deals/${req.params.id}`, {
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
    const r = await axios.patch(
      `${HS}/crm/v3/objects/deals/${req.params.id}`,
      { properties: req.body },
      { headers: hsHeaders() }
    );
    res.json(r.data);
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
        properties: ['firstname', 'lastname', 'email', 'phone', 'hs_lead_status', 'city'],
        sorts: [{ propertyName: 'lastname', direction: 'ASCENDING' }],
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
app.get('/api/contacts/:id', async (req, res) => {
  try {
    const r = await axios.get(`${HS}/crm/v3/objects/contacts/${req.params.id}`, {
      headers: hsHeaders(),
      params: { properties: 'firstname,lastname,email,phone,address,city,zip' }
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HubSpot: Notes (for checklist storage) ────────────────────────────────────
app.get('/api/deals/:id/notes', async (req, res) => {
  try {
    const assocR = await axios.get(
      `${HS}/crm/v3/objects/deals/${req.params.id}/associations/notes`,
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

    if (existingNoteId) {
      const r = await axios.patch(
        `${HS}/crm/v3/objects/notes/${existingNoteId}`,
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
      `${HS}/crm/v3/objects/notes/${noteR.data.id}/associations/deals/${req.params.id}/note_to_deal`,
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
  try {
    const assocR = await axios.get(
      `${HS}/crm/v3/objects/contacts/${req.params.id}/associations/notes`,
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
    const noteBody = `WORKFLOW_DATA:${JSON.stringify(data)}`;

    if (existingNoteId) {
      const r = await axios.patch(
        `${HS}/crm/v3/objects/notes/${existingNoteId}`,
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
      `${HS}/crm/v3/objects/notes/${noteR.data.id}/associations/contacts/${req.params.id}/note_to_contact`,
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
    const noteBody = `WORKFLOW_DATA:${JSON.stringify(data)}`;

    if (existingNoteId) {
      const r = await axios.patch(
        `${HS}/crm/v3/objects/notes/${existingNoteId}`,
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
      `${HS}/crm/v3/objects/notes/${noteR.data.id}/associations/deals/${req.params.id}/note_to_deal`,
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
    const assocR = await axios.get(
      `${HS}/crm/v3/objects/contacts/${req.params.id}/associations/tasks`,
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
      `${HS}/crm/v3/objects/tasks/${taskR.data.id}/associations/contacts/${req.params.id}/task_to_contact`,
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
    const r = await axios.patch(
      `${HS}/crm/v3/objects/tasks/${req.params.id}`,
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
    await axios.delete(
      `${HS}/crm/v3/objects/tasks/${req.params.id}`,
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

app.post('/api/workflow', (req, res) => {
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
  res.json(readPersonalTasks());
});

app.post('/api/personal-tasks', (req, res) => {
  const tasks = readPersonalTasks();
  const task = {
    id: Date.now().toString(),
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
  const tasks = readPersonalTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  tasks[idx] = { ...tasks[idx], ...req.body };
  writePersonalTasks(tasks);
  res.json(tasks[idx]);
});

app.delete('/api/personal-tasks/:id', (req, res) => {
  writePersonalTasks(readPersonalTasks().filter(t => t.id !== req.params.id));
  res.json({ success: true });
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
  });
})();
