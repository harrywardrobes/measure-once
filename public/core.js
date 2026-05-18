// ── Cross-module stubs ────────────────────────────────────────────────────────
// These are no-ops here so core code can call them safely on any page.
// Page modules (sales.js, projects.js, invoices.js) redeclare them with real
// implementations; the later function declaration wins in global scope.
function renderProjectsView() {}
function renderInvoicesTab() {}
function renderWorkflowInvoices() {}
function renderWorkflowHeader() {}
function renderWorkflowStages() {}
function renderRoomTabs() {}
function renderFullWorkflowView() {}
function selectContact() {}
function renderCustomerList() {}
async function saveWorkflowData() {}

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
    panel: null,        // full invoice detail currently open
    panelSaving: false,
    panelSending: false,
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
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.textContent = msg;
  document.body.appendChild(el);
  const live = document.getElementById('toast-live');
  if (live) { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 50); }
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

// ── Bootstrap (called by each page) ───────────────────────────────────────────
// Map URL paths to the bottom-nav button id that should be marked active.
const NAV_PATH_MAP = {
  '/': 'home',
  '/sales': 'sales',
  '/projects': 'projects',
  '/calendar': 'calendar',
  '/invoices': 'invoices',
};

function highlightActiveNav() {
  const key = NAV_PATH_MAP[location.pathname];
  if (!key) return;
  document.getElementById(`bnav-${key}`)?.classList.add('bottom-nav-active');
}

// Common per-page bootstrap. Returns true if user is signed in & data loaded.
async function bootstrap() {
  highlightActiveNav();
  const params = new URLSearchParams(window.location.search);

  const user = await fetch('/api/auth/user')
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);

  if (!user) {
    showAccessGate(params);
    return false;
  }

  state.user = user;

  try {
    await checkAuthStatus();
    await loadWorkflow();
    await Promise.all([loadOpenLeads(), loadWorkflowStages()]);
    populateStageFilter();
    if (document.getElementById('customer-list')) renderCustomerList();
    loadQBInvoices();
  } catch (e) {
    const list = document.getElementById('customer-list');
    if (list) list.innerHTML =
      `<div class="p-4 text-sm text-red-500">Failed to load: ${escHtml(e.message)}</div>`;
    else console.error('Bootstrap failed', e);
  }
  return true;
}

function showAccessGate(params) {
  const gate = document.getElementById('access-gate');
  if (gate) gate.style.display = 'flex';

  const isEmailConflict = params.get('email_conflict') === '1';
  const isConfirmed     = params.get('access_requested') === '1'
    || params.get('denied') === '1'
    || params.has('error');

  const signInEl        = document.getElementById('access-sign-in-state');
  const confirmedEl     = document.getElementById('access-confirmed-state');
  const emailConflictEl = document.getElementById('access-email-conflict-state');

  if (signInEl)        signInEl.style.display        = (!isConfirmed && !isEmailConflict) ? '' : 'none';
  if (confirmedEl)     confirmedEl.style.display     = (isConfirmed && !isEmailConflict) ? '' : 'none';
  if (emailConflictEl) emailConflictEl.style.display = isEmailConflict ? '' : 'none';
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
      `<option value="${escHtml(key)}">${escHtml(s.label)}</option>`
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
  renderProjectsView();
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

// ── Header Search ─────────────────────────────────────────────────────────────
function onHeaderSearch(val) {
  // On non-sales pages, redirect to /sales with the search pre-applied.
  if (location.pathname !== '/sales') {
    if (val) location.href = '/sales?q=' + encodeURIComponent(val);
    return;
  }
  const clear = document.getElementById('search-clear');
  if (clear) clear.classList.toggle('hidden', !val);
  filterDeals(val);
}

function clearHeaderSearch() {
  const inp = document.getElementById('search');
  if (inp) { inp.value = ''; inp.focus(); }
  const clear = document.getElementById('search-clear');
  if (clear) clear.classList.add('hidden');
  filterDeals('');
}
function openProject(contactId, roomIdx) {
  // Cross-page navigation: stash request, navigate to /sales, sales page will open it.
  try {
    sessionStorage.setItem('pendingOpenContact', JSON.stringify({ contactId, roomIdx }));
  } catch {}
  location.href = '/sales';
}

// ── Tasks View ────────────────────────────────────────────────────────────────
function contactDisplayName(c) {
  const p = (c && c.properties) || {};
  const n = `${p.firstname || ''} ${p.lastname || ''}`.trim();
  return n || p.email || `Contact ${c?.id || ''}`;
}
// ── Auth Status ───────────────────────────────────────────────────────────────
function renderAuthStatus() {
  const el = document.getElementById('auth-status');
  if (!el) return;
  const user = state.user;
  if (!user) { el.innerHTML = ''; return; }
  const initials = [user.first_name, user.last_name]
    .filter(Boolean).map(s => s[0]).join('').toUpperCase() || '?';
  el.innerHTML = user.profile_image_url
    ? `<a href="/profile" class="header-avatar-btn" title="Profile" aria-label="Open profile">
         <img src="${escHtml(user.profile_image_url)}" alt="" class="header-avatar-img">
       </a>`
    : `<a href="/profile" class="header-avatar-btn header-avatar-initials" title="Profile" aria-label="Open profile">
         ${escHtml(initials)}
       </a>`;
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
    if (invEl) renderInvoicesTab();
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

// ── Invoice Detail Panel ───────────────────────────────────────────────────────
async function openInvoicePanel(invId) {
  const panel   = document.getElementById('inv-panel');
  const overlay = document.getElementById('inv-overlay');
  const body    = document.getElementById('inv-panel-body');
  const title   = document.getElementById('inv-panel-title');
  const sub     = document.getElementById('inv-panel-sub');

  panel.classList.add('inv-panel-open');
  overlay.classList.remove('hidden');
  body.innerHTML = `<div class="inv-panel-loading"><div class="spinner"></div> Loading…</div>`;
  title.textContent = 'Invoice';
  sub.textContent   = '';

  try {
    const inv = await fetch(`/api/quickbooks/invoice/${invId}`).then(r => r.json());
    if (inv.error) throw new Error(inv.error);
    state.qb.panel = inv;
    renderInvoicePanelBody();
  } catch (e) {
    body.innerHTML = `<div class="inv-panel-error">Failed to load invoice: ${escHtml(e.message)}</div>`;
  }
}

function closeInvoicePanel() {
  document.getElementById('inv-panel').classList.remove('inv-panel-open');
  document.getElementById('inv-overlay').classList.add('hidden');
  state.qb.panel = null;
}

function renderInvoicePanelBody() {
  const inv   = state.qb.panel;
  if (!inv) return;
  const title = document.getElementById('inv-panel-title');
  const sub   = document.getElementById('inv-panel-sub');
  const body  = document.getElementById('inv-panel-body');

  title.textContent = `Invoice #${inv.docNumber || inv.id}`;
  sub.textContent   = inv.customerName;

  const overdue = inv.dueDate && new Date(inv.dueDate) < new Date();

  const lineRows = inv.lines
    .filter(l => l.detailType !== 'SubTotalLineDetail')
    .map(l => `
      <tr>
        <td class="inv-line-desc">${escHtml(l.description || '—')}</td>
        <td class="inv-line-num">${l.qty != null ? l.qty : ''}</td>
        <td class="inv-line-num">${l.unitPrice != null ? fmtGBP(l.unitPrice) : ''}</td>
        <td class="inv-line-num inv-line-amount">${fmtGBP(l.amount)}</td>
      </tr>
    `).join('');

  body.innerHTML = `
    <div class="inv-section">
      <div class="inv-meta-grid">
        <div class="inv-meta-item">
          <span class="inv-meta-label">Invoice date</span>
          <span class="inv-meta-val">${inv.txnDate ? fmtQBDate(inv.txnDate) : '—'}</span>
        </div>
        <div class="inv-meta-item">
          <span class="inv-meta-label">Balance due</span>
          <span class="inv-meta-val inv-balance">${fmtGBP(inv.balance)}</span>
        </div>
      </div>
    </div>

    <div class="inv-section">
      <h3 class="inv-section-title">Line items</h3>
      <table class="inv-lines-table">
        <thead><tr>
          <th class="inv-line-desc">Description</th>
          <th class="inv-line-num">Qty</th>
          <th class="inv-line-num">Unit price</th>
          <th class="inv-line-num">Amount</th>
        </tr></thead>
        <tbody>${lineRows}</tbody>
        <tfoot>
          <tr class="inv-total-row">
            <td colspan="3" class="inv-line-desc" style="font-weight:600">Total</td>
            <td class="inv-line-num inv-line-amount" style="font-weight:700">${fmtGBP(inv.totalAmt)}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div class="inv-section">
      <h3 class="inv-section-title">Edit invoice</h3>
      <div class="inv-edit-grid">
        <label class="inv-edit-label">
          Due date
          <input type="date" id="inv-edit-due" class="inv-edit-input" value="${escHtml(inv.dueDate || '')}">
        </label>
        <label class="inv-edit-label">
          Customer email
          <input type="email" id="inv-edit-email" class="inv-edit-input" value="${escHtml(inv.email || '')}" placeholder="customer@example.com">
        </label>
        <label class="inv-edit-label" style="grid-column:1/-1">
          Message on invoice
          <textarea id="inv-edit-memo" class="inv-edit-input inv-edit-textarea" rows="2" placeholder="Thank you for your business">${escHtml(inv.memo || '')}</textarea>
        </label>
      </div>
      <button id="inv-save-btn" class="inv-btn inv-btn-primary" onclick="saveInvoiceChanges()">Save changes</button>
      <span id="inv-save-msg" class="inv-action-msg"></span>
    </div>

    <div class="inv-section inv-actions-row">
      <div>
        <h3 class="inv-section-title">Actions</h3>
        <div class="inv-actions-btns">
          <a href="/api/quickbooks/invoice/${inv.id}/pdf" target="_blank" download="invoice-${escHtml(inv.docNumber || inv.id)}.pdf"
            class="inv-btn inv-btn-secondary" id="inv-pdf-btn">
            <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h4a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
            </svg>
            Download PDF
          </a>
          <button class="inv-btn inv-btn-secondary" id="inv-send-btn" onclick="sendInvoice()">
            <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
            </svg>
            Send to customer
          </button>
        </div>
        <span id="inv-send-msg" class="inv-action-msg"></span>
      </div>
    </div>
  `;
}

async function saveInvoiceChanges() {
  const inv = state.qb.panel;
  if (!inv || state.qb.panelSaving) return;

  const dueDate = document.getElementById('inv-edit-due')?.value || null;
  const email   = document.getElementById('inv-edit-email')?.value?.trim() || null;
  const memo    = document.getElementById('inv-edit-memo')?.value || null;
  const btn     = document.getElementById('inv-save-btn');
  const msg     = document.getElementById('inv-save-msg');

  state.qb.panelSaving = true;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  msg.textContent = '';
  msg.className = 'inv-action-msg';

  try {
    const r = await fetch(`/api/quickbooks/invoice/${inv.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncToken: inv.syncToken, dueDate, memo, email })
    }).then(res => res.json());

    if (r.error) throw new Error(r.error);

    state.qb.panel.syncToken = r.syncToken;
    state.qb.panel.dueDate   = dueDate;
    state.qb.panel.memo      = memo;
    state.qb.panel.email     = email;

    // Refresh the list so badges/dates update
    const idx = state.qb.invoices.findIndex(i => i.id === inv.id);
    if (idx !== -1) { state.qb.invoices[idx].dueDate = dueDate; state.qb.invoices[idx].email = email || state.qb.invoices[idx].email; }

    msg.textContent = 'Saved';
    msg.className = 'inv-action-msg inv-msg-ok';
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'inv-action-msg inv-msg-err';
  } finally {
    state.qb.panelSaving = false;
    btn.disabled = false;
    btn.textContent = 'Save changes';
  }
}

async function sendInvoice() {
  const inv = state.qb.panel;
  if (!inv || state.qb.panelSending) return;

  const email   = document.getElementById('inv-edit-email')?.value?.trim();
  const btn     = document.getElementById('inv-send-btn');
  const msg     = document.getElementById('inv-send-msg');

  state.qb.panelSending = true;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  msg.textContent = '';
  msg.className = 'inv-action-msg';

  try {
    const r = await fetch(`/api/quickbooks/invoice/${inv.id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    }).then(res => res.json());

    if (r.error) throw new Error(r.error);
    msg.textContent = `Sent to ${email || inv.email}`;
    msg.className = 'inv-action-msg inv-msg-ok';
  } catch (e) {
    msg.textContent = e.message;
    msg.className = 'inv-action-msg inv-msg-err';
  } finally {
    state.qb.panelSending = false;
    btn.disabled = false;
    btn.innerHTML = `<svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg> Send to customer`;
  }
}

