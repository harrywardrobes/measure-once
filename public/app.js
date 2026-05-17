// ── Workflow Definition ────────────────────────────────────────────────────────
const DEFAULT_WORKFLOW = {
  stages: {
    sales: {
      label: 'Sales',
      statuses: [
        { id: 'form_submission',   label: 'Form submission',        hint: 'Email + WhatsApp customer asking for more information' },
        { id: 'attempted_contact', label: 'Attempted to contact',   hint: 'If no response in 2 working days, call to discuss' },
        { id: 'in_progress',       label: 'In progress',            hint: '' },
        { id: 'awaiting_photos',   label: 'Awaiting photos',        hint: '' },
        { id: 'rough_estimate',    label: 'Rough estimate',         hint: '' },
        { id: 'unqualified',       label: 'Unqualified',            hint: '' },
        { id: 'not_suitable',      label: 'Not suitable',           hint: '' },
        { id: 'bad_timing',        label: 'Bad timing',             hint: 'Get back in touch in 1 month, or date suggested' }
      ]
    },
    designvisit: {
      label: 'Design Visit',
      statuses: [
        { id: 'scheduled',   label: 'Scheduled',   hint: 'Add date to calendar' },
        { id: 'open_deal',   label: 'Open deal',   hint: '' }
      ]
    },
    survey: {
      label: 'Survey',
      statuses: [
        { id: 'design_accepted',      label: 'Design accepted',          hint: '' },
        { id: 'awaiting_deposit',     label: 'Awaiting deposit invoice', hint: '' },
        { id: 'scheduled',            label: 'Scheduled',                hint: '' },
        { id: 'in_progress',          label: 'In progress',              hint: 'Check date with customer' },
        { id: 'ready_for_production', label: 'Ready for production',     hint: 'Email to customer, confirm date of installation' }
      ]
    },
    order: {
      label: 'Order',
      statuses: [
        { id: 'order_doors',    label: 'Order doors',    hint: 'Order in for previous Monday or Tuesday' },
        { id: 'order_sheets',   label: 'Order sheets',   hint: '' },
        { id: 'order_hardware', label: 'Order hardware', hint: '' }
      ]
    },
    workshop: {
      label: 'Workshop',
      statuses: [
        { id: 'print_installer_pack', label: 'Print installer pack',               hint: 'Renders, cutlist, any installation instructions' },
        { id: 'print_labels',         label: 'Print labels',                       hint: '' },
        { id: 'notify_customer',      label: 'Notify customer production is underway', hint: '' },
        { id: 'prep_framework',       label: 'Prep framework, timber and MDF',     hint: '' },
        { id: 'prep_sheet_materials', label: 'Prep sheet materials',               hint: '' },
        { id: 'cut_sheet_materials',  label: 'Cut sheet materials',                hint: '' }
      ]
    },
    packing: {
      label: 'Packing',
      statuses: [
        { id: 'in_progress',   label: 'In progress',                     hint: '' },
        { id: 'date_agreed',   label: 'Date / time agreed with customer', hint: '' },
        { id: 'ready_to_load', label: 'Ready to load into van',          hint: '' }
      ]
    },
    delivery: {
      label: 'Delivery',
      statuses: [
        { id: 'loaded',    label: 'Loaded into van', hint: '' },
        { id: 'delivered', label: 'Delivered',        hint: 'Note date, time, and any comments' }
      ]
    },
    installation: {
      label: 'Installation',
      statuses: [
        { id: 'scheduled',          label: 'Scheduled',          hint: '' },
        { id: 'in_progress',        label: 'In progress',        hint: '' },
        { id: 'complete',           label: 'Complete',           hint: '' },
        { id: 'final_invoice_sent', label: 'Final invoice sent', hint: '' }
      ]
    },
    aftercare: {
      label: 'Aftercare',
      statuses: [
        { id: 'final_payment', label: 'Final payment received',  hint: '' },
        { id: 'thank_you',     label: 'Thank you message sent', hint: 'Email customer thanking them and requesting a review' }
      ]
    }
  }
};

const STAGE_COLOURS = [
  { bg: '#8B2BFF', light: '#F3EAFF', text: '#6A12D9' },  // orchid       — Sales
  { bg: '#0d9488', light: '#ccfbf1', text: '#0f766e' },  // teal         — Design Visit
  { bg: '#d97706', light: '#fef3c7', text: '#b45309' },  // amber        — Survey
  { bg: '#2563eb', light: '#dbeafe', text: '#1d4ed8' },  // blue         — Order
  { bg: '#dc2626', light: '#fee2e2', text: '#b91c1c' },  // red          — Workshop
  { bg: '#059669', light: '#d1fae5', text: '#047857' },  // emerald      — Packing
  { bg: '#0891b2', light: '#cffafe', text: '#0e7490' },  // cyan         — Delivery
  { bg: '#8A5A3B', light: '#fdf6ee', text: '#5c3820' },  // walnut       — Installation
  { bg: '#200842', light: '#ede0ff', text: '#3d0f7a' },  // plum         — Aftercare
];

const STAGE_KEYS = Object.keys(DEFAULT_WORKFLOW.stages);

function stageColour(stageKey) {
  const idx = STAGE_KEYS.indexOf(stageKey);
  return STAGE_COLOURS[Math.max(0, idx)];
}

// ── App State ─────────────────────────────────────────────────────────────────
const state = {
  contacts: [],
  filteredContacts: [],
  workflow: null,
  authStatus: { google: false, hubspot: false },
  selectedContactId: null,
  selectedContact: null,
  selectedRoomIdx: 0,
  allRooms: [],            // [{room, stageKey, statusId, comments, roomStatus}]
  workflowData: null,      // reference to allRooms[selectedRoomIdx]
  expandedStages: new Set(),
  contactStageCache: {},   // contactId -> [{room, stageKey, roomStatus}]
  contactUrgencyCache: {}, // contactId -> 'red'|'orange'|null
  loadingContact: false,
  tasks: [],
  showAddTask: false,
  addingRoom: false,
  stageFilter: '',
  showArchived: false,
  activeTab: 'customers',
  projectStageFilter: '',
  customerNotes: '',
  personalTasks: [],
  calendarEvents: [],
  calendarConnected: false,
  showAddPersonalTask: false,
  qb: {
    connected: false,
    company: null,
    invoices: [],
    loaded: false,
    loading: false,
    showMatchedOnly: true,
  },
};

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (r.status === 401) {
    window.location.href = '/api/login';
    throw new Error('Unauthorized');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
const GET        = path      => api('GET',    path);
const POST       = (path, b) => api('POST',   path, b);
const PATCH_REQ  = (path, b) => api('PATCH',  path, b);
const DELETE_REQ = path      => api('DELETE', path);

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function formatShortDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Record the date a room first entered a stage — never overwrites an existing date.
function recordStageDate(room, stageKey) {
  if (!room.stageDates) room.stageDates = {};
  if (!room.stageDates[stageKey]) room.stageDates[stageKey] = todayISO();
}

function contactName(contact) {
  const p = contact?.properties || {};
  const name = [p.firstname, p.lastname].filter(Boolean).join(' ');
  return name || p.email || 'Unnamed';
}

function showToast(msg, isError) {
  const el = document.createElement('div');
  el.className = `toast ${isError ? 'toast-error' : 'toast-success'}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Working days / urgency ────────────────────────────────────────────────────
function workingDayDeadline(n) {
  const d = new Date();
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function getTaskUrgency(tasks) {
  const one = workingDayDeadline(1);
  const two = workingDayDeadline(2);
  let urgency = null;
  for (const t of tasks) {
    if (t.properties?.hs_task_status === 'COMPLETED') continue;
    const due = parseInt(t.properties?.hs_timestamp || '0');
    if (!due) continue;
    if (due <= one) { urgency = 'red'; break; }
    else if (due <= two && urgency !== 'red') { urgency = 'orange'; }
  }
  return urgency;
}

// ── Room cache helper ─────────────────────────────────────────────────────────
function updateRoomCache() {
  if (!state.selectedContactId) return;
  state.contactStageCache[state.selectedContactId] = state.allRooms.map(r => ({
    room: r.room, stageKey: r.stageKey, roomStatus: r.roomStatus || 'active'
  }));
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  // Gate the entire dashboard behind authentication.
  const params = new URLSearchParams(window.location.search);
  const denied = params.get('denied') === '1';

  const user = await fetch('/api/auth/user')
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);

  if (!user) {
    showAccessGate(denied);
    return;
  }

  state.user = user;

  try {
    await checkAuthStatus();
    await loadWorkflow();
    await Promise.all([loadOpenLeads(), loadWorkflowStages()]);
    populateStageFilter();
    renderCustomerList();
    loadQBInvoices();
  } catch (e) {
    document.getElementById('customer-list').innerHTML =
      `<div class="p-4 text-sm text-red-500">Failed to load: ${escHtml(e.message)}</div>`;
  }
}

function showAccessGate(denied) {
  const gate = document.getElementById('access-gate');
  if (gate) gate.style.display = 'flex';
  if (denied) {
    const banner = document.getElementById('access-denied-banner');
    if (banner) banner.style.display = 'block';
  }
}

async function submitAccessRequest(ev) {
  ev.preventDefault();
  const name = document.getElementById('ra-name').value.trim();
  const email = document.getElementById('ra-email').value.trim();
  const btn = document.getElementById('ra-submit');
  const msg = document.getElementById('request-access-message');
  btn.disabled = true; btn.textContent = 'Submitting…';
  msg.style.display = 'none';
  try {
    const r = await fetch('/api/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Request failed');
    msg.className = 'access-message success';
    msg.style.display = 'block';
    msg.textContent = data.alreadyApproved
      ? "Good news — you're already approved. Click \"Sign in\" below."
      : "Thanks! Your request has been submitted. We'll be in touch.";
    document.getElementById('request-access-form').reset();
  } catch (e) {
    msg.className = 'access-message error';
    msg.style.display = 'block';
    msg.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Request access';
  }
}

async function checkAuthStatus() {
  const [status, user] = await Promise.all([
    GET('/auth/status'),
    fetch('/api/auth/user').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  state.authStatus = status;
  state.user = user;
  renderAuthStatus();
}

async function loadWorkflow() {
  const saved = await GET('/api/workflow');
  state.workflow = saved || DEFAULT_WORKFLOW;
  if (state.workflow?.stages) {
    for (const [, stage] of Object.entries(state.workflow.stages)) {
      if (stage.tasks && !stage.statuses) {
        stage.statuses = stage.tasks.map((t, i) => ({ id: `task_${i}`, label: t, hint: '' }));
      }
    }
  }
}

async function loadOpenLeads() {
  const data = await GET('/api/open-leads');
  state.contacts = data.results || [];
  state.filteredContacts = [...state.contacts];
}

async function loadWorkflowStages() {
  const data = await GET('/api/localdata/all').catch(() => ({}));
  for (const [contactId, rooms] of Object.entries(data || {})) {
    state.contactStageCache[contactId] = rooms;
  }
}

function populateStageFilter() {
  const sel = document.getElementById('stage-filter');
  if (!sel || !state.workflow?.stages) return;
  sel.innerHTML = `<option value="">All stages</option>` +
    Object.entries(state.workflow.stages).map(([key, s]) =>
      `<option value="${key}">${escHtml(s.label)}</option>`
    ).join('');
}

// ── Filters ───────────────────────────────────────────────────────────────────
function filterDeals(query) {
  const q = (query || '').toLowerCase();
  state.filteredContacts = q
    ? state.contacts.filter(c =>
        contactName(c).toLowerCase().includes(q) ||
        (c.properties?.email || '').toLowerCase().includes(q))
    : [...state.contacts];
  renderCustomerList();
}

function setStageFilter(value) {
  state.stageFilter = value;
  renderCustomerList();
}

function toggleArchived() {
  state.showArchived = !state.showArchived;
  const btn = document.getElementById('archived-toggle');
  if (btn) btn.classList.toggle('filter-btn-active', state.showArchived);
  renderCustomerList();
}

async function refreshDeals() {
  await Promise.all([loadOpenLeads(), loadWorkflowStages()]);
  renderCustomerList();
  if (state.selectedContact) {
    state.selectedContact = state.contacts.find(c => c.id === state.selectedContactId);
    renderWorkflowHeader();
  }
}

// ── Build List Items ──────────────────────────────────────────────────────────
function buildListItems() {
  const items = [];
  for (const contact of state.filteredContacts) {
    const cached = state.contactStageCache[contact.id];
    if (cached && cached.length > 0) {
      cached.forEach((r, idx) => {
        const roomStatus = r.roomStatus || 'active';
        if (roomStatus !== 'active' && !state.showArchived) return;
        if (state.stageFilter && r.stageKey !== state.stageFilter) return;
        items.push({ contact, roomIdx: idx, roomName: r.room, stageKey: r.stageKey, roomStatus });
      });
    } else {
      // No local data yet — default to Sales
      if (!state.stageFilter || state.stageFilter === 'sales') {
        items.push({ contact, roomIdx: 0, roomName: null, stageKey: 'sales', roomStatus: 'active' });
      }
    }
  }
  return items;
}

// ── Customer List ─────────────────────────────────────────────────────────────
function renderCustomerList() {
  const list  = document.getElementById('customer-list');
  const count = document.getElementById('deal-count');
  const items = buildListItems();

  if (!items.length) {
    list.innerHTML = `<div class="p-4 text-sm text-slate-400 text-center mt-4">No customers match</div>`;
    count.textContent = '';
    return;
  }

  count.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;

  list.innerHTML = items.map(({ contact, roomIdx, roomName, stageKey, roomStatus }) => {
    const name       = contactName(contact);
    const email      = contact.properties?.email || '';
    const colour     = stageKey ? stageColour(stageKey) : null;
    const stageLabel = stageKey ? (state.workflow?.stages?.[stageKey]?.label || stageKey) : null;
    const isSelected = contact.id === state.selectedContactId && roomIdx === state.selectedRoomIdx;
    const urgency    = state.contactUrgencyCache[contact.id];
    const isArchived = roomStatus !== 'active';
    const multiRoom  = (state.contactStageCache[contact.id]?.length || 0) > 1;
    const displayName = (multiRoom && roomName && roomName !== 'Main')
      ? `${name} — ${roomName}` : name;

    const urgencyDot = urgency === 'red'
      ? `<span class="urgency-dot urgency-red" title="Urgent: task due within 1 working day"></span>`
      : urgency === 'orange'
        ? `<span class="urgency-dot urgency-orange" title="Task due within 2 working days"></span>`
        : '';

    const qbInvs    = matchInvoicesForContact(contact);
    const qbTotal   = qbInvs.reduce((s, inv) => s + inv.balance, 0);
    const qbBadge   = qbInvs.length > 0
      ? `<span class="qb-badge" title="${qbInvs.length} outstanding invoice${qbInvs.length !== 1 ? 's' : ''}">£${qbTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
      : '';

    const stagePillHtml = stageLabel && colour
      ? `<span class="stage-pill" style="background:${colour.light};color:${colour.text}">${escHtml(stageLabel)}</span>`
      : `<span class="stage-pill" style="background:${stageColour('sales').light};color:${stageColour('sales').text}">Sales</span>`;

    const statusLabel = roomStatus === 'declined' ? 'Declined' : roomStatus === 'complete' ? 'Complete' : roomStatus === 'remedial' ? 'Remedial' : 'Active';
    const statusMini = `<span class="status-mini status-mini-${roomStatus}" onclick="openStatusPicker(event,'${contact.id}',${roomIdx})" title="Change status">${statusLabel}</span>`;

    return `
      <div class="customer-card ${isSelected ? 'selected' : ''} ${isArchived ? 'card-archived' : ''}"
           data-contact-id="${contact.id}" data-room-idx="${roomIdx}"
           onclick="selectContact('${contact.id}', ${roomIdx})">
        <div class="customer-card-name">
          ${urgencyDot}<span class="name-text">${escHtml(displayName)}</span>
          ${statusMini}
        </div>
        <div class="customer-card-meta">
          ${stagePillHtml}
          ${qbBadge}
          ${email ? `<span class="customer-card-value">${escHtml(email)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// ── Quick Card Actions ────────────────────────────────────────────────────────

// Load, apply an updater fn, save, and refresh the list — without opening the workflow
async function quickLoadAndUpdate(contactId, roomIdx, updater) {
  if (contactId === state.selectedContactId) {
    // Modify in-memory state directly
    updater(state.allRooms, roomIdx);
    updateRoomCache();
    try { await saveWorkflowData(); } catch { showToast('Failed to save', true); return; }
    renderCustomerList();
    if (state.selectedRoomIdx === roomIdx) {
      renderWorkflowHeader();
      renderRoomTabs();
      renderWorkflowStages();
    }
    return;
  }
  let rooms;
  try { rooms = await GET(`/api/contacts/${contactId}/localdata`); } catch { rooms = null; }
  if (!Array.isArray(rooms) || rooms.length === 0) {
    rooms = [{ room: 'Main', stageKey: 'sales', statusId: null, comments: [], roomStatus: 'active' }];
  }
  rooms = rooms.map(r => ({
    room: r.room || 'Main', stageKey: r.stageKey || 'sales',
    statusId: r.statusId || null, comments: r.comments || [],
    roomStatus: r.roomStatus || 'active'
  }));
  if (roomIdx >= rooms.length) roomIdx = rooms.length - 1;
  updater(rooms, roomIdx);
  try { await POST(`/api/contacts/${contactId}/localdata`, rooms); } catch { showToast('Failed to save', true); return; }
  state.contactStageCache[contactId] = rooms.map(r => ({
    room: r.room, stageKey: r.stageKey, roomStatus: r.roomStatus || 'active'
  }));
  renderCustomerList();
}

function closeCardPicker() {
  document.getElementById('card-picker-popup')?.remove();
  document.removeEventListener('click', closeCardPicker);
}

function openStagePicker(event, contactId, roomIdx) {
  event.stopPropagation();
  closeCardPicker();
  const rect = event.currentTarget.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.id = 'card-picker-popup';
  popup.className = 'card-picker-popup';
  // Use viewport coords (position: fixed)
  const top = Math.min(rect.bottom + 4, window.innerHeight - 320);
  popup.style.cssText = `top:${top}px;left:${Math.max(4, rect.left)}px;`;
  popup.innerHTML = Object.entries(state.workflow?.stages || {}).map(([key, s]) =>
    `<button class="card-picker-opt" onclick="quickSetStage('${contactId}',${roomIdx},'${key}')">${escHtml(s.label)}</button>`
  ).join('');
  document.body.appendChild(popup);
  setTimeout(() => document.addEventListener('click', closeCardPicker, { once: true }), 0);
}

async function quickSetStage(contactId, roomIdx, stageKey, showUndo = true) {
  closeCardPicker();
  const prevStageKey = state.contactStageCache[contactId]?.[roomIdx]?.stageKey || null;
  await quickLoadAndUpdate(contactId, roomIdx, (rooms, idx) => {
    if (rooms[idx]) { rooms[idx].stageKey = stageKey; rooms[idx].statusId = null; }
  });
  if (showUndo && prevStageKey && prevStageKey !== stageKey) {
    const newLabel = state.workflow?.stages?.[stageKey]?.label || stageKey;
    showBottomUndo(`Stage changed to ${newLabel}`, () => quickSetStage(contactId, roomIdx, prevStageKey, false));
  }
}

function openStatusPicker(event, contactId, roomIdx) {
  event.stopPropagation();
  closeCardPicker();
  const rect = event.currentTarget.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.id = 'card-picker-popup';
  popup.className = 'card-picker-popup';
  const top = Math.min(rect.bottom + 4, window.innerHeight - 140);
  popup.style.cssText = `top:${top}px;left:${Math.max(4, rect.left)}px;`;
  popup.innerHTML = [
    { value: 'active',   label: 'Active' },
    { value: 'declined', label: 'Declined' },
    { value: 'complete', label: 'Complete' },
    { value: 'remedial', label: 'Remedial' }
  ].map(({ value, label }) =>
    `<button class="card-picker-opt card-picker-status-${value}" onclick="confirmStatusChange('${contactId}',${roomIdx},'${value}')">${label}</button>`
  ).join('');
  document.body.appendChild(popup);
  setTimeout(() => document.addEventListener('click', closeCardPicker, { once: true }), 0);
}

async function confirmStatusChange(contactId, roomIdx, newStatus) {
  closeCardPicker();
  const prevStatus = state.contactStageCache[contactId]?.[roomIdx]?.roomStatus || 'active';
  if (prevStatus === newStatus) return;
  await quickLoadAndUpdate(contactId, roomIdx, (rooms, idx) => {
    if (rooms[idx]) rooms[idx].roomStatus = newStatus;
  });
  const labels = { active: 'Active', declined: 'Declined', complete: 'Complete', remedial: 'Remedial' };
  showBottomUndo(`Status set to ${labels[newStatus] || newStatus}`, async () => {
    await quickLoadAndUpdate(contactId, roomIdx, (rooms, idx) => {
      if (rooms[idx]) rooms[idx].roomStatus = prevStatus;
    });
  });
}

async function quickSetRoomStatus(contactId, roomIdx, newStatus) {
  await quickLoadAndUpdate(contactId, roomIdx, (rooms, idx) => {
    if (rooms[idx]) rooms[idx].roomStatus = newStatus;
  });
  renderCustomerList();
}

// ── Bottom action bar ─────────────────────────────────────────────────────────
// Card-list operations: save immediately, undo reverts with a second save
let _bottomAction = null;
let _bottomTimer  = null;

// Workflow view: save is deferred until the undo bar expires
let _deferredSave     = null; // { timerId }
let _deferredSnapshot = null; // deep copy of allRooms BEFORE latest change

function closeBottomBar() {
  document.getElementById('bottom-bar')?.remove();
  if (_bottomTimer) { clearTimeout(_bottomTimer); _bottomTimer = null; }
  _bottomAction = null;
}

// Flush any deferred save immediately (call on navigation away from current contact)
async function flushDeferredSave() {
  if (_deferredSave) {
    clearTimeout(_deferredSave.timerId);
    _deferredSave = null;
    _deferredSnapshot = null;
    closeBottomBar();
    try { await saveWorkflowData(); } catch { showToast('Failed to save', true); }
  }
}

// Deferred save with undo bar — for workflow view changes.
// snapshotRooms: deep copy of allRooms taken BEFORE the change was applied.
function scheduleSave(undoMessage, snapshotRooms) {
  // Cancel any existing pending save (new timer will cover all accumulated changes)
  if (_deferredSave) {
    clearTimeout(_deferredSave.timerId);
    _deferredSave = null;
  }
  _deferredSnapshot = snapshotRooms;
  closeBottomBar();

  const timerId = setTimeout(async () => {
    _deferredSave = null;
    _deferredSnapshot = null;
    closeBottomBar();
    try { await saveWorkflowData(); } catch { showToast('Failed to save', true); }
  }, 5000);
  _deferredSave = { timerId };

  const el = document.createElement('div');
  el.id = 'bottom-bar';
  el.className = 'bottom-bar';
  el.innerHTML = `
    <span class="bottom-bar-msg">${escHtml(undoMessage)}</span>
    <button class="bottom-bar-undo" onclick="undoLastChange()">Undo</button>
    <div class="bottom-bar-progress"></div>
  `;
  document.body.appendChild(el);
}

async function undoLastChange() {
  if (_deferredSave) {
    clearTimeout(_deferredSave.timerId);
    _deferredSave = null;
  }
  if (!_deferredSnapshot) { closeBottomBar(); return; }
  const snapshot = _deferredSnapshot;
  _deferredSnapshot = null;
  closeBottomBar();

  state.allRooms = snapshot;
  state.workflowData = state.allRooms[state.selectedRoomIdx] || null;
  state.expandedStages = new Set();
  updateRoomCache();
  renderCustomerList();
  if (state.workflowData) {
    renderWorkflowStages();
    renderWorkflowHeader();
    renderRoomTabs();
  }
  if (state.activeTab === 'projects') renderProjectsView();
  // Save the restored state so disk matches memory
  try { await saveWorkflowData(); } catch { showToast('Failed to save', true); }
}

// Immediate-save undo bar — for card-list changes (saves right away, undo makes a second save)
function showBottomUndo(message, onUndo) {
  closeBottomBar();
  _bottomAction = onUndo;
  const el = document.createElement('div');
  el.id = 'bottom-bar';
  el.className = 'bottom-bar';
  el.innerHTML = `
    <span class="bottom-bar-msg">${escHtml(message)}</span>
    <button class="bottom-bar-undo" onclick="runBottomAction()">Undo</button>
    <div class="bottom-bar-progress"></div>
  `;
  document.body.appendChild(el);
  _bottomTimer = setTimeout(closeBottomBar, 5000);
}

function showBottomConfirm(message, onConfirm) {
  closeBottomBar();
  _bottomAction = onConfirm;
  const el = document.createElement('div');
  el.id = 'bottom-bar';
  el.className = 'bottom-bar';
  el.innerHTML = `
    <span class="bottom-bar-msg">${escHtml(message)}</span>
    <div class="bottom-bar-btns">
      <button class="bottom-bar-cancel" onclick="closeBottomBar()">Cancel</button>
      <button class="bottom-bar-confirm" onclick="runBottomAction()">Confirm</button>
    </div>
  `;
  document.body.appendChild(el);
}

async function runBottomAction() {
  const fn = _bottomAction;
  closeBottomBar();
  if (fn) await fn();
}

// ── Tab Navigation ────────────────────────────────────────────────────────────
function setTab(tab) {
  state.activeTab = tab;
  ['customers', 'tasks', 'projects', 'invoices'].forEach(t => {
    document.getElementById(`tab-${t}`)?.classList.toggle('hidden', tab !== t);
    document.getElementById(`tab-btn-${t}`)?.classList.toggle('header-tab-active', tab === t);
  });
  document.getElementById('refresh-btn').classList.toggle('hidden', tab !== 'customers');
  if (tab === 'tasks')    loadTasksView();
  if (tab === 'projects') renderProjectsView();
  if (tab === 'invoices') renderInvoicesTab();
}

// ── Projects View ─────────────────────────────────────────────────────────────
function setProjectStageFilter(key) {
  state.projectStageFilter = key;
  renderProjectsView();
}

function renderProjectsView() {
  const view = document.getElementById('projects-view');
  if (!view) return;

  const filter = state.projectStageFilter;

  // Collect contacts that have at least one active room with saved data
  const rows = [];
  for (const contact of state.contacts) {
    const cached = state.contactStageCache[contact.id];
    if (!cached || cached.length === 0) continue;
    const activeRooms = cached
      .map((r, idx) => ({ ...r, roomIdx: idx }))
      .filter(r => (r.roomStatus || 'active') === 'active')
      .filter(r => !filter || r.stageKey === filter);
    if (!activeRooms.length) continue;
    rows.push({ contact, rooms: activeRooms });
  }

  // Sort by most advanced room stage, later stages first
  rows.sort((a, b) => {
    const maxStage = row => Math.max(...row.rooms.map(r => STAGE_KEYS.indexOf(r.stageKey)));
    return maxStage(b) - maxStage(a);
  });

  // Within each row, sort rooms by stage descending
  rows.forEach(row => row.rooms.sort((a, b) =>
    STAGE_KEYS.indexOf(b.stageKey) - STAGE_KEYS.indexOf(a.stageKey)
  ));

  const stageTabs = [
    { key: '', label: 'All' },
    ...STAGE_KEYS.map(k => ({ key: k, label: state.workflow?.stages?.[k]?.label || k }))
  ].map(({ key, label }) => {
    const colour  = key ? stageColour(key) : null;
    const active  = filter === key;
    const style   = active && colour
      ? `background:${colour.bg};color:#fff;border-color:${colour.bg}`
      : active
        ? 'background:var(--plum);color:#fff;border-color:var(--plum)'
        : '';
    return `<button class="project-stage-tab ${active ? 'project-stage-tab-active' : ''}"
      style="${style}" onclick="setProjectStageFilter('${key}')">${escHtml(label)}</button>`;
  }).join('');

  const bodyHtml = !rows.length
    ? `<p style="color:var(--stone-deep);font-size:0.875rem;padding:8px 0;">No projects at this stage.</p>`
    : rows.map(({ contact, rooms }) => `
        <div class="project-row">
          <div class="project-row-name">${escHtml(contactName(contact))}</div>
          <div class="project-cards-scroll">
            ${rooms.map(r => projectCardHtml(contact.id, r)).join('')}
          </div>
        </div>
      `).join('');

  view.innerHTML = `
    <div class="project-stage-tabs-bar">
      ${stageTabs}
    </div>
    <div class="projects-inner">
      ${bodyHtml}
    </div>
  `;
}

function projectCardHtml(contactId, room) {
  const colour     = stageColour(room.stageKey);
  const stageLabel = state.workflow?.stages?.[room.stageKey]?.label || room.stageKey;
  const stageIdx   = STAGE_KEYS.indexOf(room.stageKey);
  const progress   = Math.round((stageIdx + 1) / STAGE_KEYS.length * 100);
  return `
    <div class="project-card" onclick="openProject('${contactId}', ${room.roomIdx})">
      <div class="project-card-room">${escHtml(room.room || 'Main')}</div>
      <span class="stage-pill" style="background:${colour.light};color:${colour.text}">${escHtml(stageLabel)}</span>
      <div class="project-progress-bar">
        <div class="project-progress-fill" style="width:${progress}%;background:${colour.bg}"></div>
      </div>
      <div class="project-progress-label">${stageIdx + 1} of ${STAGE_KEYS.length} stages</div>
    </div>
  `;
}

function openProject(contactId, roomIdx) {
  setTab('customers');
  selectContact(contactId, roomIdx);
}

// ── Tasks View ────────────────────────────────────────────────────────────────
async function loadTasksView() {
  const view = document.getElementById('tasks-view');
  view.innerHTML = `<div class="tasks-inner"><div class="flex items-center gap-2 text-sm" style="color:var(--stone-deep)"><div class="spinner"></div> Loading...</div></div>`;
  const [tasks, calData] = await Promise.all([
    GET('/api/personal-tasks').catch(() => []),
    GET('/api/calendar/upcoming').catch(() => ({ events: [], connected: false }))
  ]);
  state.personalTasks    = tasks;
  state.calendarEvents   = calData.events || [];
  state.calendarConnected = calData.connected || false;
  renderTasksView();
}

function renderTasksView() {
  const view = document.getElementById('tasks-view');
  if (!view) return;

  const today   = new Date(); today.setHours(0,0,0,0);
  const todayStr = today.toISOString().slice(0,10);
  const in7days  = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

  const pending  = state.personalTasks.filter(t => !t.done);
  const done     = state.personalTasks.filter(t => t.done);

  const overdue  = pending.filter(t => t.dueDate && t.dueDate < todayStr);
  const todayTasks  = pending.filter(t => t.dueDate === todayStr);
  const upcoming = pending.filter(t => t.dueDate && t.dueDate > todayStr && new Date(t.dueDate) <= in7days);
  const later    = pending.filter(t => !t.dueDate || new Date(t.dueDate) > in7days);

  const taskGroup = (label, tasks, colour) => {
    if (!tasks.length) return '';
    return `
      <div class="task-group">
        <div class="task-group-label" style="color:${colour}">${label}</div>
        ${tasks.map(t => personalTaskHtml(t)).join('')}
      </div>`;
  };

  const addForm = state.showAddPersonalTask ? `
    <div class="ptask-add-form">
      <input id="ptask-title" type="text" placeholder="Task title"
        class="ptask-input" onkeydown="if(event.key==='Enter')submitPersonalTask()">
      <div class="flex gap-2 mt-2 items-center">
        <input id="ptask-due" type="date" class="ptask-date-input">
        <div style="flex:1"></div>
        <button onclick="state.showAddPersonalTask=false;renderTasksView()" class="ptask-cancel-btn">Cancel</button>
        <button onclick="submitPersonalTask()" class="ptask-confirm-btn">Add task</button>
      </div>
    </div>
  ` : `
    <button onclick="state.showAddPersonalTask=true;renderTasksView();setTimeout(()=>document.getElementById('ptask-title')?.focus(),30)"
      class="ptask-add-btn">+ Add task</button>
  `;

  const calSection = `
    <div class="tasks-section-heading">Google Calendar — next 14 days</div>
    ${!state.calendarConnected
      ? `<div class="cal-connect-prompt">
           <p style="font-size:0.875rem;color:var(--ink-3);margin-bottom:12px;">Connect Google Calendar to see upcoming events here.</p>
           <a href="/auth/google" class="ptask-confirm-btn" style="text-decoration:none;display:inline-block;">Connect Google</a>
         </div>`
      : state.calendarEvents.length === 0
        ? `<p style="font-size:0.875rem;color:var(--stone-deep);padding:8px 0;">No events in the next 14 days.</p>`
        : state.calendarEvents.map(ev => calEventHtml(ev)).join('')
    }
  `;

  const doneSection = done.length ? `
    <details class="done-details">
      <summary class="done-summary">Completed (${done.length})</summary>
      <div style="margin-top:8px">${done.map(t => personalTaskHtml(t)).join('')}</div>
    </details>
  ` : '';

  view.innerHTML = `
    <div class="tasks-inner">
      <div class="tasks-section-heading">My tasks</div>
      ${addForm}
      ${taskGroup('Overdue', overdue, '#dc2626')}
      ${taskGroup('Today', todayTasks, 'var(--orchid)')}
      ${taskGroup('This week', upcoming, 'var(--ink-2)')}
      ${taskGroup('No date / later', later, 'var(--ink-3)')}
      ${!pending.length && !state.showAddPersonalTask
        ? `<p style="font-size:0.875rem;color:var(--stone-deep);padding:4px 0 16px;">No pending tasks.</p>` : ''}
      ${doneSection}
      <div style="margin-top:32px">
        ${calSection}
      </div>
    </div>
  `;
}

function personalTaskHtml(task) {
  const isDone = task.done;
  const overdue = !isDone && task.dueDate && task.dueDate < new Date().toISOString().slice(0,10);
  const dueFmt = task.dueDate
    ? new Date(task.dueDate + 'T12:00:00').toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
    : '';
  return `
    <div class="ptask-item ${isDone ? 'ptask-done' : ''}">
      <button class="task-check ${isDone ? 'task-check-done' : ''}"
        onclick="togglePersonalTask('${task.id}')"
        aria-label="${isDone ? 'Mark incomplete' : 'Mark complete'}">
        ${isDone ? `<svg width="11" height="9" fill="none" stroke="currentColor" viewBox="0 0 12 10"><polyline points="1,5 4.5,8.5 11,1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` : ''}
      </button>
      <div class="task-content">
        <div class="task-subject ${isDone ? 'task-subject-done' : ''}">${escHtml(task.title)}</div>
        ${dueFmt ? `<div class="task-due ${overdue ? 'task-due-overdue' : ''}">${overdue ? 'Overdue — ' : ''}${dueFmt}</div>` : ''}
      </div>
      <button class="task-delete" onclick="deletePersonalTask('${task.id}')" aria-label="Delete">
        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>
  `;
}

function calEventHtml(ev) {
  const start = ev.start?.dateTime || ev.start?.date;
  const isAllDay = !!ev.start?.date;
  const startDate = start ? new Date(isAllDay ? start + 'T00:00:00' : start) : null;
  const dateFmt = startDate
    ? startDate.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' })
    : '';
  const timeFmt = (!isAllDay && startDate)
    ? startDate.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })
    : 'All day';
  return `
    <div class="cal-event-item">
      <div class="cal-event-date">${dateFmt}</div>
      <div class="cal-event-body">
        <div class="cal-event-title">${escHtml(ev.summary || 'Untitled event')}</div>
        <div class="cal-event-time">${timeFmt}${ev.location ? ` · ${escHtml(ev.location)}` : ''}</div>
      </div>
    </div>
  `;
}

async function submitPersonalTask() {
  const title = document.getElementById('ptask-title')?.value.trim();
  const due   = document.getElementById('ptask-due')?.value || null;
  if (!title) return;
  try {
    const task = await POST('/api/personal-tasks', { title, dueDate: due });
    state.personalTasks.push(task);
    state.showAddPersonalTask = false;
    renderTasksView();
  } catch { showToast('Failed to save task', true); }
}

async function togglePersonalTask(id) {
  const task = state.personalTasks.find(t => t.id === id);
  if (!task) return;
  try {
    const updated = await PATCH_REQ(`/api/personal-tasks/${id}`, { done: !task.done });
    Object.assign(task, updated);
    renderTasksView();
  } catch { showToast('Failed to update task', true); }
}

async function deletePersonalTask(id) {
  try {
    await DELETE_REQ(`/api/personal-tasks/${id}`);
    state.personalTasks = state.personalTasks.filter(t => t.id !== id);
    renderTasksView();
  } catch { showToast('Failed to delete task', true); }
}

// ── Auth Status ───────────────────────────────────────────────────────────────
function renderAuthStatus() {
  const el = document.getElementById('auth-status');
  const { google, hubspot } = state.authStatus;
  const user = state.user;
  const dot = ok => `<span class="auth-dot ${ok ? 'auth-dot-ok' : 'auth-dot-off'}"></span>`;
  const userName = user
    ? escHtml([user.first_name, user.last_name].filter(Boolean).join(' ') || user.email || 'Account')
    : '';
  const userBadge = user
    ? `<div class="flex items-center gap-2 text-xs text-slate-300">
         ${user.profile_image_url
           ? `<img src="${escHtml(user.profile_image_url)}" alt="" style="width:22px;height:22px;border-radius:50%;object-fit:cover;">`
           : ''}
         <span class="hidden sm:inline">${userName}</span>
         ${user.isAdmin ? '<a href="/admin.html" class="text-slate-400 hover:text-white text-xs transition" title="Admin">Admin</a>' : ''}
         <a href="/api/logout" class="text-slate-400 hover:text-white text-xs transition" title="Sign out">Sign out</a>
       </div>`
    : `<a href="/api/login" class="connect-btn connect-btn-google">Sign in</a>`;
  el.innerHTML = `
    <div class="flex items-center gap-1 text-xs text-slate-400">
      ${dot(hubspot)}<span class="hidden sm:inline">HubSpot</span>
    </div>
    ${google
      ? `<div class="flex items-center gap-1 text-xs text-slate-400">
           ${dot(true)}<span class="hidden sm:inline">Google</span>
           <button onclick="logoutGoogle()" class="hidden sm:inline text-slate-500 hover:text-white ml-1 text-xs transition">disconnect</button>
         </div>`
      : `<a href="/auth/google" class="connect-btn connect-btn-google">
           + <span class="hidden sm:inline">Google</span><span class="sm:hidden">G</span>
         </a>`
    }
    ${userBadge}
  `;
}

async function logoutGoogle() {
  await GET('/auth/logout-google');
  state.authStatus.google = false;
  renderAuthStatus();
}

// ── Mobile Panel Navigation ───────────────────────────────────────────────────
function showWorkflowPanel() {
  document.body.classList.add('showing-workflow');
  const wp = document.getElementById('workflow-panel');
  if (wp) wp.scrollTop = 0;
}

async function goBack() {
  captureNotes();
  await flushDeferredSave();
  if (state.selectedContactId) { try { await saveWorkflowData(); } catch {} }
  document.body.classList.remove('showing-workflow');
  document.getElementById('empty-state').classList.remove('hidden');
  document.getElementById('workflow-view').classList.add('hidden');
  state.selectedContactId = null;
  state.selectedContact   = null;
  state.selectedRoomIdx   = 0;
  state.allRooms          = [];
  state.workflowData      = null;
  state.customerNotes     = '';
  state.tasks             = [];
  document.querySelectorAll('.customer-card').forEach(el => el.classList.remove('selected'));
}

// ── HubSpot lead status → Sales stage sync ───────────────────────────────────
// Maps a contact's HubSpot hs_lead_status to Sales stage tasks + auto-rules.
// Only applies if the room is currently at the Sales stage.
const HS_SALES_PROGRESSION = {
  'form_submission':        ['form_submission'],
  'attempted_contact':      ['form_submission', 'attempted_contact'],
  'attempted_to_contact':   ['form_submission', 'attempted_contact'],
  'in_progress':            ['form_submission', 'attempted_contact', 'in_progress'],
  'awaiting_photos':        ['form_submission', 'attempted_contact', 'in_progress', 'awaiting_photos'],
  'rough_estimate':         ['form_submission', 'attempted_contact', 'in_progress', 'awaiting_photos', 'rough_estimate'],
};
const HS_DECLINE_STATUSES = ['unqualified', 'not_suitable', 'bad_timing'];
const HS_ADVANCE_STATUSES  = ['open_deal', 'visit_scheduled'];

function syncRoomFromHubSpot(room, leadStatus) {
  if (!leadStatus) return room;
  const ls = leadStatus.toLowerCase().replace(/-/g, '_');

  const allSalesTasks = DEFAULT_WORKFLOW.stages.sales.statuses.map(s => s.id);
  const cs = { ...room.completedStatuses };

  if (HS_DECLINE_STATUSES.includes(ls)) {
    // Mark all sales tasks done and decline the room (only if still in Sales)
    cs.sales = allSalesTasks;
    return {
      ...room,
      completedStatuses: cs,
      roomStatus: room.stageKey === 'sales' ? 'declined' : room.roomStatus
    };
  }

  if (HS_ADVANCE_STATUSES.includes(ls) && room.stageKey === 'sales') {
    // All sales tasks done, advance to Design Visit
    cs.sales = allSalesTasks;
    return { ...room, stageKey: 'designvisit', completedStatuses: cs };
  }

  if (HS_SALES_PROGRESSION[ls] && room.stageKey === 'sales') {
    // Set which Sales tasks are completed based on lead status
    cs.sales = HS_SALES_PROGRESSION[ls];
    return { ...room, completedStatuses: cs };
  }

  return room;
}

// ── Contact Selection ─────────────────────────────────────────────────────────
async function selectContact(contactId, roomIdx = 0) {
  // Always flush unsaved notes/workflow for current contact before switching
  captureNotes();
  if (state.selectedContactId && state.selectedContactId !== contactId) {
    await flushDeferredSave();
    try { await saveWorkflowData(); } catch {}
  }
  if (state.loadingContact) return;
  state.loadingContact = true;

  state.selectedContactId = contactId;
  state.selectedContact   = state.contacts.find(c => c.id === contactId);
  state.selectedRoomIdx   = roomIdx;
  state.allRooms          = [];
  state.workflowData      = null;
  state.expandedStages    = new Set();
  state.tasks             = [];
  state.showAddTask       = false;
  state.addingRoom        = false;

  showWorkflowPanel();
  document.getElementById('empty-state').classList.add('hidden');
  const wv = document.getElementById('workflow-view');
  wv.classList.remove('hidden');
  wv.innerHTML = `<div class="flex items-center justify-center h-64 text-slate-400 gap-3"><div class="spinner"></div> Loading...</div>`;

  try {
    const [localData, tasksData] = await Promise.all([
      GET(`/api/contacts/${contactId}/localdata`).catch(() => null),
      GET(`/api/contacts/${contactId}/tasks`).catch(() => ({ results: [] }))
    ]);
    state.tasks = tasksData.results || [];
    state.contactUrgencyCache[contactId] = getTaskUrgency(state.tasks);

    if (Array.isArray(localData) && localData.length > 0) {
      // Old format — plain rooms array
      state.allRooms = localData;
      state.customerNotes = '';
    } else if (localData && Array.isArray(localData.rooms) && localData.rooms.length > 0) {
      // New format — { rooms, notes }
      state.allRooms = localData.rooms;
      state.customerNotes = localData.notes || '';
    } else {
      state.allRooms = [{ room: 'Main', stageKey: 'sales', completedStatuses: {}, comments: [], roomStatus: 'active', stageDates: { sales: todayISO() } }];
      state.customerNotes = '';
    }

    // Normalise all rooms — migrate old statusId → completedStatuses
    state.allRooms = state.allRooms.map(r => {
      let cs = r.completedStatuses ? { ...r.completedStatuses } : {};
      if (!r.completedStatuses && state.workflow) {
        const sk  = r.stageKey || 'sales';
        const idx = STAGE_KEYS.indexOf(sk);
        // Past stages: all tasks done
        STAGE_KEYS.slice(0, idx).forEach(k => {
          const s = state.workflow.stages[k];
          if (s) cs[k] = s.statuses.map(st => st.id);
        });
        // Current stage: up to and including old statusId
        if (r.statusId) {
          const stage = state.workflow.stages[sk];
          if (stage) {
            const si = stage.statuses.findIndex(st => st.id === r.statusId);
            if (si >= 0) cs[sk] = stage.statuses.slice(0, si + 1).map(st => st.id);
          }
        }
      }
      const stageDates = r.stageDates ? { ...r.stageDates } : {};
      // Backfill: every room was at least in sales at some point
      if (!stageDates.sales) stageDates.sales = todayISO();
      return {
        room:              r.room       || 'Main',
        stageKey:          r.stageKey   || 'sales',
        completedStatuses: cs,
        comments:          r.comments   || [],
        roomStatus:        r.roomStatus || 'active',
        stageDates,
        installStart:      r.installStart  || null,
        installFinish:     r.installFinish || null,
      };
    });

    // Sync Sales stage from HubSpot lead status
    const leadStatus = state.selectedContact?.properties?.hs_lead_status;
    if (leadStatus) {
      const synced = state.allRooms.map(r => syncRoomFromHubSpot(r, leadStatus));
      const changed = JSON.stringify(synced) !== JSON.stringify(state.allRooms);
      state.allRooms = synced;
      if (changed) {
        // Persist the synced state immediately (no deferred save needed)
        POST(`/api/contacts/${contactId}/localdata`, { rooms: state.allRooms, notes: state.customerNotes })
          .catch(() => {});
      }
    }

    state.selectedRoomIdx = Math.min(roomIdx, state.allRooms.length - 1);
    state.workflowData = state.allRooms[state.selectedRoomIdx];

    updateRoomCache();
    renderCustomerList();
    renderFullWorkflowView();
  } catch (e) {
    wv.innerHTML = `<div class="p-6 text-red-500 text-sm">Failed to load: ${escHtml(e.message)}</div>`;
  } finally {
    state.loadingContact = false;
  }
}

// ── Room Management ───────────────────────────────────────────────────────────
async function switchRoom(idx) {
  if (idx === state.selectedRoomIdx) return;
  captureNotes();
  await flushDeferredSave();
  try { await saveWorkflowData(); } catch {}
  state.selectedRoomIdx = idx;
  state.workflowData = state.allRooms[idx];
  state.expandedStages = new Set();
  renderFullWorkflowView();
}

function showAddRoomForm() {
  state.addingRoom = true;
  renderRoomTabs();
  setTimeout(() => document.getElementById('new-room-name')?.focus(), 30);
}

function hideAddRoomForm() {
  state.addingRoom = false;
  renderRoomTabs();
}

async function submitAddRoom() {
  const input = document.getElementById('new-room-name');
  const name = input?.value.trim() || `Room ${state.allRooms.length + 1}`;
  state.allRooms.push({ room: name, stageKey: 'sales', completedStatuses: {}, comments: [], roomStatus: 'active', stageDates: { sales: todayISO() } });
  state.selectedRoomIdx = state.allRooms.length - 1;
  state.workflowData = state.allRooms[state.selectedRoomIdx];
  state.addingRoom = false;
  updateRoomCache();
  renderCustomerList();
  try { await saveWorkflowData(); } catch { showToast('Failed to save room', true); }
  renderFullWorkflowView();
}

function deleteRoom(idx) {
  if (state.allRooms.length <= 1) return;
  const snapshot = JSON.parse(JSON.stringify(state.allRooms));
  const prevSelected = state.selectedRoomIdx;
  const removed = state.allRooms[idx];
  const removedName = removed?.room || `Room ${idx + 1}`;

  state.allRooms.splice(idx, 1);
  if (state.selectedRoomIdx >= state.allRooms.length) {
    state.selectedRoomIdx = state.allRooms.length - 1;
  } else if (idx < prevSelected) {
    state.selectedRoomIdx = prevSelected - 1;
  }
  state.workflowData = state.allRooms[state.selectedRoomIdx] || null;

  updateRoomCache();
  renderCustomerList();
  renderFullWorkflowView();
  scheduleSave(`Deleted "${removedName}"`, snapshot);
}

function setRoomStatus(value) {
  const snapshot = JSON.parse(JSON.stringify(state.allRooms));
  state.workflowData.roomStatus = value;
  updateRoomCache();
  renderCustomerList();
  renderWorkflowHeader();
  const labels = { active: 'Active', declined: 'Declined', complete: 'Complete', remedial: 'Remedial' };
  scheduleSave(`Status changed to ${labels[value] || value}`, snapshot);
}

// ── Full Workflow View ────────────────────────────────────────────────────────
function renderFullWorkflowView() {
  const wv = document.getElementById('workflow-view');
  wv.innerHTML = `
    <button class="back-btn" onclick="goBack()">
      <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7"/>
      </svg>
      Customers
    </button>
    <div id="workflow-header" class="bg-white border-b border-slate-200 px-4 sm:px-6 py-4 sticky top-0 z-10 shadow-sm"></div>
    <div class="workflow-inner">
      <div id="comments-section" class="mb-5"></div>
      <div id="room-tabs-section" class="mb-5"></div>
      <div id="invoices-section" class="mb-5"></div>
      <div id="tasks-section" class="mb-6"></div>
      <div id="workflow-stages" class="space-y-2"></div>
    </div>
  `;
  renderWorkflowHeader();
  renderComments();
  renderRoomTabs();
  renderWorkflowInvoices();
  renderTasks();
  renderWorkflowStages();
  renderComments();
}

// captureNotes retained as no-op — called before navigation to flush any pending state
function captureNotes() {}

// ── Room Tabs ─────────────────────────────────────────────────────────────────
function renderRoomTabs() {
  const el = document.getElementById('room-tabs-section');
  if (!el) return;

  const roomStatus = state.workflowData?.roomStatus || 'active';
  const canDelete = state.allRooms.length > 1;
  const tabs = state.allRooms.map((r, idx) => `
    <span class="room-tab-wrap ${idx === state.selectedRoomIdx ? 'room-tab-wrap-active' : ''}">
      <button onclick="switchRoom(${idx})"
        class="room-tab ${idx === state.selectedRoomIdx ? 'room-tab-active' : ''}">
        ${escHtml(r.room || `Room ${idx + 1}`)}
      </button>
      ${canDelete ? `<button class="room-tab-del" title="Delete room"
        onclick="event.stopPropagation();deleteRoom(${idx})">×</button>` : ''}
    </span>
  `).join('');

  const addForm = state.addingRoom ? `
    <div class="flex gap-2 mt-2">
      <input id="new-room-name" type="text" placeholder="e.g. Master bedroom..."
        class="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400 bg-white"
        style="font-size:16px" onkeydown="if(event.key==='Enter')submitAddRoom();if(event.key==='Escape')hideAddRoomForm()">
      <button onclick="submitAddRoom()" class="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-blue-700 transition whitespace-nowrap">Add</button>
      <button onclick="hideAddRoomForm()" class="text-xs text-slate-500 px-2 hover:text-slate-700">✕</button>
    </div>
  ` : '';

  const startVal  = state.workflowData?.installStart  || '';
  const finishVal = state.workflowData?.installFinish || '';

  el.innerHTML = `
    <div class="flex items-center gap-1.5 flex-wrap">
      ${tabs}
      <button onclick="showAddRoomForm()" class="room-tab-add">+ Room</button>
    </div>
    ${addForm}
    <div class="install-dates-row">
      <div class="install-date-field">
        <label class="install-date-label">Installation start</label>
        <input type="date" class="install-date-input" value="${escHtml(startVal)}"
          onchange="saveInstallDate('installStart', this.value)">
      </div>
      <div class="install-date-field">
        <label class="install-date-label">Installation finish</label>
        <input type="date" class="install-date-input" value="${escHtml(finishVal)}"
          onchange="saveInstallDate('installFinish', this.value)">
      </div>
    </div>
  `;
}

function saveInstallDate(field, value) {
  if (!state.workflowData) return;
  const snapshot = JSON.parse(JSON.stringify(state.allRooms));
  state.workflowData[field] = value || null;
  const label = field === 'installStart' ? 'Installation start' : 'Installation finish';
  scheduleSave(`${label} updated`, snapshot);
}

// ── Workflow Header ───────────────────────────────────────────────────────────
function renderWorkflowHeader() {
  const el = document.getElementById('workflow-header');
  if (!el) return;

  const contact    = state.selectedContact;
  const name       = contactName(contact);
  const email      = contact?.properties?.email || '';
  const phone      = contact?.properties?.phone || '';
  const city       = contact?.properties?.city  || '';
  const stageKey   = state.workflowData?.stageKey || 'sales';
  const colour     = stageColour(stageKey);
  const stageLabel = state.workflow?.stages?.[stageKey]?.label || stageKey;

  const stageOptions = Object.entries(state.workflow?.stages || {}).map(([key, s]) =>
    `<option value="${key}" ${key === stageKey ? 'selected' : ''}>${escHtml(s.label)}</option>`
  ).join('');

  el.innerHTML = `
    <div class="flex items-start justify-between gap-4 flex-wrap">
      <div class="flex-1 min-w-0">
        <h1 class="text-xl font-bold text-slate-900 truncate">${escHtml(name)}</h1>
        <div class="flex flex-wrap items-center gap-2 mt-1.5">
          <span class="text-xs font-semibold px-2.5 py-1 rounded-full"
                style="background:${colour.light};color:${colour.text}">${escHtml(stageLabel)}</span>
          ${email ? `<a href="mailto:${escHtml(email)}" class="text-sm text-blue-600 hover:underline">${escHtml(email)}</a>` : ''}
          ${phone ? `<span class="text-sm text-slate-500">${escHtml(phone)}</span>` : ''}
          ${city  ? `<span class="text-sm text-slate-400">${escHtml(city)}</span>`  : ''}
        </div>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        ${(() => {
          const rs = state.workflowData?.roomStatus || 'active';
          const statusColors = { active: 'color:var(--ink-1)', declined: 'color:#dc2626', complete: 'color:#16a34a', remedial: 'color:#d97706' };
          return `<select onchange="setRoomStatus(this.value)"
            class="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-slate-50 focus:outline-none focus:border-blue-400"
            style="font-size:13px;${statusColors[rs] || ''}">
            <option value="active"   ${rs === 'active'   ? 'selected' : ''}>● Active</option>
            <option value="declined" ${rs === 'declined' ? 'selected' : ''}>✕ Declined</option>
            <option value="complete" ${rs === 'complete' ? 'selected' : ''}>✓ Complete</option>
            <option value="remedial" ${rs === 'remedial' ? 'selected' : ''}>⚠ Remedial</option>
          </select>`;
        })()}
      </div>
    </div>
  `;
}

// ── Workflow Stages ───────────────────────────────────────────────────────────
function renderWorkflowStages() {
  const el = document.getElementById('workflow-stages');
  if (!el || !state.workflow) return;

  const currentStageKey = state.workflowData?.stageKey || 'sales';
  const currentStatusId = state.workflowData?.statusId;
  const currentStageIdx = STAGE_KEYS.indexOf(currentStageKey);

  const completedStatuses = state.workflowData?.completedStatuses || {};

  el.innerHTML = Object.entries(state.workflow.stages).map(([key, stage], i) => {
    const colour     = STAGE_COLOURS[i] || STAGE_COLOURS[0];
    const isCurrent  = key === currentStageKey;
    const isPast     = i < currentStageIdx;
    const isFuture   = i > currentStageIdx;
    const isExpanded = (isCurrent || state.expandedStages.has(key)) && !isFuture;

    const doneIds    = completedStatuses[key] || [];
    const totalTasks = stage.statuses?.length || 0;
    const doneTasks  = stage.statuses?.filter(s => doneIds.includes(s.id)).length || 0;

    const icon = isPast
      ? `<svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="color:#059669">
           <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>
         </svg>`
      : isCurrent
        ? `<span class="w-3 h-3 rounded-full flex-shrink-0" style="background:${colour.bg}"></span>`
        : `<span class="w-3 h-3 rounded-full border-2 flex-shrink-0" style="border-color:var(--stone-deep)"></span>`;

    const tasksHtml = isExpanded ? `
      <div class="stage-statuses">
        ${(stage.statuses || []).map(status => {
          const done = doneIds.includes(status.id);
          return `
            <div class="status-task-row ${done ? 'status-task-done' : ''}"
                 onclick="setStatusChecked('${key}','${status.id}',${!done})">
              <div class="status-task-check ${done ? 'status-task-check-done' : ''}"
                   style="${done ? `background:${colour.bg};border-color:${colour.bg}` : ''}">
                ${done ? `<svg width="10" height="8" fill="none" stroke="#fff" viewBox="0 0 12 10">
                  <polyline points="1,5 4.5,8.5 11,1" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>` : ''}
              </div>
              <div class="status-text">
                <span class="status-label ${done ? 'status-label-done' : ''}">${escHtml(status.label)}</span>
                ${status.hint ? `<span class="status-hint">${escHtml(status.hint)}</span>` : ''}
              </div>
            </div>
          `;
        }).join('')}
        ${isPast ? `
          <div style="padding:4px 0 4px;">
            <button class="btn-move-back" onclick="moveBackToStage('${key}')">← Set as current stage</button>
          </div>
        ` : ''}
      </div>
    ` : '';

    let cardClass = 'stage-card';
    if (isCurrent) cardClass += ' stage-current';
    else if (isPast) cardClass += ' stage-past';
    else cardClass += ' stage-future';

    return `
      <div class="${cardClass}">
        <div class="stage-header-row ${isFuture ? '' : ''}" onclick="${isFuture ? '' : `toggleStage('${key}')`}"
             style="${isCurrent ? `border-left:3px solid ${colour.bg}` : 'border-left:3px solid transparent'}${isFuture ? ';cursor:default' : ''}">
          <div class="flex items-center gap-3 min-w-0 flex-1">
            ${icon}
            <div class="min-w-0">
              <div class="stage-label ${isCurrent ? 'font-semibold' : ''}"
                   style="${isCurrent ? `color:${colour.text}` : ''}">${escHtml(stage.label)}</div>
              ${isCurrent && totalTasks > 0 ? `<div class="stage-sublabel">${doneTasks} of ${totalTasks} tasks done</div>` : ''}
              ${(isCurrent || isPast) && state.workflowData?.stageDates?.[key] ? `<div class="stage-date-entered">Entered ${formatShortDate(state.workflowData.stageDates[key])}</div>` : ''}
            </div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            ${isCurrent ? `<span class="badge-current" style="background:${colour.light};color:${colour.text}">Current</span>` : ''}
            ${isPast    ? `<span class="badge-done">Done</span>` : ''}
            ${!isFuture ? `<svg class="w-4 h-4 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}"
                 style="color:var(--stone-deep)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
            </svg>` : ''}
          </div>
        </div>
        ${tasksHtml}
      </div>
    `;
  }).join('');
}

function toggleStage(key) {
  if (state.expandedStages.has(key)) state.expandedStages.delete(key);
  else state.expandedStages.add(key);
  renderWorkflowStages();
}

// ── Tick off sub-tasks (auto-advances stage when all done) ────────────────────
function setStatusChecked(stageKey, statusId, checked) {
  if (!state.workflowData) return;

  // Snapshot before any change
  const snapshot = JSON.parse(JSON.stringify(state.allRooms));

  const cs   = { ...(state.workflowData.completedStatuses || {}) };
  const done = [...(cs[stageKey] || [])];

  if (checked && !done.includes(statusId)) done.push(statusId);
  else if (!checked) { const i = done.indexOf(statusId); if (i > -1) done.splice(i, 1); }
  cs[stageKey] = done;
  state.workflowData.completedStatuses = cs;

  const taskLabel = state.workflow?.stages?.[stageKey]?.statuses?.find(s => s.id === statusId)?.label || statusId;
  let message = checked ? `Checked: ${taskLabel}` : `Unchecked: ${taskLabel}`;

  // If unchecking a task in a past stage, revert to that stage
  if (!checked) {
    const stageIdx   = STAGE_KEYS.indexOf(stageKey);
    const currentIdx = STAGE_KEYS.indexOf(state.workflowData.stageKey);
    if (stageIdx < currentIdx) {
      state.workflowData.stageKey = stageKey;
      state.expandedStages = new Set([stageKey]);
      updateRoomCache();
      renderCustomerList();
      if (state.activeTab === 'projects') renderProjectsView();
      message = `Moved back to ${state.workflow?.stages?.[stageKey]?.label || stageKey}`;
    }
  }

  // Auto-advance if all tasks in the current stage are ticked
  if (checked && state.workflowData.stageKey === stageKey) {
    const stage = state.workflow?.stages?.[stageKey];
    const allDone = stage?.statuses?.length > 0 && stage.statuses.every(s => done.includes(s.id));
    if (allDone) {
      const nextKey = STAGE_KEYS[STAGE_KEYS.indexOf(stageKey) + 1];
      if (nextKey) {
        state.workflowData.stageKey = nextKey;
        recordStageDate(state.workflowData, nextKey);
        state.expandedStages = new Set();
        updateRoomCache();
        renderCustomerList();
        if (state.activeTab === 'projects') renderProjectsView();
        message = `Advanced to ${state.workflow.stages[nextKey].label}`;
      }
    }
  }

  renderWorkflowStages();
  renderWorkflowHeader();
  scheduleSave(message, snapshot);
}

// ── Move back to a past stage ─────────────────────────────────────────────────
function moveBackToStage(stageKey) {
  if (!state.workflowData) return;
  const snapshot = JSON.parse(JSON.stringify(state.allRooms));
  state.workflowData.stageKey = stageKey;
  state.expandedStages = new Set([stageKey]);
  updateRoomCache();
  renderCustomerList();
  if (state.activeTab === 'projects') renderProjectsView();
  renderWorkflowStages();
  renderWorkflowHeader();
  const label = state.workflow?.stages?.[stageKey]?.label || stageKey;
  scheduleSave(`Moved back to ${label}`, snapshot);
}

// ── Save Workflow Data ────────────────────────────────────────────────────────
async function saveWorkflowData() {
  // Compute primary room's current stage + most recently completed substage
  const primary = state.allRooms[0];
  const stageKey = primary?.stageKey || 'sales';
  const stageLabel = state.workflow?.stages?.[stageKey]?.label || stageKey;
  const doneIds = primary?.completedStatuses?.[stageKey] || [];
  const stageStatuses = state.workflow?.stages?.[stageKey]?.statuses || [];
  const lastDone = [...stageStatuses].reverse().find(s => doneIds.includes(s.id));
  const substageLabel = lastDone?.label || '';

  await POST(`/api/contacts/${state.selectedContactId}/localdata`, {
    rooms: state.allRooms,
    notes: state.customerNotes,
    stage: stageLabel,
    substage: substageLabel,
  });
}

// ── Notes / Comments ──────────────────────────────────────────────────────────
function renderComments() {
  const el = document.getElementById('comments-section');
  if (!el) return;
  const comments = state.workflowData?.comments || [];
  el.innerHTML = `
    <div class="notes-header">
      <span class="notes-header-label">Notes</span>
      <button class="btn-new-note" onclick="showAddComment()">+ New note</button>
    </div>
    <div id="comment-input-area" class="comment-input-area hidden">
      <textarea id="comment-input" rows="3" class="notes-textarea"
        placeholder="Add a note..."
        onkeydown="if(event.ctrlKey&&event.key==='Enter')addComment()"
        style="font-size:16px;min-height:80px"></textarea>
      <div class="comment-input-actions">
        <button class="btn-save-note" onclick="addComment()">Save</button>
        <button class="btn-cancel-note" onclick="hideAddComment()">Cancel</button>
      </div>
    </div>
    <div id="comment-list" class="space-y-2 mt-2">
      ${comments.length
        ? comments.slice().reverse().map(c => `
            <div class="comment-item">
              <div class="comment-date">${escHtml(formatDate(c.date))}</div>
              <div class="comment-text">${escHtml(c.text)}</div>
            </div>
          `).join('')
        : `<p class="text-sm italic" style="color:var(--stone-deep)">No notes yet.</p>`
      }
    </div>
  `;
}

function showAddComment() {
  const area = document.getElementById('comment-input-area');
  if (!area) return;
  area.classList.remove('hidden');
  document.getElementById('comment-input')?.focus();
}

function hideAddComment() {
  const area = document.getElementById('comment-input-area');
  if (area) area.classList.add('hidden');
}

async function addComment() {
  const input = document.getElementById('comment-input');
  const text  = input?.value.trim();
  if (!text) return;
  if (!state.workflowData.comments) state.workflowData.comments = [];
  const comment = { text, date: new Date().toISOString() };
  state.workflowData.comments.push(comment);
  input.value = '';
  hideAddComment();
  renderComments();
  try {
    await saveWorkflowData();
  } catch {
    state.workflowData.comments.pop();
    renderComments();
    showToast('Failed to save note', true);
  }
}

// ── Tasks ─────────────────────────────────────────────────────────────────────
function renderTasks() {
  const el = document.getElementById('tasks-section');
  if (!el) return;

  const stageOptions = Object.entries(state.workflow?.stages || {}).map(([key, s]) =>
    `<option value="${key}">${escHtml(s.label)}</option>`
  ).join('');

  const sorted = [...state.tasks].sort((a, b) => {
    const aDone = a.properties?.hs_task_status === 'COMPLETED';
    const bDone = b.properties?.hs_task_status === 'COMPLETED';
    if (aDone !== bDone) return aDone ? 1 : -1;
    return (parseInt(a.properties?.hs_timestamp || '0')) - (parseInt(b.properties?.hs_timestamp || '0'));
  });

  const taskItems = sorted.map(task => {
    const p = task.properties || {};
    const subject  = p.hs_task_subject || 'Untitled';
    const body     = p.hs_task_body || '';
    const stageKey = body.startsWith('TASK_STAGE:') ? body.slice('TASK_STAGE:'.length).trim() : null;
    const stageLabel = stageKey ? (state.workflow?.stages?.[stageKey]?.label || stageKey) : null;
    const colour   = stageKey ? stageColour(stageKey) : null;
    const isDone   = p.hs_task_status === 'COMPLETED';
    const dueTsMs  = p.hs_timestamp ? parseInt(p.hs_timestamp) : null;
    const overdue  = dueTsMs && dueTsMs < Date.now() && !isDone;
    const dueLabel = dueTsMs
      ? new Date(dueTsMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : null;

    return `
      <div class="task-item ${isDone ? 'task-done' : ''}">
        <button class="task-check ${isDone ? 'task-check-done' : ''}"
                onclick="toggleTaskDone('${task.id}', ${isDone})" title="${isDone ? 'Mark incomplete' : 'Mark complete'}">
          ${isDone ? `<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
          </svg>` : ''}
        </button>
        <div class="task-content">
          <div class="task-subject ${isDone ? 'task-subject-done' : ''}">${escHtml(subject)}</div>
          <div class="task-meta">
            ${stageLabel && colour ? `<span class="task-stage-pill" style="background:${colour.light};color:${colour.text}">${escHtml(stageLabel)}</span>` : ''}
            ${dueLabel ? `<span class="task-due ${overdue ? 'task-due-overdue' : ''}">${overdue ? '⚠ ' : ''}${dueLabel}</span>` : ''}
          </div>
        </div>
        <button class="task-delete" onclick="deleteTask('${task.id}')" title="Delete task">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
    `;
  }).join('');

  el.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-semibold text-slate-700">Tasks</h3>
      <button onclick="toggleAddTask()" id="add-task-btn"
        class="text-xs font-semibold text-blue-600 hover:text-blue-700 px-2.5 py-1 rounded-lg hover:bg-blue-50 transition">
        ${state.showAddTask ? 'Cancel' : '+ Add task'}
      </button>
    </div>
    ${state.showAddTask ? `
      <div class="add-task-form">
        <input id="task-subject" type="text" placeholder="Task description..."
          class="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm mb-2 focus:outline-none focus:border-blue-400 bg-white"
          style="font-size:16px" onkeydown="if(event.key==='Enter')saveNewTask()">
        <div class="flex gap-2 mb-2">
          <input id="task-due" type="date"
            class="flex-1 min-w-0 border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400 bg-white"
            style="font-size:16px">
          <select id="task-stage"
            class="flex-1 min-w-0 border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400 bg-white"
            style="font-size:16px">
            <option value="">No stage</option>
            ${stageOptions}
          </select>
        </div>
        <button onclick="saveNewTask()"
          class="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-medium py-2.5 rounded-xl transition"
          style="min-height:44px">Save task</button>
      </div>
    ` : ''}
    ${sorted.length
      ? `<div class="space-y-1.5">${taskItems}</div>`
      : `<p class="text-sm text-slate-400 italic">No tasks yet.</p>`}
  `;

  if (state.showAddTask) setTimeout(() => document.getElementById('task-subject')?.focus(), 30);
}

function toggleAddTask() {
  state.showAddTask = !state.showAddTask;
  renderTasks();
}

async function saveNewTask() {
  const subject  = document.getElementById('task-subject')?.value.trim();
  if (!subject) { document.getElementById('task-subject')?.focus(); return; }
  const dueDate  = document.getElementById('task-due')?.value  || null;
  const stageKey = document.getElementById('task-stage')?.value || null;

  const btn = document.querySelector('#tasks-section button[onclick="saveNewTask()"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    const task = await POST(`/api/contacts/${state.selectedContactId}/tasks`, { subject, dueDate, stageKey });
    state.tasks.push(task);
    state.showAddTask = false;
    // Recompute urgency with new task included
    state.contactUrgencyCache[state.selectedContactId] = getTaskUrgency(state.tasks);
    renderCustomerList();
    renderTasks();
  } catch {
    showToast('Failed to create task', true);
    if (btn) { btn.disabled = false; btn.textContent = 'Save task'; }
  }
}

async function toggleTaskDone(taskId, currentlyDone) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  const newStatus  = currentlyDone ? 'NOT_STARTED' : 'COMPLETED';
  const prevStatus = task.properties.hs_task_status;
  task.properties.hs_task_status = newStatus;
  state.contactUrgencyCache[state.selectedContactId] = getTaskUrgency(state.tasks);
  renderCustomerList();
  renderTasks();
  try {
    await PATCH_REQ(`/api/tasks/${taskId}`, { hs_task_status: newStatus });
  } catch {
    task.properties.hs_task_status = prevStatus;
    state.contactUrgencyCache[state.selectedContactId] = getTaskUrgency(state.tasks);
    renderCustomerList();
    renderTasks();
    showToast('Failed to update task', true);
  }
}

async function deleteTask(taskId) {
  const idx = state.tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  const removed = state.tasks.splice(idx, 1)[0];
  state.contactUrgencyCache[state.selectedContactId] = getTaskUrgency(state.tasks);
  renderCustomerList();
  renderTasks();
  try {
    await DELETE_REQ(`/api/tasks/${taskId}`);
  } catch {
    state.tasks.splice(idx, 0, removed);
    state.contactUrgencyCache[state.selectedContactId] = getTaskUrgency(state.tasks);
    renderCustomerList();
    renderTasks();
    showToast('Failed to delete task', true);
  }
}

// ── QuickBooks ────────────────────────────────────────────────────────────────
async function loadQBInvoices() {
  try {
    const status = await fetch('/api/quickbooks/status').then(r => r.json()).catch(() => ({ connected: false }));
    state.qb.connected = status.connected;
    state.qb.company   = status.company || null;
    if (!status.connected) return;

    state.qb.loading = true;
    const data = await fetch('/api/quickbooks/invoices').then(r => r.json()).catch(() => ({ invoices: [] }));
    state.qb.invoices = data.invoices || [];
    state.qb.loaded   = true;
    state.qb.loading  = false;
    renderCustomerList();
    const invEl = document.getElementById('invoices-view');
    if (invEl && state.activeTab === 'invoices') renderInvoicesTab();
    const wfInvEl = document.getElementById('invoices-section');
    if (wfInvEl) renderWorkflowInvoices();
  } catch {
    state.qb.loading = false;
  }
}

function matchInvoicesForContact(contact) {
  if (!state.qb.loaded || !state.qb.invoices.length) return [];
  const email = (contact.properties?.email || '').toLowerCase().trim();
  const name  = contactName(contact).toLowerCase().trim();
  return state.qb.invoices.filter(inv => {
    const custName  = (inv.customerName || '').toLowerCase().trim();
    const custEmail = (inv.email        || '').toLowerCase().trim();
    if (email && custEmail && email === custEmail) return true;
    if (name  && custName  && custName === name)   return true;
    return false;
  });
}

function fmtGBP(amount) {
  return '£' + Number(amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtQBDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function renderWorkflowInvoices() {
  const el = document.getElementById('invoices-section');
  if (!el) return;

  if (!state.qb.connected) { el.innerHTML = ''; return; }

  const contact = state.selectedContact;
  if (!contact) { el.innerHTML = ''; return; }

  if (!state.qb.loaded) {
    el.innerHTML = `<div class="qb-section"><div class="qb-section-title">Invoices</div><p class="text-sm text-slate-400">Loading…</p></div>`;
    return;
  }

  const invoices = matchInvoicesForContact(contact);
  if (!invoices.length) {
    el.innerHTML = `<div class="qb-section"><div class="qb-section-title">Invoices <span class="qb-section-company">${escHtml(state.qb.company || 'QuickBooks')}</span></div><p class="text-sm text-slate-400">No outstanding invoices</p></div>`;
    return;
  }

  const total = invoices.reduce((s, inv) => s + inv.balance, 0);
  const rows  = invoices.sort((a, b) => b.balance - a.balance).map(inv => {
    const overdue = inv.dueDate && new Date(inv.dueDate) < new Date();
    return `
      <div class="qb-invoice-row">
        <div class="qb-invoice-meta">
          <span class="qb-invoice-num">Invoice #${escHtml(inv.docNumber || inv.id)}</span>
          ${inv.dueDate ? `<span class="qb-invoice-date ${overdue ? 'qb-overdue' : ''}">${overdue ? 'Overdue ' : 'Due '}${fmtQBDate(inv.dueDate)}</span>` : ''}
        </div>
        <span class="qb-invoice-amount ${overdue ? 'qb-overdue' : ''}">${fmtGBP(inv.balance)}</span>
      </div>
    `;
  }).join('');

  el.innerHTML = `
    <div class="qb-section">
      <div class="qb-section-title">
        Invoices <span class="qb-section-company">${escHtml(state.qb.company || 'QuickBooks')}</span>
        <span class="qb-section-total">${fmtGBP(total)} outstanding</span>
      </div>
      ${rows}
    </div>
  `;
}

function renderInvoicesTab() {
  const el = document.getElementById('invoices-view');
  if (!el) return;

  if (!state.qb.connected) {
    el.innerHTML = `
      <div class="qb-tab-empty">
        <div class="qb-tab-empty-icon">
          <svg width="40" height="40" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="opacity:0.35">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
              d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z"/>
          </svg>
        </div>
        <p class="qb-tab-empty-title">Connect QuickBooks</p>
        <p class="qb-tab-empty-sub">See outstanding invoices matched to your customers.</p>
        <a href="/auth/quickbooks" class="qb-connect-btn">Connect QuickBooks</a>
      </div>
    `;
    return;
  }

  if (state.qb.loading || !state.qb.loaded) {
    el.innerHTML = `<div class="qb-tab-loading"><div class="spinner"></div> Loading invoices…</div>`;
    return;
  }

  const allInvoices = [...state.qb.invoices].sort((a, b) => b.balance - a.balance);

  // Tag each invoice with its matched HubSpot contact (if any)
  const tagged = allInvoices.map(inv => {
    const matched = state.contacts.find(c => {
      const email = (c.properties?.email || '').toLowerCase();
      const name  = contactName(c).toLowerCase();
      if (email && inv.email && email === inv.email.toLowerCase()) return true;
      if (name  && inv.customerName && name === inv.customerName.toLowerCase()) return true;
      return false;
    });
    return { inv, matched };
  });

  const matchedOnly = state.qb.showMatchedOnly;
  const visible     = matchedOnly ? tagged.filter(t => t.matched) : tagged;
  const total       = visible.reduce((s, t) => s + t.inv.balance, 0);
  const matchCount  = tagged.filter(t => t.matched).length;

  const filterBar = `
    <div class="qb-filter-bar">
      <button class="qb-filter-btn ${!matchedOnly ? 'qb-filter-active' : ''}"
        onclick="state.qb.showMatchedOnly=false;renderInvoicesTab()">
        All (${allInvoices.length})
      </button>
      <button class="qb-filter-btn ${matchedOnly ? 'qb-filter-active' : ''}"
        onclick="state.qb.showMatchedOnly=true;renderInvoicesTab()">
        Matched to customers (${matchCount})
      </button>
    </div>
  `;

  if (!visible.length) {
    el.innerHTML = `
      <div class="qb-tab-header">
        <div>
          <h2 class="qb-tab-title">Outstanding Invoices</h2>
          <p class="qb-tab-sub">${escHtml(state.qb.company || 'QuickBooks')}</p>
        </div>
        <div class="flex items-center gap-2">
          <button onclick="loadQBInvoices()" class="qb-refresh-btn">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
            </svg>
            Refresh
          </button>
          <button onclick="disconnectQB()" class="qb-disconnect-btn">Disconnect</button>
        </div>
      </div>
      ${filterBar}
      <div class="qb-tab-empty" style="margin-top:32px">
        <p class="qb-tab-empty-title">${matchedOnly ? 'No matched invoices' : 'All clear!'}</p>
        <p class="qb-tab-empty-sub">${matchedOnly ? 'No outstanding invoices matched to your HubSpot customers.' : 'No outstanding invoices found.'}</p>
      </div>
    `;
    return;
  }

  const rows = visible.map(({ inv, matched }) => {
    const overdue = inv.dueDate && new Date(inv.dueDate) < new Date();
    return `
      <div class="qb-row">
        <div class="qb-row-customer">
          <span class="qb-row-name">${escHtml(inv.customerName || '—')}</span>
          ${matched
            ? `<span class="qb-row-linked" title="Matched to HubSpot contact">
                <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
                Linked
              </span>`
            : ''}
        </div>
        <div class="qb-row-meta">
          <span class="qb-row-num">Inv #${escHtml(inv.docNumber || inv.id)}</span>
          ${inv.dueDate ? `<span class="qb-row-date ${overdue ? 'qb-overdue' : ''}">Due ${fmtQBDate(inv.dueDate)}</span>` : ''}
        </div>
        <span class="qb-row-amount ${overdue ? 'qb-overdue' : ''}">${fmtGBP(inv.balance)}</span>
      </div>
    `;
  }).join('');

  el.innerHTML = `
    <div class="qb-tab-header">
      <div>
        <h2 class="qb-tab-title">Outstanding Invoices</h2>
        <p class="qb-tab-sub">${escHtml(state.qb.company || 'QuickBooks')} · ${visible.length} invoice${visible.length !== 1 ? 's' : ''} · ${fmtGBP(total)} total</p>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="loadQBInvoices()" class="qb-refresh-btn" title="Refresh invoices">
          <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
          Refresh
        </button>
        <button onclick="disconnectQB()" class="qb-disconnect-btn">Disconnect</button>
      </div>
    </div>
    ${filterBar}
    <div class="qb-list">${rows}</div>
  `;
}

async function disconnectQB() {
  await fetch('/auth/quickbooks/disconnect').catch(() => {});
  state.qb = { connected: false, company: null, invoices: [], loaded: false, loading: false };
  renderCustomerList();
  renderInvoicesTab();
}

// ── Start ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
