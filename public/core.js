// ── Viewer-mode CSS ───────────────────────────────────────────────────────────
// Injected once; hides elements marked data-viewer-hide when body.viewer-mode
(function () {
  const s = document.createElement('style');
  s.textContent = 'body.viewer-mode [data-viewer-hide]{display:none!important}';
  document.head.appendChild(s);
}());

// ── Cross-module stubs ────────────────────────────────────────────────────────
// No-ops so shared modules can call these safely on pages that don't load the
// module containing the real implementation. The later function declaration
// wins in global scope, so page modules simply redeclare to override.

// workflow-core.js calls these unconditionally (lines ~427-431, ~358, ~386,
// ~433); pages that load workflow-core.js but NOT sales.js (calendar, customers,
// index, invoices, projects) need these no-ops to avoid ReferenceErrors.
// Real implementations live in sales.js.
function renderWorkflowHeader() {}
function renderWorkflowStages() {}
function renderRoomTabs() {}
async function saveWorkflowData() {}

// workflow-core.js (line ~431) and invoices-core.js (line ~17, ~34) call this;
// pages without projects.js or sales.js need the no-op. Real impl in projects.js
// (overridden by sales.js on pages that load both).
function renderProjectsView() {}

// workflow-core.js and invoices-core.js call renderCustomerList() unconditionally
// on pages such as calendar, index, and invoices that load neither workflow.js
// nor sales.js. Real implementations live in workflow.js (overridden by sales.js).
function renderCustomerList() {}

// Workflow-core stubs — kept because bootstrap() and clearHeaderSearch() in
// this file call them unconditionally; pages that don't load workflow-core.js
// (e.g. /profile, /trades) need these no-ops to avoid ReferenceErrors.
// Real implementations in workflow-core.js override these when that file loads.
async function loadWorkflow() {}
async function loadOpenLeads() {}
async function loadWorkflowStages() {}
function populateStageFilter() {}
function filterDeals() {}

// loadQBInvoices() is called unconditionally in bootstrap() below; pages that
// don't load invoices-core.js (calendar, profile, trades) need this no-op.
// Real implementation in invoices-core.js overrides when that file loads.
async function loadQBInvoices() {}
function closeInvoicePanel() {
  document.getElementById('inv-panel')?.classList.remove('inv-panel-open');
  document.getElementById('inv-overlay')?.classList.add('hidden');
}

// ── App State ─────────────────────────────────────────────────────────────────
const state = {
  contacts: [],
  filteredContacts: [],
  contactsViewMode: 'active',
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
  leadStatusFilter: '',
  sortBy: 'newest',
  showArchived: false,
  projectStageFilter: '',
  salesStageFilter: '',
  customerNotes: '',
  personalTasks: [],
  calendarEvents: [],
  calendarConnected: false,
  showAddPersonalTask: false,
  qb: {
    statusKnown: false, // true once the first /api/quickbooks/status fetch resolves
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
    const data = await r.json().catch(() => ({}));
    if (data.code === 'GOOGLE_AUTH' || data.code === 'GOOGLE_ERROR') {
      const err = new Error(data.error || 'Google authentication required');
      err.code = data.code;
      throw err;
    }
    window.location.href = '/api/login';
    throw new Error('Unauthorized');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    if (data.code) err.code = data.code;
    throw err;
  }
  return data;
}
const GET        = path      => api('GET',    path);
const POST       = (path, b) => api('POST',   path, b);
const PATCH_REQ  = (path, b) => api('PATCH',  path, b);
const DELETE_REQ = path      => api('DELETE', path);

function isViewerOnly() {
  return document.body.classList.contains('viewer-mode');
}

function showViewerBanner() {
  if (sessionStorage.getItem('viewerBannerDismissed') === '1') return;
  const banner = document.getElementById('viewer-banner');
  if (banner) banner.style.display = '';
  document.body.classList.add('has-viewer-banner');
}

function dismissViewerBanner() {
  const banner = document.getElementById('viewer-banner');
  if (banner) banner.style.display = 'none';
  document.body.classList.remove('has-viewer-banner');
  sessionStorage.setItem('viewerBannerDismissed', '1');
}

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

function contactName(contact) {
  const p = contact?.properties || {};
  const name = [p.firstname, p.lastname].filter(Boolean).join(' ');
  return name || p.email || 'Unnamed';
}

function contactDisplayName(c) {
  const p = (c && c.properties) || {};
  const n = `${p.firstname || ''} ${p.lastname || ''}`.trim();
  return n || p.email || `Contact ${c?.id || ''}`;
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
// Workflow and QuickBooks data are loaded only when those modules are present
// (real implementations live in workflow-core.js / invoices-core.js).
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

  const priv = user.privilege_level || 'member';

  if (priv === 'viewer') {
    document.body.classList.add('viewer-mode');
    showViewerBanner();
  }

  if (priv === 'manager' || priv === 'admin') {
    const tradesBtn = document.getElementById('bnav-trades');
    if (tradesBtn) tradesBtn.style.display = '';
  }

  try {
    await checkAuthStatus();
    await loadWorkflow();
    await Promise.all([loadOpenLeads(), loadWorkflowStages()]);
    populateStageFilter();
    if (document.getElementById('customer-list') || document.getElementById('sales-view')) renderCustomerList();
    loadQBInvoices();
  } catch (e) {
    console.error('Bootstrap failed', e);
    const list        = document.getElementById('customer-list');
    const salesView   = document.getElementById('sales-view');
    const projectView = document.getElementById('projects-view');
    const target = list || salesView || projectView;
    if (target) {
      let msg, action;
      if (e.code === 'HUBSPOT_AUTH') {
        msg = 'Could not connect to HubSpot — the API token is invalid or expired. An admin needs to update the <strong>HUBSPOT_ACCESS_TOKEN</strong> in the environment settings and restart the app.';
        action = `<a href="/settings" class="mt-2 inline-block text-blue-600 underline text-xs">Go to Settings</a>`;
      } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
        msg = 'HubSpot rate limit reached.';
        action = `<button onclick="location.reload()" class="mt-2 text-blue-600 underline text-xs">Try again</button>`;
      } else if (e.code === 'HUBSPOT_ERROR' || e.code) {
        msg = 'Could not load data from HubSpot. This may be a temporary issue.';
        action = `<button onclick="location.reload()" class="mt-2 text-blue-600 underline text-xs">Retry</button>`;
      } else {
        msg = `Failed to load: ${escHtml(e.message)}`;
        action = `<button onclick="location.reload()" class="mt-2 text-blue-600 underline text-xs">Retry</button>`;
      }
      target.innerHTML = `<div class="p-4 text-sm text-red-500">${msg}${action ? `<br>${action}` : ''}</div>`;
    }
  }
  return true;
}

function showAccessGate(params) {
  const gate = document.getElementById('access-gate');
  if (gate) gate.style.display = 'flex';

  const isEmailConflict  = params.get('email_conflict')  === '1';
  const isPending        = params.get('access_pending')   === '1';
  const isAlreadyApproved = params.get('access_approved') === '1';
  const isConfirmed      = params.get('access_requested') === '1'
    || params.get('denied') === '1'
    || params.has('error');

  const signInEl            = document.getElementById('access-sign-in-state');
  const confirmedEl         = document.getElementById('access-confirmed-state');
  const emailConflictEl     = document.getElementById('access-email-conflict-state');
  const pendingEl           = document.getElementById('access-pending-state');
  const alreadyApprovedEl   = document.getElementById('access-already-approved-state');

  const anySpecial = isConfirmed || isEmailConflict || isPending || isAlreadyApproved;
  if (signInEl)          signInEl.style.display          = !anySpecial ? '' : 'none';
  if (confirmedEl)       confirmedEl.style.display       = (isConfirmed && !isEmailConflict && !isPending && !isAlreadyApproved) ? '' : 'none';
  if (emailConflictEl)   emailConflictEl.style.display   = isEmailConflict ? '' : 'none';
  if (pendingEl)         pendingEl.style.display         = isPending ? '' : 'none';
  if (alreadyApprovedEl) alreadyApprovedEl.style.display = isAlreadyApproved ? '' : 'none';
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

// ── Header Search ─────────────────────────────────────────────────────────────
function onHeaderSearch(val) {
  const clear = document.getElementById('search-clear');
  if (clear) clear.classList.toggle('hidden', !val);
  if (location.pathname === '/customers') {
    filterDeals(val);
  }
}

function onHeaderSearchSubmit(val) {
  if (!val) return;
  if (location.pathname === '/customers') {
    filterDeals(val);
    setTimeout(() => {
      const firstCard = document.querySelector('.customer-card');
      if (firstCard) firstCard.click();
    }, 50);
  } else {
    location.href = '/customers?q=' + encodeURIComponent(val);
  }
}

function onHeaderPlusBtn() {
  if (location.pathname === '/customers') {
    if (typeof openNewCustomerModal === 'function') openNewCustomerModal();
  } else {
    location.href = '/customers?new=1';
  }
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

// ── Auth Status ───────────────────────────────────────────────────────────────
function renderAuthStatus() {
  const el = document.getElementById('auth-status');
  if (!el) return;
  const user = state.user;
  if (!user) { el.innerHTML = ''; return; }
  const initials = [user.first_name, user.last_name]
    .filter(Boolean).map(s => s[0]).join('').toUpperCase() || '?';
  const photoSrc = user.has_custom_photo
    ? `/api/users/${encodeURIComponent(user.id)}/photo`
    : (user.profile_image_url || null);
  el.innerHTML = photoSrc
    ? `<a href="/profile" class="header-avatar-btn" title="Profile" aria-label="Open profile">
         <img src="${escHtml(photoSrc)}" alt="" class="header-avatar-img">
       </a>`
    : `<a href="/profile" class="header-avatar-btn header-avatar-initials" title="Profile" aria-label="Open profile">
         ${escHtml(initials)}
       </a>`;
}
