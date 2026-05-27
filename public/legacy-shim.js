// ── Cross-module dispatchers ──────────────────────────────────────────────────
// Each shared function is a stable dispatcher that forwards to a registered
// implementation (or a no-op when the owning module isn't loaded). Page modules
// call the matching register*() function instead of re-declaring the global,
// so script load order no longer matters.

// Sales/survey board renderers. Real impls are registered inline in sales.html
// and survey.html after their respective workflow-core.js loads. Pages that
// don't register a real impl (calendar, customers, index, projects) fall back
// to the no-op.
let _workflowHeaderRenderer = function() {};
function renderWorkflowHeader() { _workflowHeaderRenderer(); }
function registerWorkflowHeaderRenderer(fn) { _workflowHeaderRenderer = fn; }

let _workflowStagesRenderer = function() {};
function renderWorkflowStages() { _workflowStagesRenderer(); }
function registerWorkflowStagesRenderer(fn) { _workflowStagesRenderer = fn; }

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

function closeInvoicePanel() { /* legacy no-op — panel migrated to React InvoiceDetailDrawer */ }

// ── App State ─────────────────────────────────────────────────────────────────
const state = {
  contacts: [],
  filteredContacts: [],
  contactsViewMode: 'active',
  workflow: null,
  authStatus: null,
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
  whatsappEnabled: false,
};
window.state = state;

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

// ── API helpers ───────────────────────────────────────────────────────────────
// @deprecated — React components should import GET/POST/PATCH/PUT/DELETE from
// src/react/utils/api.ts instead of using these window globals. These remain for
// vanilla-JS pages (workflow-core.js, workflow.js, card-action-handlers.js)
// during migration and will be removed when those files are ported to React.
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

// @deprecated — React components should import escHtml from src/react/utils/formatters.ts.
function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// @deprecated — React components should import safeUrl from src/react/utils/formatters.ts.
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

// @deprecated — React components should import formatDate/formatShortDate/todayISO
// from src/react/utils/formatters.ts. These remain for vanilla-JS pages during migration.
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

// @deprecated — React components should import contactName/contactDisplayName from
// src/react/utils/formatters.ts. These remain for vanilla-JS pages during migration.
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

// @deprecated — Use window.toast() (set by ToastProvider in AppThemeProvider) for
// cross-island toast messages. This vanilla-JS implementation is kept as a fallback
// for pages that have no React island mounted (there are currently none). New callers
// should use the useToast() hook inside React components, or window.toast() from
// vanilla-JS modules. window.toast() is registered by src/react/contexts/ToastContext.tsx.
function showToast(msg, isError) {
  // Forward to the React ToastProvider shim if available (registered on DOMContentLoaded
  // by the first island that mounts). Falls back to the DOM-append implementation.
  if (typeof window.toast === 'function') {
    window.toast(msg, isError);
    return;
  }
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

function showAccessGate(params) {
  let view = 'form';
  if (params.get('email_conflict') === '1') {
    view = 'email_conflict';
  } else if (
    params.get('access_requested') === '1' ||
    params.get('denied') === '1' ||
    params.has('error')
  ) {
    view = 'confirmed';
  }
  window.dispatchEvent(new CustomEvent('mo:show-access-gate', { detail: { view, urlParams: params } }));
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
  } else {
    location.href = '/customers?q=' + encodeURIComponent(val);
  }
}

function onHeaderPlusBtn() {
  location.href = '/customers?new=1';
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
