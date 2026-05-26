// Workflow definition, stage colours, workflow/leads data loaders,
// list filters, and the undo bottom bar.
// Loaded only on pages that show workflow data (sales, projects).

// ── Workflow Definition ────────────────────────────────────────────────────────
// Cold-start fallback only. The runtime workflow is loaded from /api/workflow
// (backed by workflow.json) into state.workflow; this object is consulted ONLY
// when that fetch returns null (see _loadWorkflowImpl below).
//
// Kept on purpose:
//   - The 9 stage keys, in pipeline order. STAGE_KEYS is derived from them and
//     is used across projects.js / workflow.js / customer-detail.js to order
//     and compare stages.
//   - A `label` per stage so labels rendered from state.workflow.stages[k].label
//     don't fall through to the raw key on cold-start.
//
// The per-stage `statuses` arrays that used to live here drove the legacy
// stage-and-sub-task tracker on the customer page. That tracker has been
// replaced by the admin-configured lead-status tracker (task #597), so the
// hardcoded sub-tasks were just drifting from the live admin data — they are
// intentionally omitted here. Runtime code that still touches
// state.workflow.stages[k].statuses (e.g. sales / survey cards, workflow.js,
// _saveWorkflowDataImpl) reads the live array loaded from workflow.json and
// degrades gracefully when it's absent.
const DEFAULT_WORKFLOW = {
  stages: {
    sales:        { label: 'Sales' },
    designvisit:  { label: 'Design Visit' },
    survey:       { label: 'Survey' },
    order:        { label: 'Order' },
    workshop:     { label: 'Workshop' },
    packing:      { label: 'Packing' },
    delivery:     { label: 'Delivery' },
    installation: { label: 'Installation' },
    aftercare:    { label: 'Aftercare' },
  }
};

const STAGE_COLOURS = [
  { key: 'sales',           bg: '#8B2BFF', light: '#F3EAFF', text: '#6A12D9' },  // orchid       — Sales
  { key: 'designvisit',     bg: '#0d9488', light: '#ccfbf1', text: '#0f766e' },  // teal         — Design Visit
  { key: 'survey',          bg: '#d97706', light: '#fef3c7', text: '#b45309' },  // amber        — Survey
  { key: 'order',           bg: '#2563eb', light: '#dbeafe', text: '#1d4ed8' },  // blue         — Order
  { key: 'workshop',        bg: '#dc2626', light: '#fee2e2', text: '#b91c1c' },  // red          — Workshop
  { key: 'packing',         bg: '#059669', light: '#d1fae5', text: '#047857' },  // emerald      — Packing
  { key: 'delivery',        bg: '#0891b2', light: '#cffafe', text: '#0e7490' },  // cyan         — Delivery
  { key: 'installation',    bg: '#8A5A3B', light: '#fdf6ee', text: '#5c3820' },  // walnut       — Installation
  { key: 'aftercare',       bg: '#200842', light: '#ede0ff', text: '#3d0f7a' },  // plum         — Aftercare
];

const STAGE_KEYS = Object.keys(DEFAULT_WORKFLOW.stages);

function stageColour(stageKey) {
  const idx = STAGE_KEYS.indexOf(stageKey);
  return STAGE_COLOURS[Math.max(0, idx)];
}

// Record the date a room first entered a stage — never overwrites an existing date.
function recordStageDate(room, stageKey) {
  if (!room.stageDates) room.stageDates = {};
  if (!room.stageDates[stageKey]) room.stageDates[stageKey] = todayISO();
}

// Record the date a room entered a substage — always overwrites so the date
// reflects the most recent time that substage became active.
function recordSubstageDate(room, substageId) {
  if (!substageId) return;
  if (!room.substateDates) room.substateDates = {};
  room.substateDates[substageId] = todayISO();
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
  state.contactStageCache[state.selectedContactId] = state.allRooms.map(r => {
    const stageKey = r.stageKey || 'sales';
    // Derive the current substage from completedStatuses (last completed in stage order).
    // Fall back to the legacy r.statusId field for rooms that haven't been normalised yet.
    const doneIds = (r.completedStatuses || {})[stageKey] || [];
    const stageStatuses = state.workflow?.stages?.[stageKey]?.statuses || [];
    const lastCompleted = [...stageStatuses].reverse().find(s => doneIds.includes(s.id));
    const currentSubstageId = lastCompleted?.id || r.statusId || null;

    return {
      room: r.room, stageKey, roomStatus: r.roomStatus || 'active',
      statusId: currentSubstageId,
      sourceId: r.sourceId || null,
      assignedFitterId: r.assignedFitterId || null,
      installStart: r.installStart || null,
      stageDates: r.stageDates || null,
      substateDates: r.substateDates || null,
    };
  });
}

// ── Data loaders ──────────────────────────────────────────────────────────────
async function _loadWorkflowImpl() {
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

// Re-apply any in-flight optimistic lead-status changes after state.contacts is
// replaced by a server refresh. Prevents the badge from reverting while the
// PATCH response is still in-flight.
function _reapplyPendingLeadStatuses() {
  const pending = state.pendingLeadStatus;
  if (!pending || !Object.keys(pending).length) return;
  for (const [contactId, status] of Object.entries(pending)) {
    const c = state.contacts.find(c => c.id === contactId);
    if (c) c.properties = { ...(c.properties || {}), hs_lead_status: status };
  }
  if (state.selectedContactId) {
    const fresh = state.contacts.find(c => c.id === state.selectedContactId);
    if (fresh) state.selectedContact = fresh;
  }
}

// Merge a single freshly-fetched contact object into state.contacts, honouring
// any in-flight optimistic lead-status change recorded in state.pendingLeadStatus.
// Use this instead of a direct array splice whenever a single contact is
// re-fetched from the server (e.g. after saving a note or updating a deal field)
// so the badge never reverts while a PATCH is still in-flight.
//
// Usage:
//   _mergeContactIntoState(freshContactObject);
function _mergeContactIntoState(freshContact) {
  if (!freshContact || !freshContact.id) return;

  // Preserve any pending optimistic lead-status override.
  const pending = state.pendingLeadStatus;
  if (pending && Object.prototype.hasOwnProperty.call(pending, freshContact.id)) {
    freshContact = {
      ...freshContact,
      properties: {
        ...(freshContact.properties || {}),
        hs_lead_status: pending[freshContact.id]
      }
    };
  }

  const idx = state.contacts.findIndex(c => c.id === freshContact.id);
  if (idx !== -1) {
    state.contacts[idx] = freshContact;
  } else {
    state.contacts.push(freshContact);
  }

  // Keep the detail-panel reference current if this contact is selected.
  if (state.selectedContactId === freshContact.id) {
    state.selectedContact = freshContact;
  }
}

// When /api/open-leads returns X-Cache-Status: stale or fresh while the tab
// is hidden we defer the badge update so the user sees it only when they look
// at the tab again (same pattern as _pendingRoomAssignmentsStale).
// null = no pending update.
// A test hook (window.__setTestPendingOpenLeadsStale) lets integration tests
// drive the pending ref directly without a network round-trip.
let _pendingOpenLeadsStale = null;
window.__setTestPendingOpenLeadsStale = (v) => { _pendingOpenLeadsStale = v; };

async function _loadOpenLeadsImpl() {
  const r = await fetch('/api/open-leads', { method: 'GET', headers: { 'Content-Type': 'application/json' } });
  if (r.status === 401) { window.location.href = '/login'; throw new Error('Unauthorized'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    if (data.code) err.code = data.code;
    throw err;
  }
  const cacheStatus = r.headers.get('X-Cache-Status');
  if (cacheStatus === 'fresh' || cacheStatus === 'stale') {
    const nextStale = cacheStatus === 'stale';
    if (document.hidden) {
      _pendingOpenLeadsStale = nextStale;
    } else {
      state.openLeadsStale = nextStale;
      _pendingOpenLeadsStale = null;
    }
  }
  state.contacts = data.results || [];
  _reapplyPendingLeadStatuses();
  state.filteredContacts = [...state.contacts];
}

async function loadAllContacts() {
  const allResults = [];
  let page = 1;
  const limit = 100;
  let totalPages = 1;
  let detectedStale = false;
  do {
    const qs = new URLSearchParams({ page, limit });
    const url = `/api/contacts-all?${qs}`;
    if (page === 1) {
      const r = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
      if (r.status === 401) { window.location.href = '/login'; throw new Error('Unauthorized'); }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { const err = new Error(data.error || `HTTP ${r.status}`); if (data.code) err.code = data.code; throw err; }
      if ((r.headers.get('X-Cache-Status') || '').toLowerCase() === 'stale') detectedStale = true;
      allResults.push(...(data.results || []));
      totalPages = data.totalPages || 1;
    } else {
      const data = await GET(url);
      allResults.push(...(data.results || []));
      totalPages = data.totalPages || 1;
    }
    page++;
  } while (page <= totalPages);
  state.contacts = allResults;
  _reapplyPendingLeadStatuses();
  state.filteredContacts = [...state.contacts];
  document.dispatchEvent(new CustomEvent('sales-board-cache-status', { detail: { stale: detectedStale } }));
}

async function loadContactsPage({ page = 1, leadStatus = '', sort = 'newest' } = {}) {
  const qs = new URLSearchParams({ page, limit: 25 });
  if (leadStatus) qs.set('leadStatus', leadStatus);
  if (sort && sort !== 'newest') qs.set('sort', sort);
  if (state.searchQuery) qs.set('q', state.searchQuery);
  const data = await GET(`/api/contacts-all?${qs}`);
  state.contacts = data.results || [];
  state.currentPage = data.page || page;
  state.totalPages  = data.totalPages || 1;
  state.total       = data.total != null ? data.total : state.contacts.length;
  _reapplyPendingLeadStatuses();
  state.filteredContacts = [...state.contacts];
}

function setContactsViewMode(mode) {
  state.contactsViewMode = mode;
  const activeBtn = document.getElementById('view-active-btn');
  const allBtn    = document.getElementById('view-all-btn');
  if (activeBtn) activeBtn.classList.toggle('filter-btn-active', mode === 'active');
  if (allBtn)    allBtn.classList.toggle('filter-btn-active',   mode === 'all');

  // Show lead-status filter only in "All" view; reset it when switching modes
  const lsRow = document.getElementById('lead-status-filter-row');
  if (lsRow) lsRow.classList.toggle('hidden', mode !== 'all');
  state.leadStatusFilter = '';
  const lsSel = document.getElementById('lead-status-filter');
  if (lsSel) lsSel.value = '';

  const loader = (mode === 'all') ? loadAllContacts() : loadOpenLeads();
  loader.then(() => {
    state.filteredContacts = [...state.contacts];
    if (mode === 'all') populateLeadStatusFilter();
    renderCustomerList();
  }).catch(() => {});
}

// Visibility-gated stale-banner state for the room assignments panel.
// When /api/localdata/all returns X-Cache-Status: stale or fresh while the tab
// is hidden we defer the banner update so the user sees it only when they look
// at the tab again (matches the contacts-page pattern).  null = no pending update.
// A test hook (window.__setTestPendingRoomStale) lets integration tests drive
// the pending ref directly without a network round-trip.
let _pendingRoomAssignmentsStale = null;
window.__setTestPendingRoomStale = (v) => { _pendingRoomAssignmentsStale = v; };

async function _loadWorkflowStagesImpl() {
  const r = await fetch('/api/localdata/all', { method: 'GET', headers: { 'Content-Type': 'application/json' } });
  if (r.status === 401) { window.location.href = '/login'; throw new Error('Unauthorized'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error || `HTTP ${r.status}`);
    if (data?.code) err.code = data.code;
    throw err;
  }
  const cacheStatus = r.headers.get('X-Cache-Status');
  if (cacheStatus === 'fresh' || cacheStatus === 'stale') {
    const nextStale = cacheStatus === 'stale';
    if (document.hidden) {
      _pendingRoomAssignmentsStale = nextStale;
    } else {
      state.roomAssignmentsStale = nextStale;
      _pendingRoomAssignmentsStale = null;
    }
  }
  for (const [contactId, rooms] of Object.entries(data || {})) {
    state.contactStageCache[contactId] = rooms;
  }
}

function _populateStageFilterImpl() {
  const sel = document.getElementById('stage-filter');
  if (!sel || !state.workflow?.stages) return;
  sel.innerHTML = `<option value="">All stages</option>` +
    Object.entries(state.workflow.stages).map(([key, s]) =>
      `<option value="${escHtml(key)}">${escHtml(s.label)}</option>`
    ).join('');
}

let LEAD_STATUS_OPTIONS = [
  { value: 'NEW',                  label: 'New',                  excluded_from_sales: false },
  { value: 'OPEN',                 label: 'Open',                 excluded_from_sales: false },
  { value: 'IN_PROGRESS',          label: 'In Progress',          excluded_from_sales: false },
  { value: 'OPEN_DEAL',            label: 'Open Deal',            excluded_from_sales: false },
  { value: 'VISIT_SCHEDULED',      label: 'Visit Scheduled',      excluded_from_sales: false },
  { value: 'CONNECTED',            label: 'Connected',            excluded_from_sales: false },
  { value: 'ATTEMPTED_TO_CONTACT', label: 'Attempted to Contact', excluded_from_sales: false },
  { value: 'UNQUALIFIED',          label: 'Unqualified',          excluded_from_sales: true  },
  { value: 'BAD_TIMING',           label: 'Bad Timing',           excluded_from_sales: false },
];

let NULL_LEAD_STATUS_LABEL = 'No status';

// Single-flight + min-interval debounce so bursts of triggers (bootstrap +
// visibilitychange + BroadcastChannel listeners + populateLeadStatusFilter
// refreshes) collapse into one HubSpot fan-out. Server-side caching alone
// isn't enough: a cold-cache burst would still hit the per-second budget.
let _llscInFlight = null;
let _llscLastSettledAt = 0;
const LLSC_MIN_INTERVAL_MS = 1500;

async function loadLeadStatusCounts() {
  // Reuse an in-flight request for any concurrent caller.
  if (_llscInFlight) return _llscInFlight;
  // Debounce rapid repeats: if we just finished, return the cached state
  // instead of firing another request — the burst callers all see the same
  // freshly-loaded counts.
  if (Date.now() - _llscLastSettledAt < LLSC_MIN_INTERVAL_MS) return;

  _llscInFlight = (async () => {
    try {
      const r = await fetch('/api/contacts-lead-status-counts', { method: 'GET', headers: { 'Content-Type': 'application/json' } });
      if (r.status === 401) { window.location.href = '/login'; throw new Error('Unauthorized'); }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const err = new Error(data.error || `HTTP ${r.status}`);
        if (data.code) err.code = data.code;
        throw err;
      }
      if (data && typeof data === 'object') {
        state.leadStatusCounts = data;
        // Clear any prior hard-failure notice now that we have fresh data.
        state.leadStatusCountsError = false;
        // Track whether the server is serving cached (stale) counts so the UI
        // can show a subtle hint without alarming the user.
        const cacheStatus = r.headers.get('X-Cache-Status');
        if (cacheStatus === 'fresh') state.leadStatusCountsStale = false;
        else if (cacheStatus === 'stale') state.leadStatusCountsStale = true;
      }
    } catch (e) {
      // Surface only hard failures; the server falls back to stale counts
      // (X-Cache-Status: stale) for transient HubSpot hiccups, which arrives
      // here as a successful response — no toast needed.
      console.warn('Could not load lead status counts:', e.message);
      // Mark counts as stale so the dot stays visible (or re-appears) after
      // a hard failure — the displayed counts may now be arbitrarily old.
      state.leadStatusCountsStale = true;
      // Signal a hard failure so the UI can show a dismissible notice.
      state.leadStatusCountsError = true;
    } finally {
      _llscLastSettledAt = Date.now();
      _llscInFlight = null;
    }
  })();
  return _llscInFlight;
}

// ── Stage action labels ──────────────────────────────────────────────────────
// Map of `${stage_key}|${status_key}` → label. Populated from
// /api/stage-action-labels at bootstrap and refreshed when the admin panel
// broadcasts changes. Both keys are lowercase to match card substageIds.
let STAGE_ACTION_LABEL_MAP = {};

function stageActionLabelLookup(stageKey, statusKey) {
  const s = String(stageKey  || '').toLowerCase();
  const k = String(statusKey || '').toLowerCase();
  return STAGE_ACTION_LABEL_MAP[`${s}|${k}`] || '';
}

// Resolve a card's action-strip label using the same priority as the admin
// Card Actions tab: lead status first (it's the configurable key), local
// workflow substageId only as a legacy fallback for contacts with no LS, then
// finally the per-stage "no lead status" row. Returns '' when nothing matches
// — the caller is expected to omit the action strip entirely in that case.
function stageOrLeadStatusActionLabel(stageKey, leadStatusKey, substageId) {
  const sKey  = String(stageKey || '').toLowerCase();
  const lsKey = String(leadStatusKey || '').toLowerCase();
  if (lsKey) {
    // Per-LS row in the admin Card Actions tab is the single source of
    // truth for contacts that have a lead status. The server seeds one
    // row per (stage × lead status) on boot, so the row exists unless
    // the admin explicitly cleared it. Result:
    //   - Non-empty label → use it.
    //   - Empty / missing  → return '' so the caller omits the strip
    //     (no per-stage default fallback — that would mask the admin's
    //     per-LS configuration).
    return stageActionLabelLookup(sKey, lsKey) || '';
  }
  if (substageId) {
    const fromSub = stageActionLabelLookup(sKey, substageId);
    if (fromSub) return fromSub;
  }
  // Contact genuinely has no lead status: use the per-stage "no lead status"
  // row (stored as stage_action_labels[stage|'']).
  return stageActionLabelLookup(sKey, '') || '';
}

// ── Lead sub-statuses ────────────────────────────────────────────────────────
// Per (lead_status, sub-status) action labels. Surfaced on contacts via the
// HubSpot `hw_lead_substatus` enumeration property whose option values are
// namespaced as `${STATUS_KEY}__${SUBSTATUS_KEY}`. Keys here are uppercase
// to match HubSpot's lead-status convention.
let LEAD_SUBSTATUSES = [];
let LEAD_SUBSTATUS_ACTION_MAP = {}; // `${STATUS_KEY}|${SUBSTATUS_KEY}` → action_label

function substatusActionLabelLookup(statusKey, hwSubstatusValue) {
  if (!statusKey || !hwSubstatusValue) return '';
  const sk = String(statusKey).toUpperCase();
  const v  = String(hwSubstatusValue).toUpperCase();
  const expectedPrefix = `${sk}__`;
  if (!v.startsWith(expectedPrefix)) return ''; // belongs to a different lead status
  const subKey = v.slice(expectedPrefix.length);
  return LEAD_SUBSTATUS_ACTION_MAP[`${sk}|${subKey}`] || '';
}

async function loadLeadSubstatuses() {
  try {
    const rows = await GET('/api/lead-substatuses');
    if (Array.isArray(rows)) {
      LEAD_SUBSTATUSES = rows;
      window.LEAD_SUBSTATUSES = rows;
      const m = {};
      for (const r of rows) {
        if (!r.action_label) continue;
        const k = `${String(r.status_key).toUpperCase()}|${String(r.substatus_key).toUpperCase()}`;
        m[k] = r.action_label;
      }
      LEAD_SUBSTATUS_ACTION_MAP = m;
    }
  } catch (e) {
    console.warn('Could not load lead sub-statuses:', e.message);
  }
}

async function loadStageActionLabels() {
  try {
    const rows = await GET('/api/stage-action-labels');
    if (Array.isArray(rows)) {
      const m = {};
      for (const r of rows) {
        const s = String(r.stage_key  || '').toLowerCase();
        const k = String(r.status_key || '').toLowerCase();
        const label = String(r.label || '').trim();
        if (s && label) m[`${s}|${k}`] = label;
      }
      STAGE_ACTION_LABEL_MAP = m;
    }
  } catch (e) {
    console.warn('Could not load stage action labels:', e.message);
  }
}

// True once /api/lead-statuses has responded (success or empty). Lets renderers
// distinguish "haven't tried yet" (show skeleton / keep seeded defaults) from
// "server returned an empty config" (fall back to the legacy workflow tracker).
let LEAD_STATUSES_LOADED = false;

async function loadLeadStatuses() {
  try {
    const rows = await GET('/api/lead-statuses');
    if (Array.isArray(rows)) {
      const nullRow = rows.find(r => r.is_null_row);
      if (nullRow) NULL_LEAD_STATUS_LABEL = nullRow.label || 'No status';
      LEAD_STATUS_OPTIONS = rows
        .filter(r => !r.is_null_row)
        .map(r => ({
          value:               r.key,
          label:               r.label,
          excluded_from_sales: !!r.excluded_from_sales,
          stage:               r.stage || null,
        }));
      LEAD_STATUSES_LOADED = true;
    }
  } catch (e) {
    console.warn('Could not load lead statuses from server, using defaults:', e.message);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Apply any deferred room-stale-banner update from a fetch that arrived
  // while the tab was hidden, then re-render the projects view.
  if (_pendingRoomAssignmentsStale !== null) {
    state.roomAssignmentsStale = _pendingRoomAssignmentsStale;
    _pendingRoomAssignmentsStale = null;
    renderProjectsView();
  }
  // Apply any deferred open-leads stale-badge update and re-render.
  if (_pendingOpenLeadsStale !== null) {
    state.openLeadsStale = _pendingOpenLeadsStale;
    _pendingOpenLeadsStale = null;
    if (typeof renderWorkflowStages === 'function') renderWorkflowStages();
  }
  Promise.all([loadLeadStatuses(), loadLeadStatusCounts(), loadLeadSubstatuses()]).then(() => {
    populateLeadStatusFilter();
    renderCustomerList();
    if (typeof renderEnquiryList === 'function') renderEnquiryList();
    if (document.getElementById('workflow-stages')) {
      renderWorkflowStages();
    }
  });
});

// ── Cross-tab lead-status refresh ─────────────────────────────────────────────
// When the admin settings panel saves a lead-status change in another tab,
// it broadcasts on this channel so open contact lists can re-render immediately
// without requiring the user to leave and return to the tab.
if (typeof BroadcastChannel !== 'undefined') {
  const _maybeRenderStages = () => {
    if (document.getElementById('workflow-stages')) {
      renderWorkflowStages();
    }
  };

  const _lsChannel = new BroadcastChannel('lead_statuses_changed');
  _lsChannel.addEventListener('message', () => {
    Promise.all([loadLeadStatuses(), loadLeadStatusCounts()]).then(() => {
      populateLeadStatusFilter();
      renderCustomerList();
      if (typeof renderEnquiryList === 'function') renderEnquiryList();
      _maybeRenderStages();
    });
  });

  const _sacChannel = new BroadcastChannel('stage_action_labels_changed');
  _sacChannel.addEventListener('message', () => {
    loadStageActionLabels().then(() => {
      renderCustomerList();
      if (typeof renderEnquiryList === 'function') renderEnquiryList();
      if (typeof renderSurveyList  === 'function') renderSurveyList();
      _maybeRenderStages();
    });
  });

  const _subChannel = new BroadcastChannel('lead_substatuses_changed');
  _subChannel.addEventListener('message', () => {
    loadLeadSubstatuses().then(() => {
      renderCustomerList();
      if (typeof renderEnquiryList === 'function') renderEnquiryList();
      if (typeof renderSurveyList  === 'function') renderSurveyList();
      renderWorkflowHeader();
      _maybeRenderStages();
    });
  });
}

function populateLeadStatusFilter() {
  const sel = document.getElementById('lead-status-filter');
  if (!sel) return;

  const serverCounts = state.leadStatusCounts && Object.keys(state.leadStatusCounts).length > 0;

  let counts, nullCount;
  if (serverCounts) {
    counts = state.leadStatusCounts;
    nullCount = counts['__no_status__'] || 0;
  } else {
    counts = {};
    nullCount = 0;
    for (const c of state.contacts) {
      const s = c.properties?.hs_lead_status || '';
      if (s) counts[s] = (counts[s] || 0) + 1;
      else nullCount++;
    }
  }

  const nullLabel = (typeof NULL_LEAD_STATUS_LABEL !== 'undefined' ? NULL_LEAD_STATUS_LABEL : null) || 'No status';
  const nullAttrs = nullCount === 0 ? ' disabled style="color:#cbd5e1"' : '';

  const prevValue = sel.value;
  sel.innerHTML = `<option value="">All statuses</option>` +
    `<option value="__no_status__"${nullAttrs}>${escHtml(nullLabel)} (${nullCount})</option>` +
    LEAD_STATUS_OPTIONS.filter(o => !o.excluded_from_sales).map(({ value, label }) => {
      const n = counts[value] || 0;
      const attrs = n === 0 ? ' disabled style="color:#cbd5e1"' : '';
      return `<option value="${escHtml(value)}"${attrs}>${escHtml(label)} (${n})</option>`;
    }).join('');

  if (prevValue) sel.value = prevValue;

  // Stale-counts hint: show a subtle dot next to the select when the server
  // is serving cached counts (X-Cache-Status: stale), or while a background
  // refresh is in flight (the displayed counts are still from the last response).
  // Clears only once a fresh response lands with no pending refresh.
  const existingHint = document.getElementById('ls-counts-stale-hint');
  if (state.leadStatusCountsStale || _llscInFlight) {
    if (!existingHint) {
      const hint = document.createElement('span');
      hint.id = 'ls-counts-stale-hint';
      hint.className = 'ls-stale-hint';
      hint.title = 'Counts may be slightly out of date';
      hint.setAttribute('aria-label', 'Using cached data');
      hint.textContent = '•';
      sel.insertAdjacentElement('afterend', hint);
    }
  } else if (existingHint) {
    existingHint.remove();
  }

  // Error notice: dismissible inline banner shown only on hard failures (network
  // error, 5xx). Auto-clears when the next successful load arrives.
  const existingErrorNotice = document.getElementById('ls-counts-error-notice');
  if (state.leadStatusCountsError) {
    if (!existingErrorNotice) {
      const notice = document.createElement('div');
      notice.id = 'ls-counts-error-notice';
      notice.className = 'ls-counts-error-notice';
      notice.setAttribute('role', 'alert');
      const msg = document.createElement('span');
      msg.textContent = "Counts couldn\u2019t refresh \u2014 showing last cached values";
      const btn = document.createElement('button');
      btn.className = 'ls-counts-error-dismiss';
      btn.setAttribute('aria-label', 'Dismiss');
      btn.textContent = '\u00d7';
      btn.addEventListener('click', () => {
        state.leadStatusCountsError = false;
        notice.remove();
      });
      notice.append(msg, btn);
      const lsRow = document.getElementById('lead-status-filter-row');
      (lsRow || sel).insertAdjacentElement('afterend', notice);
    }
  } else if (existingErrorNotice) {
    existingErrorNotice.remove();
  }
}

// ── Filters ───────────────────────────────────────────────────────────────────
function applySearchFilter(contacts) {
  const q = (state.searchQuery || '').toLowerCase();
  return q
    ? contacts.filter(c =>
        contactName(c).toLowerCase().includes(q) ||
        (c.properties?.email || '').toLowerCase().includes(q))
    : [...contacts];
}

let _customersReloader = null;
function registerCustomersReloader(fn) { _customersReloader = fn; }

function _filterDealsImpl(query) {
  state.searchQuery = query || '';
  if (state.contactsViewMode === 'all' && _customersReloader) {
    _customersReloader();
  } else {
    state.filteredContacts = applySearchFilter(state.contacts);
    state.currentPage = 1;
    renderCustomerList();
  }
}

function setStageFilter(value) {
  state.stageFilter = value;
  state.currentPage = 1;
  renderCustomerList();
}

function setLeadStatusFilter(value) {
  state.leadStatusFilter = value;
  state.currentPage = 1;
  renderCustomerList();
}

function setSortBy(value) {
  state.sortBy = value;
  state.currentPage = 1;
  renderCustomerList();
}

function toggleArchived() {
  state.showArchived = !state.showArchived;
  const btn = document.getElementById('archived-toggle');
  if (btn) btn.classList.toggle('filter-btn-active', state.showArchived);
  renderCustomerList();
}

// ── Bottom action bar ─────────────────────────────────────────────────────────
// Card-list operations: save immediately, undo reverts with a second save
let _bottomAction = null;
let _bottomTimer  = null;

// Workflow view: save is deferred until the undo bar expires
let _deferredSave     = null; // { timerId }
let _deferredSnapshot = null; // deep copy of allRooms BEFORE latest change

// Monotonic sequence number for contact re-fetches triggered after a save.
// When the user navigates rapidly between contacts, multiple re-fetches can be
// in flight concurrently; we only apply the result of the most recent one so a
// late-arriving stale response can't overwrite the badge.
let _contactRefetchSeq = 0;

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
    _updateBeforeUnloadGuard();
    const cid = state.selectedContactId;
    try {
      await saveWorkflowData();
      document.dispatchEvent(new CustomEvent('localdata-updated', { detail: { contactId: cid } }));
      // Re-fetch the contact so the list badge reflects the latest server state
      // after the flush (mirrors the same pattern in scheduleSave / Task 215).
      if (cid) {
        const mySeq = ++_contactRefetchSeq;
        const freshContact = await GET(`/api/contacts/${cid}`).catch(() => null);
        // Drop the response if a newer re-fetch has been started in the meantime
        // (e.g. user clicked through to another contact while this was in flight).
        if (freshContact && mySeq === _contactRefetchSeq) {
          _mergeContactIntoState(freshContact);
          renderCustomerList();
        }
      }
    } catch (e) {
      if (e.code === 'HUBSPOT_AUTH') {
        showToast('Could not save — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
      } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
        showToast('Could not save — HubSpot rate limit reached. Please try again in a moment.', true);
      } else {
        showToast('Failed to save', true);
      }
    }
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
    _updateBeforeUnloadGuard();
    try {
      await saveWorkflowData();
      document.dispatchEvent(new CustomEvent('localdata-updated', { detail: { contactId: state.selectedContactId } }));
      // Re-fetch the contact so the list reflects the latest server state
      // (e.g. HubSpot last-activity timestamp after the PATCH).  Route through
      // _mergeContactIntoState so any in-flight optimistic lead-status change
      // on the badge is preserved rather than overwritten by the fresh value.
      const cid = state.selectedContactId;
      if (cid) {
        const mySeq = ++_contactRefetchSeq;
        const freshContact = await GET(`/api/contacts/${cid}`).catch(() => null);
        // Drop the response if a newer re-fetch has been started in the meantime.
        if (freshContact && mySeq === _contactRefetchSeq) {
          _mergeContactIntoState(freshContact);
          renderCustomerList();
        }
      }
    } catch (e) {
      if (e.code === 'HUBSPOT_AUTH') {
        showToast('Could not save — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
      } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
        showToast('Could not save — HubSpot rate limit reached. Please try again in a moment.', true);
      } else {
        showToast('Failed to save', true);
      }
    }
  }, 5000);
  _deferredSave = { timerId };
  _updateBeforeUnloadGuard();

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
  _updateBeforeUnloadGuard();
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

// ── Unsaved-changes guard ─────────────────────────────────────────────────────

// Browser-tab close / refresh guard — fires the built-in "Leave site?" dialog
// whenever there is a pending deferred save or an unsaved comment draft.
function _beforeUnloadHandler(e) {
  if (hasUnsavedChanges()) {
    e.preventDefault();
    e.returnValue = '';
  }
}

let _beforeUnloadAttached = false;

function _updateBeforeUnloadGuard() {
  if (hasUnsavedChanges()) {
    if (!_beforeUnloadAttached) {
      window.addEventListener('beforeunload', _beforeUnloadHandler);
      _beforeUnloadAttached = true;
    }
  } else {
    if (_beforeUnloadAttached) {
      window.removeEventListener('beforeunload', _beforeUnloadHandler);
      _beforeUnloadAttached = false;
    }
  }
}

function hasUnsavedChanges() {
  if (_deferredSave) return true;
  const commentArea  = document.getElementById('comment-input-area');
  const commentInput = document.getElementById('comment-input');
  if (commentArea && !commentArea.classList.contains('hidden') &&
      commentInput && commentInput.value.trim()) return true;
  if (hasActiveInlineEdit()) return true;
  return false;
}

// Returns true when a known inline form is open (with or without content).
// Uses DOM-presence checks rather than document.activeElement because focus
// has already shifted to the clicked element (room tab, back button, etc.)
// by the time click handlers run, making activeElement unreliable here.
// The "Add room" and "Add task" elements are only rendered while their
// respective state flags are true, so element presence == form open.
function hasActiveInlineEdit() {
  // "Add room" form — present in DOM only while state.addingRoom is true
  if (document.getElementById('new-room-name') !== null) return true;
  // "Add task" form — present in DOM only while state.showAddTask is true
  if (document.getElementById('task-subject') !== null) return true;
  if (window._invMemoDirty) return true;
  if (window._invSendDirty) return true;
  return false;
}

function discardPendingSave() {
  if (_deferredSave) {
    clearTimeout(_deferredSave.timerId);
    _deferredSave    = null;
    _deferredSnapshot = null;
  }
  _updateBeforeUnloadGuard();
}

function _clearCommentDraft() {
  const area  = document.getElementById('comment-input-area');
  const input = document.getElementById('comment-input');
  if (area)  area.classList.add('hidden');
  if (input) input.value = '';
  _updateBeforeUnloadGuard();
}

function showUnsavedChangesBar(onSave, onDiscard) {
  closeBottomBar();
  const el = document.createElement('div');
  el.id = 'bottom-bar';
  el.className = 'bottom-bar';
  el.innerHTML = `
    <span class="bottom-bar-msg">You have unsaved changes</span>
    <div class="bottom-bar-btns">
      <button class="bottom-bar-cancel" id="unsaved-discard-btn">Discard</button>
      <button class="bottom-bar-confirm" id="unsaved-save-btn">Save &amp; leave</button>
    </div>
  `;
  document.body.appendChild(el);
  document.getElementById('unsaved-save-btn').addEventListener('click', async () => {
    closeBottomBar();
    await onSave();
  });
  document.getElementById('unsaved-discard-btn').addEventListener('click', async () => {
    closeBottomBar();
    await onDiscard();
  });
}

// ── Lead-status drift detection on tab focus ───────────────────────────────────
// When the browser tab becomes visible again, re-fetch hs_lead_status for the
// currently selected contact and a bounded slice of the visible contact list.
// If HubSpot changed a lead status while the user was away, update the UI and
// show a drift toast for the selected contact. No polling while tab is hidden.

const _DRIFT_LIST_LIMIT = 9;  // extra contacts to check beyond the selected one
let _driftCheckInFlight  = false;

async function _checkLeadStatusDrift() {
  if (_driftCheckInFlight) return;
  if (document.visibilityState !== 'visible') return;
  // Only run on pages that have contacts loaded
  if (!state.contacts || !state.contacts.length) return;

  _driftCheckInFlight = true;
  try {
    // Build the list of IDs to check: selected contact first, then up to
    // _DRIFT_LIST_LIMIT more from the current filtered/visible list.
    const toCheck = [];
    if (state.selectedContactId) toCheck.push(state.selectedContactId);
    for (const c of (state.filteredContacts || state.contacts)) {
      if (toCheck.length >= _DRIFT_LIST_LIMIT + 1) break;
      if (c.id !== state.selectedContactId) toCheck.push(c.id);
    }
    if (!toCheck.length) return;

    // Fetch all contacts in parallel; ignore individual failures.
    const results = await Promise.all(
      toCheck.map(id => GET(`/api/contacts/${id}`).catch(() => null))
    );

    let anyChanged = false;
    let selectedOldStatus = '';
    let selectedNewStatus = '';
    let selectedContactDrifted = false;

    for (const fresh of results) {
      if (!fresh || !fresh.id) continue;
      // Don't clobber an in-flight optimistic lead-status change.
      if (state.pendingLeadStatus &&
          Object.prototype.hasOwnProperty.call(state.pendingLeadStatus, fresh.id)) continue;

      const existing       = state.contacts.find(c => c.id === fresh.id);
      const existingStatus = existing?.properties?.hs_lead_status || '';
      const freshStatus    = fresh.properties?.hs_lead_status    || '';

      if (existingStatus !== freshStatus) {
        if (fresh.id === state.selectedContactId) {
          selectedContactDrifted = true;
          selectedOldStatus      = existingStatus;
          selectedNewStatus      = freshStatus;
        }
        // Update state.contacts (and state.selectedContact if selected).
        _mergeContactIntoState(fresh);
        // Also sync the same entry in state.filteredContacts so renderCustomerList
        // sees the updated status — _mergeContactIntoState only touches state.contacts.
        if (state.filteredContacts) {
          const fi = state.filteredContacts.findIndex(c => c.id === fresh.id);
          if (fi !== -1) state.filteredContacts[fi] = state.contacts.find(c => c.id === fresh.id) || state.filteredContacts[fi];
        }
        anyChanged = true;
      }
    }

    if (anyChanged) {
      renderCustomerList();
    }

    if (selectedContactDrifted) {
      // Re-render the selected-contact header so the lead-status badge updates
      // immediately on whichever page this runs (sales, projects, detail view).
      renderWorkflowHeader();
      const oldLabel = LEAD_STATUS_OPTIONS.find(o => o.value === selectedOldStatus)?.label
                    || selectedOldStatus || 'None';
      const newLabel = LEAD_STATUS_OPTIONS.find(o => o.value === selectedNewStatus)?.label
                    || selectedNewStatus || 'None';
      showToast(`Lead status updated in HubSpot: ${oldLabel} → ${newLabel}`, false);
    }
  } finally {
    _driftCheckInFlight = false;
  }
}

// Wire up once: fire on tab-visibility restore and on window focus.
// Guard against double-registration if this script is somehow re-evaluated.
if (!window._leadDriftListenersAttached) {
  window._leadDriftListenersAttached = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _checkLeadStatusDrift();
  });
  window.addEventListener('focus', _checkLeadStatusDrift);
}

// ── Register implementations with core.js dispatchers ─────────────────────────
registerWorkflowLoader(_loadWorkflowImpl);
registerOpenLeadsLoader(_loadOpenLeadsImpl);
registerWorkflowStagesLoader(_loadWorkflowStagesImpl);
registerStageFilterPopulator(_populateStageFilterImpl);
registerDealsFilter(_filterDealsImpl);

// ── Card picker cluster ────────────────────────────────────────────────────────
// Lead-status and substage pickers used by the React Sales and Survey boards.
// Extracted here from workflow.js so pages that no longer load workflow.js
// (sales.html, survey.html) still have these interactive handlers available.
// Pages that DO load workflow.js (projects, customer-detail) will redefine
// these functions from workflow.js — same code, so behaviour is identical.

function closeCardPicker() {
  document.getElementById('card-picker-popup')?.remove();
  document.removeEventListener('click', closeCardPicker);
}

async function openLeadStatusPicker(event, contactId, { showSubstatuses = false } = {}) {
  event.stopPropagation();
  { if (!canEditPrivilege()) return; }
  closeCardPicker();
  const rect = event.currentTarget.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.id = 'card-picker-popup';
  popup.className = 'card-picker-popup';
  const top = Math.min(rect.bottom + 4, window.innerHeight - 300);
  popup.style.cssText = `top:${top}px;left:${Math.max(4, rect.left)}px;`;

  const stalePrevStatus = state.contacts.find(c => c.id === contactId)?.properties?.hs_lead_status || '';

  const loadingEl = document.createElement('div');
  loadingEl.style.cssText = 'padding:12px 16px;color:#64748b;font-size:13px;';
  loadingEl.textContent = 'Loading current status\u2026';
  popup.appendChild(loadingEl);
  document.body.appendChild(popup);

  let currentLeadStatus = stalePrevStatus;
  let driftedTo = null;
  try {
    const fresh = await GET(`/api/contacts/${contactId}`);
    const freshStatus = fresh?.properties?.hs_lead_status || '';
    const pending = state.pendingLeadStatus && Object.prototype.hasOwnProperty.call(state.pendingLeadStatus, contactId);
    if (!pending) {
      if (freshStatus !== stalePrevStatus) driftedTo = freshStatus;
      currentLeadStatus = freshStatus;
      _mergeContactIntoState(fresh);
      populateLeadStatusFilter();
      renderCustomerList();
      renderWorkflowHeader();
    }
  } catch (e) {
    showToast('Could not refresh lead status from HubSpot \u2014 showing last known value.', true);
  }

  if (!document.body.contains(popup)) {
    if (driftedTo !== null) {
      const _nullLbl = NULL_LEAD_STATUS_LABEL || 'No status';
      const newLabel = driftedTo ? (LEAD_STATUS_OPTIONS.find(o => o.value === driftedTo)?.label || driftedTo) : _nullLbl;
      showToast(`Lead status was updated in HubSpot to ${newLabel}`);
    }
    return;
  }

  popup.innerHTML = '';
  const clearBtn = document.createElement('button');
  clearBtn.className = 'card-picker-opt card-picker-opt--clear' + (currentLeadStatus ? '' : ' card-picker-opt--disabled');
  clearBtn.textContent = '\u2715 Clear status';
  if (currentLeadStatus) {
    clearBtn.addEventListener('click', () => quickSetLeadStatus(contactId, ''));
  } else {
    clearBtn.disabled = true;
  }
  popup.appendChild(clearBtn);

  let _pickerContact = null;
  let currentSub = null;
  if (showSubstatuses) {
    _pickerContact = state.contacts.find(c => c.id === contactId);
    if (!_pickerContact && state.selectedContact?.id === contactId) _pickerContact = state.selectedContact;
    currentSub = _currentSubstatusFor(_pickerContact);
  }

  LEAD_STATUS_OPTIONS.forEach(({ value, label }) => {
    const parentIsActive = showSubstatuses
      ? (value === currentLeadStatus && !currentSub)
      : (value === currentLeadStatus);
    const btn = document.createElement('button');
    btn.className = 'card-picker-opt' + (parentIsActive ? ' card-picker-opt--active' : '');
    btn.dataset.leadStatus = value;
    btn.textContent = label;
    btn.addEventListener('click', () => quickSetLeadStatus(contactId, value));
    popup.appendChild(btn);

    if (showSubstatuses) {
      const subs = _substatusesForStatus(value);
      subs.forEach(sub => {
        const subBtn = document.createElement('button');
        const subIsActive = value === currentLeadStatus && currentSub && currentSub.key === sub.substatus_key;
        subBtn.className = 'card-picker-opt card-picker-opt--sub' + (subIsActive ? ' card-picker-opt--active' : '');
        subBtn.textContent = sub.label || sub.substatus_key;
        subBtn.addEventListener('click', () => _quickSetLeadStatusWithSub(contactId, value, sub.substatus_key));
        popup.appendChild(subBtn);
      });
    }
  });
  setTimeout(() => document.addEventListener('click', closeCardPicker, { once: true }), 0);

  if (driftedTo !== null) {
    const _nullLbl2 = NULL_LEAD_STATUS_LABEL || 'No status';
    const newLabel = driftedTo ? (LEAD_STATUS_OPTIONS.find(o => o.value === driftedTo)?.label || driftedTo) : _nullLbl2;
    showToast(`Lead status was updated in HubSpot to ${newLabel}`);
  }
}

async function _fetchLocaldataForCard(contactId) {
  try {
    const data = await GET(`/api/contacts/${encodeURIComponent(contactId)}/localdata`);
    return data || { rooms: [], notes: '' };
  } catch {
    return null;
  }
}

function _lastCompletedSubstageLabel(workflow, stageKey, doneIds) {
  const stage = workflow?.stages?.[stageKey];
  const statuses = stage?.statuses || [];
  const last = [...statuses].reverse().find(s => doneIds.includes(s.id));
  return last?.label || '';
}

async function _saveCardRoomMutation(contactId, mutateRoom) {
  const data = await _fetchLocaldataForCard(contactId);
  if (!data) { showToast('Could not load customer data', true); return false; }
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  const notes = data.notes || '';
  if (!rooms.length) { showToast('No room found to edit', true); return false; }

  const ok = mutateRoom(rooms);
  if (!ok) return false;

  const primary = rooms[0] || {};
  const stageKey = primary.stageKey || 'sales';
  const stageLabel = state.workflow?.stages?.[stageKey]?.label || stageKey;
  const doneIds = primary.completedStatuses?.[stageKey] || [];
  const substageLabel = _lastCompletedSubstageLabel(state.workflow, stageKey, doneIds);

  try {
    await POST(`/api/contacts/${encodeURIComponent(contactId)}/localdata`, {
      rooms, notes, stage: stageLabel, substage: substageLabel,
    });
  } catch (e) {
    if (e.code === 'PIPELINE_EDIT_FORBIDDEN') {
      showToast('Manager or admin privilege required to change pipeline state.', true);
    } else if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not save \u2014 HubSpot token is invalid or expired.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not save \u2014 HubSpot rate limit reached. Try again in a moment.', true);
    } else {
      showToast('Failed to save change', true);
    }
    return false;
  }
  document.dispatchEvent(new CustomEvent('localdata-updated'));
  return true;
}

async function openCardStagePicker(_event, _contactId, _roomIdx) {
  closeCardPicker();
}

async function openCardSubstagePicker(event, contactId, roomIdx) {
  event.stopPropagation();
  { if (!canEditPrivilege()) return; }
  closeCardPicker();

  const cached = state.contactStageCache?.[contactId] || [];
  const room = cached[roomIdx] || {};
  const stageKey = room.stageKey || '';
  const stage = state.workflow?.stages?.[stageKey];
  if (!stage?.statuses?.length) {
    showToast('No substages available for this stage', true);
    return;
  }

  const rect = event.currentTarget.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.id = 'card-picker-popup';
  popup.className = 'card-picker-popup';
  const top = Math.min(rect.bottom + 4, window.innerHeight - 320);
  popup.style.cssText = `top:${top}px;left:${Math.max(4, rect.left)}px;`;

  const currentSubId = room.statusId || '';

  const clearBtn = document.createElement('button');
  clearBtn.className = 'card-picker-opt card-picker-opt--clear' + (currentSubId ? '' : ' card-picker-opt--disabled');
  clearBtn.textContent = '\u2715 Clear substage';
  if (currentSubId) {
    clearBtn.addEventListener('click', async () => {
      closeCardPicker();
      await _saveCardRoomMutation(contactId, rooms => {
        const r = rooms[roomIdx];
        if (!r) { showToast('Room no longer exists', true); return false; }
        r.statusId = '';
        if (r.completedStatuses) r.completedStatuses[stageKey] = [];
        return true;
      });
    });
  } else {
    clearBtn.disabled = true;
  }
  popup.appendChild(clearBtn);

  stage.statuses.forEach(s => {
    const btn = document.createElement('button');
    const isActive = s.id === currentSubId;
    btn.className = 'card-picker-opt' + (isActive ? ' card-picker-opt--active' : '');
    btn.textContent = s.label || s.id;
    btn.addEventListener('click', async () => {
      closeCardPicker();
      if (s.id === currentSubId) return;
      await _saveCardRoomMutation(contactId, rooms => {
        const r = rooms[roomIdx];
        if (!r) { showToast('Room no longer exists', true); return false; }
        const ids = (state.workflow?.stages?.[stageKey]?.statuses || []).map(x => x.id);
        const cutoff = ids.indexOf(s.id);
        const done = cutoff >= 0 ? ids.slice(0, cutoff + 1) : [s.id];
        r.completedStatuses = r.completedStatuses || {};
        r.completedStatuses[stageKey] = done;
        r.statusId = s.id;
        r.substateDates = r.substateDates || {};
        r.substateDates[s.id] = r.substateDates[s.id] || todayISO();
        return true;
      });
    });
    popup.appendChild(btn);
  });

  document.body.appendChild(popup);
  setTimeout(() => document.addEventListener('click', closeCardPicker, { once: true }), 0);
}

async function quickSetLeadStatus(contactId, newStatus) {
  closeCardPicker();
  let contact = state.contacts.find(c => c.id === contactId);
  if (!contact && state.selectedContact?.id === contactId) {
    contact = state.selectedContact;
  }
  const prevStatus    = contact?.properties?.hs_lead_status || null;
  const prevSubstatus = contact?.properties?.hw_lead_substatus || '';

  const subBelongsToPrev = (() => {
    if (!prevSubstatus || !prevStatus) return false;
    return String(prevSubstatus).toUpperCase()
      .startsWith(`${String(prevStatus).toUpperCase()}__`);
  })();
  const clearSub = subBelongsToPrev;

  if (prevStatus === newStatus && !clearSub) return;

  function _applyLeadStatus(status, substatus) {
    if (contact) {
      contact.properties = {
        ...(contact.properties || {}),
        hs_lead_status: status,
        ...(substatus !== undefined ? { hw_lead_substatus: substatus } : {}),
      };
    }
    if (state.selectedContact && state.selectedContact.id === contactId &&
        state.selectedContact !== contact) {
      state.selectedContact.properties = {
        ...(state.selectedContact.properties || {}),
        hs_lead_status: status,
        ...(substatus !== undefined ? { hw_lead_substatus: substatus } : {}),
      };
    }
    if (state.selectedContactId) {
      const fresh = state.contacts.find(c => c.id === state.selectedContactId);
      if (fresh) state.selectedContact = fresh;
    }
    state.pendingLeadStatus = state.pendingLeadStatus || {};
    state.pendingLeadStatus[contactId] = status;
    populateLeadStatusFilter();
    renderCustomerList();
    renderWorkflowHeader();
    renderWorkflowStages();
  }

  _applyLeadStatus(newStatus, clearSub ? '' : undefined);

  try {
    const patchBody = clearSub
      ? { hs_lead_status: newStatus, hw_lead_substatus: '' }
      : { hs_lead_status: newStatus };
    await PATCH_REQ(`/api/contacts/${contactId}`, patchBody);
    if (state.pendingLeadStatus) delete state.pendingLeadStatus[contactId];
    loadLeadStatusCounts().then(() => populateLeadStatusFilter()).catch(() => {});
    const _nullLbl3 = NULL_LEAD_STATUS_LABEL || 'No status';
    const newLabel = newStatus ? (LEAD_STATUS_OPTIONS.find(o => o.value === newStatus)?.label || newStatus) : null;
    showBottomUndo(newLabel ? `Lead status set to ${newLabel}` : `Lead status set to ${_nullLbl3}`, async () => {
      _applyLeadStatus(prevStatus || '', clearSub ? prevSubstatus : undefined);
      const undoBody = clearSub
        ? { hs_lead_status: prevStatus || '', hw_lead_substatus: prevSubstatus || '' }
        : { hs_lead_status: prevStatus || '' };
      await PATCH_REQ(`/api/contacts/${contactId}`, undoBody)
        .catch(() => {})
        .finally(() => {
          if (state.pendingLeadStatus) delete state.pendingLeadStatus[contactId];
          loadLeadStatusCounts().then(() => populateLeadStatusFilter()).catch(() => {});
        });
    });
  } catch (e) {
    _applyLeadStatus(prevStatus || '', clearSub ? prevSubstatus : undefined);
    if (state.pendingLeadStatus) delete state.pendingLeadStatus[contactId];
    if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not update lead status \u2014 HubSpot token is invalid or expired. Ask an admin to update the token.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not update lead status \u2014 HubSpot rate limit reached. Please try again in a moment.', true);
    } else if (e.code === 'HUBSPOT_VERIFY_FAILED') {
      showToast("Lead status didn\u2019t save in HubSpot \u2014 please try again.", true);
    } else {
      showToast('Failed to update lead status', true);
    }
  }
}

async function _quickSetLeadStatusWithSub(contactId, statusKey, substatusKey) {
  closeCardPicker();
  let contact = state.contacts.find(c => c.id === contactId);
  if (!contact && state.selectedContact?.id === contactId) contact = state.selectedContact;

  const prevStatus    = contact?.properties?.hs_lead_status    || '';
  const prevSubstatus = contact?.properties?.hw_lead_substatus || '';
  const newHw = `${String(statusKey).toUpperCase()}__${String(substatusKey).toUpperCase()}`;
  if (prevStatus === statusKey && prevSubstatus === newHw) return;

  function _apply(status, hw) {
    if (contact) {
      contact.properties = { ...(contact.properties || {}), hs_lead_status: status, hw_lead_substatus: hw };
    }
    if (state.selectedContact && state.selectedContact.id === contactId &&
        state.selectedContact !== contact) {
      state.selectedContact.properties = {
        ...(state.selectedContact.properties || {}),
        hs_lead_status: status,
        hw_lead_substatus: hw,
      };
    }
    if (state.selectedContactId) {
      const fresh = state.contacts.find(c => c.id === state.selectedContactId);
      if (fresh) state.selectedContact = fresh;
    }
    state.pendingLeadStatus = state.pendingLeadStatus || {};
    state.pendingLeadStatus[contactId] = status;
    populateLeadStatusFilter();
    renderCustomerList();
    renderWorkflowHeader();
    renderWorkflowStages();
  }

  _apply(statusKey, newHw);

  try {
    await PATCH_REQ(`/api/contacts/${contactId}`, { hs_lead_status: statusKey, hw_lead_substatus: newHw });
    if (state.pendingLeadStatus) delete state.pendingLeadStatus[contactId];
    loadLeadStatusCounts().then(() => populateLeadStatusFilter()).catch(() => {});
    const subs = _substatusesForStatus(statusKey);
    const subLabel = subs.find(s =>
      String(s.substatus_key).toUpperCase() === String(substatusKey).toUpperCase()
    )?.label || substatusKey;
    showBottomUndo(`Sub-status set to ${subLabel}`, async () => {
      _apply(prevStatus, prevSubstatus);
      await PATCH_REQ(`/api/contacts/${contactId}`, {
        hs_lead_status: prevStatus || '',
        hw_lead_substatus: prevSubstatus || '',
      }).catch(() => {}).finally(() => {
        if (state.pendingLeadStatus) delete state.pendingLeadStatus[contactId];
        loadLeadStatusCounts().then(() => populateLeadStatusFilter()).catch(() => {});
      });
    });
  } catch (e) {
    _apply(prevStatus, prevSubstatus);
    if (state.pendingLeadStatus) delete state.pendingLeadStatus[contactId];
    if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not update lead status \u2014 HubSpot token is invalid or expired. Ask an admin to update the token.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not update lead status \u2014 HubSpot rate limit reached. Please try again in a moment.', true);
    } else if (e.code === 'HUBSPOT_VERIFY_FAILED') {
      showToast("Lead status didn\u2019t save in HubSpot \u2014 please try again.", true);
    } else {
      showToast('Failed to update lead status', true);
    }
  }
}

function _substatusesForStatus(statusKey) {
  if (!statusKey) return [];
  if (typeof LEAD_SUBSTATUSES === 'undefined' || !Array.isArray(LEAD_SUBSTATUSES)) return [];
  const sk = String(statusKey).toUpperCase();
  return LEAD_SUBSTATUSES
    .filter(s => String(s.status_key).toUpperCase() === sk)
    .slice()
    .sort((a, b) =>
      (a.sort_order || 0) - (b.sort_order || 0) ||
      String(a.substatus_key).localeCompare(String(b.substatus_key))
    );
}

function _currentSubstatusFor(contact) {
  const statusKey = contact?.properties?.hs_lead_status || '';
  const hwVal     = contact?.properties?.hw_lead_substatus || '';
  if (!statusKey || !hwVal) return null;
  const sk = String(statusKey).toUpperCase();
  const v  = String(hwVal).toUpperCase();
  const prefix = `${sk}__`;
  if (!v.startsWith(prefix)) return null;
  const subKey = v.slice(prefix.length);
  const row = _substatusesForStatus(statusKey)
    .find(s => String(s.substatus_key).toUpperCase() === subKey);
  return row ? { key: row.substatus_key, label: row.label || row.substatus_key } : null;
}
