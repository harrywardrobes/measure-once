// ── Cross-module dispatchers ──────────────────────────────────────────────────
// Each shared function is a stable dispatcher that forwards to a registered
// implementation (or a no-op when the owning module isn't loaded). Page modules
// call the matching register*() function instead of re-declaring the global,
// so script load order no longer matters.

// Sales-owned renderers (real impls in sales.js). Pages that load
// workflow-core.js but NOT sales.js (calendar, customers, index, invoices,
// projects) fall back to the no-op.
let _workflowHeaderRenderer = function() {};
function renderWorkflowHeader() { _workflowHeaderRenderer(); }
function registerWorkflowHeaderRenderer(fn) { _workflowHeaderRenderer = fn; }

let _workflowStagesRenderer = function() {};
function renderWorkflowStages() { _workflowStagesRenderer(); }
function registerWorkflowStagesRenderer(fn) { _workflowStagesRenderer = fn; }

let _roomTabsRenderer = function() {};
function renderRoomTabs() { _roomTabsRenderer(); }
function registerRoomTabsRenderer(fn) { _roomTabsRenderer = fn; }

let _workflowDataSaver = async function() {};
async function saveWorkflowData() { return _workflowDataSaver(); }
function registerWorkflowDataSaver(fn) { _workflowDataSaver = fn; }

// Renderer registry for customer/projects views.
let _customerListRenderer = function() {};
function renderCustomerList() { _customerListRenderer(); }
function registerCustomerListRenderer(fn) { _customerListRenderer = fn; }

let _projectsViewRenderer = function() {};
function renderProjectsView() { _projectsViewRenderer(); }
function registerProjectsViewRenderer(fn) { _projectsViewRenderer = fn; }

// Workflow-core-owned loaders/filters (real impls in workflow-core.js). Pages
// that don't load workflow-core.js (e.g. /profile, /trades) keep the no-ops.
let _workflowLoader = async function() {};
async function loadWorkflow() { return _workflowLoader(); }
function registerWorkflowLoader(fn) { _workflowLoader = fn; }

let _openLeadsLoader = async function() {};
async function loadOpenLeads() { return _openLeadsLoader(); }
function registerOpenLeadsLoader(fn) { _openLeadsLoader = fn; }

let _workflowStagesLoader = async function() {};
async function loadWorkflowStages() { return _workflowStagesLoader(); }
function registerWorkflowStagesLoader(fn) { _workflowStagesLoader = fn; }

let _stageFilterPopulator = function() {};
function populateStageFilter() { _stageFilterPopulator(); }
function registerStageFilterPopulator(fn) { _stageFilterPopulator = fn; }

let _dealsFilter = function() {};
function filterDeals(query) { _dealsFilter(query); }
function registerDealsFilter(fn) { _dealsFilter = fn; }

// Sales stubs — safe no-ops on pages that don't load sales.js
function renderGoogleEmailSection() {}

// invoices-core-owned loader. Pages that don't load invoices-core.js
// (calendar, profile, trades) keep the no-op.
let _qbInvoicesLoader = async function() {};
async function loadQBInvoices() { return _qbInvoicesLoader(); }
function registerQBInvoicesLoader(fn) { _qbInvoicesLoader = fn; }
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
  focusedStageKey: null,
  focusedLeadStatus: null,
  contactStageCache: {},   // contactId -> [{room, stageKey, roomStatus}]
  contactUrgencyCache: {}, // contactId -> 'red'|'orange'|null
  loadingContact: false,
  tasks: [],
  showAddTask: false,
  addingRoom: false,
  stageFilter: '',
  leadStatusFilter: '',
  substatusFilter: '',
  showExcludedLeadStatuses: false,
  leadStatusCounts: {},
  sortBy: 'newest',
  showArchived: false,
  projectStageFilter: '',
  salesStageFilter: '',
  customerNotes: '',
  personalTasks: [],
  calendarEvents: [],
  calendarConnected: false,
  calendarError: false,
  calendarLoading: false,
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
  whatsappEnabled: false,
};

// ── Privilege helper (non-React) ──────────────────────────────────────────────
// Single source of truth for vanilla-JS privilege reads. Mirrors the logic in
// src/react/hooks/usePrivilege.ts so all callers stay consistent.
// Prefer usePrivilege() inside React components.
// NOTE: window.__moHeaderUser is deprecated — use getPrivilegeLevel() instead.
//
// Audit (all public/*.js privilege reads verified):
//   - All callers use getPrivilegeLevel() or its named wrappers below.
//   - No raw state.user?.privilege_level reads exist outside this function.
//   - `??` (null-coalescing) is used so only null/undefined falls back to
//     'member'; a valid non-empty string (e.g. 'viewer') is never discarded.
function getPrivilegeLevel() {
  const user = window.__moHeaderUser || state.user || null;
  return user?.privilege_level ?? 'member';
}
function isViewerPrivilege()  { return getPrivilegeLevel() === 'viewer'; }
function isAdminPrivilege()   { return getPrivilegeLevel() === 'admin'; }
function canEditPrivilege()   { const p = getPrivilegeLevel(); return p === 'manager' || p === 'admin'; }

// ── User prefs helpers ────────────────────────────────────────────────────────
// Fetched once per session; cached in state.prefs. Individual keys are updated
// with patchPref() which keeps the local cache in sync and fire-and-forgets the
// server write so callers don't have to await it for UI responsiveness.

async function ensurePrefs() {
  if (state._prefsLoaded) return state.prefs;
  if (getPrivilegeLevel() === 'viewer') {
    state.prefs = {};
    state._prefsLoaded = true;
    return state.prefs;
  }
  try {
    state.prefs = await GET('/api/users/me/prefs');
  } catch {
    state.prefs = {};
  }
  state._prefsLoaded = true;
  return state.prefs;
}

async function patchPref(key, value) {
  if (!state.prefs) state.prefs = {};
  state.prefs[key] = value;
  try {
    await PATCH_REQ('/api/users/me/prefs', { [key]: value });
  } catch (e) {
    console.warn('Failed to save preference:', key, e);
  }
}

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
    window.location.href = '/login';
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

function safeUrl(url) {
  const s = (url || '').trim();
  if (!s) return '';
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  return s;
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
  '/survey': 'survey',
  '/projects': 'projects',
  '/calendar': 'calendar',
  '/invoices': 'invoices',
  '/ideas': 'ideas',
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
    // Preserve any query-string flags so /login can still show them.
    const qs = window.location.search ? window.location.search : '';
    window.location.href = '/login' + qs;
    return false;
  }

  // First-time users must finish their profile before they can use the app.
  if (user.onboarding_status === 'more_info_required'
      && window.location.pathname !== '/onboarding') {
    window.location.href = '/onboarding';
    return false;
  }

  state.user = user;
  // Notify React islands (GlobalHeader, ProfilePage, …) that state.user is now populated.
  // checkAuthStatus() already fires this on re-checks; bootstrap was the missing path.
  renderAuthStatus();

  const priv = getPrivilegeLevel();

  if (priv === 'viewer') {
    showViewerBanner();
  }

  // Show the Trades and Ideas nav links for all authenticated users
  const bnavTrades = document.getElementById('bnav-trades');
  if (bnavTrades) bnavTrades.style.display = '';
  const bnavIdeas = document.getElementById('bnav-ideas');
  if (bnavIdeas) bnavIdeas.style.display = '';

  if (priv === 'manager' || priv === 'admin') {
    ['bnav-sales', 'bnav-survey', 'bnav-projects', 'bnav-invoices'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = '';
    });
  }

  try {
    await checkAuthStatus();
    await loadWorkflow();
    await Promise.all([loadOpenLeads(), loadWorkflowStages(), ensurePrefs(),
      typeof loadLeadStatuses === 'function' ? loadLeadStatuses() : Promise.resolve(),
      typeof loadStageActionLabels === 'function' ? loadStageActionLabels() : Promise.resolve(),
      typeof loadLeadSubstatuses === 'function' ? loadLeadSubstatuses() : Promise.resolve(),
      GET('/api/whatsapp/config').then(cfg => { state.whatsappEnabled = !!cfg.enabled; }).catch(() => {}),
    ]);
    populateStageFilter();
    if (document.getElementById('customers-view') || document.getElementById('sales-view') || document.getElementById('survey-view')) renderCustomerList();
    if (priv === 'manager' || priv === 'admin') loadQBInvoices();
  } catch (e) {
    console.error('Bootstrap failed', e);
    const list        = document.getElementById('customers-view');
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
      } else if (e.code === 'DB_ERROR') {
        msg = 'The list couldn\'t be loaded — there was a problem reaching the database.';
        action = `<button onclick="location.reload()" class="mt-2 text-blue-600 underline text-xs">Retry</button>`;
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
  const isConfirmed      = params.get('access_requested') === '1'
    || params.get('denied') === '1'
    || params.has('error');

  const signInEl            = document.getElementById('access-sign-in-state');
  const confirmedEl         = document.getElementById('access-confirmed-state');
  const emailConflictEl     = document.getElementById('access-email-conflict-state');

  const anySpecial = isConfirmed || isEmailConflict;
  if (signInEl)          signInEl.style.display          = !anySpecial ? '' : 'none';
  if (confirmedEl)       confirmedEl.style.display       = (isConfirmed && !isEmailConflict) ? '' : 'none';
  if (emailConflictEl)   emailConflictEl.style.display   = isEmailConflict ? '' : 'none';
}

async function checkAuthStatus() {
  const prevGoogle = state.authStatus.google;
  const [status, user] = await Promise.all([
    GET('/auth/status'),
    fetch('/api/auth/user').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  state.authStatus = status;
  state.user = user;
  renderAuthStatus();
  if (!prevGoogle && state.authStatus.google && state.selectedContact) {
    renderGoogleEmailSection();
  }
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
      const firstCard = document.querySelector('.customer-project-card');
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
  // Navigate directly to the standalone customer detail page.
  const idx = parseInt(roomIdx, 10) || 0;
  location.href = idx ? `/customers/${contactId}?room=${idx}` : `/customers/${contactId}`;
}

// ── Auth Status ───────────────────────────────────────────────────────────────
// The pending-access-request dot is now owned by the React GlobalHeader
// (src/react/components/GlobalHeader.tsx); it polls /api/admin/pending-count
// itself when the current user is an admin. This module only publishes
// state.user changes via the `mo:user` window event below.

function renderAuthStatus() {
  // The top app bar is rendered by the React GlobalHeader island
  // (src/react/components/GlobalHeader.tsx) mounted into #app-header-mount.
  // Publish the current user via a window event so the island can update
  // its admin icon / avatar in lockstep with state.user changes here.
  const user = state.user || null;
  window.__moHeaderUser = user;
  try {
    window.dispatchEvent(new CustomEvent('mo:user', { detail: user }));
  } catch {
    // CustomEvent unavailable (very old browser) — header will fall back
    // to its own `/api/auth/user` read when it mounts. No-op here.
  }

  // Legacy fallback: if a page still ships an #auth-status element, clear
  // it so stale markup doesn't leak through while the React island mounts.
  const legacy = document.getElementById('auth-status');
  if (legacy) legacy.innerHTML = '';
}
