// ── Viewer-mode and privilege-gated CSS ───────────────────────────────────────
// Injected once; hides elements based on role body classes.
(function () {
  const s = document.createElement('style');
  s.textContent = [
    'body.viewer-mode [data-viewer-hide]{display:none!important}',
    'body:not(.admin-mode) [data-admin-only]{display:none!important}',
    'body:not(.manager-mode):not(.admin-mode) [data-manager-only]{display:none!important}',
  ].join('\n');
  document.head.appendChild(s);
}());

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
  contactStageCache: {},   // contactId -> [{room, stageKey, roomStatus}]
  contactUrgencyCache: {}, // contactId -> 'red'|'orange'|null
  loadingContact: false,
  tasks: [],
  showAddTask: false,
  addingRoom: false,
  stageFilter: '',
  leadStatusFilter: '',
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

// ── User prefs helpers ────────────────────────────────────────────────────────
// Fetched once per session; cached in state.prefs. Individual keys are updated
// with patchPref() which keeps the local cache in sync and fire-and-forgets the
// server write so callers don't have to await it for UI responsiveness.

async function ensurePrefs() {
  if (state._prefsLoaded) return state.prefs;
  if (isViewerOnly()) {
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

function isViewerOnly() {
  return document.body.classList.contains('viewer-mode');
}

// True only for manager+ users — controls who may change pipeline state
// (customer stage, substage / completed tasks, and HubSpot lead status).
// Members and viewers are treated identically for pipeline editing.
function canEditPipeline() {
  return document.body.classList.contains('manager-mode')
      || document.body.classList.contains('admin-mode');
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

  const priv = user.privilege_level || 'member';

  // Viewers and members may not access these pages directly.
  const RESTRICTED_PATHS = new Set([
    '/sales', '/sales.html',
    '/survey', '/survey.html',
    '/projects', '/projects.html',
    '/invoices', '/invoices.html',
  ]);
  if (RESTRICTED_PATHS.has(location.pathname) &&
      priv !== 'manager' && priv !== 'admin') {
    window.location.href = '/';
    return false;
  }

  if (priv === 'viewer') {
    document.body.classList.add('viewer-mode');
    showViewerBanner();
  }

  // Show the Trades and Ideas nav links for all authenticated users
  const bnavTrades = document.getElementById('bnav-trades');
  if (bnavTrades) bnavTrades.style.display = '';
  const bnavIdeas = document.getElementById('bnav-ideas');
  if (bnavIdeas) bnavIdeas.style.display = '';

  if (priv === 'manager' || priv === 'admin') {
    document.body.classList.add('manager-mode');
    ['bnav-sales', 'bnav-survey', 'bnav-projects', 'bnav-invoices'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = '';
    });
  }

  if (priv === 'admin') {
    document.body.classList.add('admin-mode');
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
    if (document.getElementById('customers-view') || document.getElementById('sales-view')) renderCustomerList();
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
let _pendingCountInterval = null;

function _updatePendingDot() {
  const el = document.getElementById('auth-status');
  if (!el) return;
  fetch('/api/admin/pending-count')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      const btn = el.querySelector('.header-avatar-btn');
      if (!btn) return;
      let dot = btn.querySelector('.header-avatar-dot');
      if (data && data.count > 0) {
        if (!dot) {
          dot = document.createElement('span');
          dot.className = 'header-avatar-dot';
          dot.setAttribute('aria-label', 'Pending access requests');
          btn.appendChild(dot);
        }
      } else {
        if (dot) dot.remove();
      }
    })
    .catch(() => {});
}

function renderAuthStatus() {
  const el = document.getElementById('auth-status');
  if (!el) return;
  const user = state.user;
  if (!user) { el.innerHTML = ''; return; }
  const initials = [user.first_name, user.last_name]
    .filter(Boolean).map(s => s[0]).join('').toUpperCase() || '?';
  let photoSrc = user.has_custom_photo
    ? `/api/users/${encodeURIComponent(user.id)}/photo`
    : (user.profile_image_url || null);
  if (photoSrc && user.photo_v) {
    photoSrc += (photoSrc.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(user.photo_v);
  }
  const currentPath = window.location.pathname;
  const adminActive = (currentPath === '/admin' || currentPath.startsWith('/admin/')) ? ' header-icon-btn--active' : '';
  const profileActive = (currentPath === '/profile' || currentPath.startsWith('/profile/')) ? ' header-icon-btn--active' : '';
  const adminIconHtml = user.privilege_level === 'admin'
    ? `<a href="/admin" class="header-icon-btn${adminActive}" aria-label="Admin panel" title="Admin panel">
         <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
           <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0 1 12 2.944a11.955 11.955 0 0 1-8.618 3.04A12.02 12.02 0 0 0 3 9c0 5.591 3.824 10.29 9 11.622C17.176 19.29 21 14.591 21 9c0-1.052-.122-2.077-.354-3.057z"/>
         </svg>
       </a>`
    : '';
  el.innerHTML = adminIconHtml + (photoSrc
    ? `<a href="/profile" class="header-avatar-btn${profileActive}" title="Profile" aria-label="Open profile">
         <img src="${escHtml(photoSrc)}" alt="" class="header-avatar-img">
       </a>`
    : `<a href="/profile" class="header-avatar-btn header-avatar-initials${profileActive}" title="Profile" aria-label="Open profile">
         ${escHtml(initials)}
       </a>`);

  if (_pendingCountInterval !== null) {
    clearInterval(_pendingCountInterval);
    _pendingCountInterval = null;
  }

  if (user.privilege_level === 'admin') {
    if (document.visibilityState !== 'hidden') {
      _updatePendingDot();
      _pendingCountInterval = setInterval(_updatePendingDot, 60_000);
    }
    document.removeEventListener('visibilitychange', _onPendingVisibility);
    document.addEventListener('visibilitychange', _onPendingVisibility);
    window.addEventListener('beforeunload', () => {
      clearInterval(_pendingCountInterval);
      _pendingCountInterval = null;
      document.removeEventListener('visibilitychange', _onPendingVisibility);
    }, { once: true });
  }
}

function _onPendingVisibility() {
  if (document.visibilityState === 'hidden') {
    clearInterval(_pendingCountInterval);
    _pendingCountInterval = null;
  } else if (_pendingCountInterval === null) {
    _updatePendingDot();
    _pendingCountInterval = setInterval(_updatePendingDot, 60_000);
  }
}
