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
//     is used across workflow.js / customer-detail.js to order
//     and compare stages.
//   - A `label` per stage so labels rendered from state.workflow.stages[k].label
//     don't fall through to the raw key on cold-start.
//
// The per-stage `statuses` arrays that used to live here drove the legacy
// stage-and-sub-task tracker on the customer page. That tracker has been
// replaced by the admin-configured lead-status tracker (task #597), so the
// hardcoded sub-tasks were just drifting from the live admin data — they are
// intentionally omitted here. Runtime code that still touches
// state.workflow.stages[k].statuses (e.g. sales / survey cards, workflow.js)
// reads the live array loaded from workflow.json and
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
      _renderOpenLeadsStaleBadge();
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
  document.dispatchEvent(new CustomEvent('survey-board-cache-status', { detail: { stale: detectedStale } }));
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

// Visibility-gated stale-banner state for the room assignments panel.
// When /api/localdata/all returns X-Cache-Status: stale or fresh while the tab
// is hidden we defer the banner update so the user sees it only when they look
// at the tab again (matches the contacts-page pattern).  null = no pending update.
// A test hook (window.__setTestPendingRoomStale) lets integration tests drive
// the pending ref directly without a network round-trip.
let _pendingRoomAssignmentsStale = null;
window.__setTestPendingRoomStale = (v) => { _pendingRoomAssignmentsStale = v; };
// Tracks whether the user dismissed the banner this session.  Reset when fresh
// data arrives so the banner can reappear if the data becomes stale again.
let _roomStaleBannerDismissed = false;

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
      _renderRoomAssignmentsStaleBanner();
    }
  }
  for (const [contactId, rooms] of Object.entries(data || {})) {
    state.contactStageCache[contactId] = rooms;
  }
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
// visibilitychange + BroadcastChannel listeners) collapse into one HubSpot
// fan-out. Server-side caching alone
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

// ── Pill-bar counts-error notice ──────────────────────────────────────────────
// Renders (or removes) the #ls-counts-error-notice-pills element inside
// #customers-view whenever mo:contacts-changed fires.  The notice appears when
// state.leadStatusCountsError is true and disappears once the flag is cleared
// (either by the dismiss button or by a subsequent successful
// loadLeadStatusCounts call).  The element is inserted just before
// #customers-view so it sits above the card list without disrupting layout.
function _renderCountsErrorNoticePills() {
  const existing = document.getElementById('ls-counts-error-notice-pills');
  if (!state.leadStatusCountsError) {
    if (existing) existing.remove();
    return;
  }
  const view = document.getElementById('customers-view');
  if (!view) return; // no pill-bar target on this page
  if (existing) return; // already shown — avoid duplicates
  const notice = document.createElement('div');
  notice.id = 'ls-counts-error-notice-pills';
  notice.className = 'ls-counts-error-notice';
  const span = document.createElement('span');
  span.textContent = 'Could not load lead status counts \u2014 some totals may be out of date.';
  const btn = document.createElement('button');
  btn.className = 'ls-counts-error-dismiss';
  btn.textContent = '\u00d7';
  btn.setAttribute('onclick',
    "state.leadStatusCountsError=false;document.getElementById('ls-counts-error-notice-pills')?.remove()");
  notice.appendChild(span);
  notice.appendChild(btn);
  view.insertAdjacentElement('beforebegin', notice);
}
document.addEventListener('mo:contacts-changed', _renderCountsErrorNoticePills);

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
      window.LEAD_STATUS_OPTIONS = LEAD_STATUS_OPTIONS;
      LEAD_STATUSES_LOADED = true;
    }
  } catch (e) {
    console.warn('Could not load lead statuses from server, using defaults:', e.message);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Apply any deferred room-stale-banner update from a fetch that arrived
  // while the tab was hidden, then render the banner.
  if (_pendingRoomAssignmentsStale !== null) {
    state.roomAssignmentsStale = _pendingRoomAssignmentsStale;
    _pendingRoomAssignmentsStale = null;
    _renderRoomAssignmentsStaleBanner();
  }
  // Apply any deferred open-leads stale-badge update and re-render.
  if (_pendingOpenLeadsStale !== null) {
    state.openLeadsStale = _pendingOpenLeadsStale;
    _pendingOpenLeadsStale = null;
    _renderOpenLeadsStaleBadge();
  }
  Promise.all([loadLeadStatuses(), loadLeadStatusCounts(), loadLeadSubstatuses()]).then(() => {
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
      renderCustomerList();
      if (typeof renderEnquiryList === 'function') renderEnquiryList();
      _maybeRenderStages();
    });
  });

  const _sacChannel = new BroadcastChannel('stage_action_labels_changed');
  _sacChannel.addEventListener('message', () => {
    loadStageActionLabels().then(() => {
      document.dispatchEvent(new CustomEvent('mo:contacts-changed'));
      if (typeof renderEnquiryList === 'function') renderEnquiryList();
      if (typeof renderSurveyList  === 'function') renderSurveyList();
      _maybeRenderStages();
    });
  });

  const _subChannel = new BroadcastChannel('lead_substatuses_changed');
  _subChannel.addEventListener('message', () => {
    loadLeadSubstatuses().then(() => {
      document.dispatchEvent(new CustomEvent('mo:contacts-changed'));
      if (typeof renderEnquiryList === 'function') renderEnquiryList();
      if (typeof renderSurveyList  === 'function') renderSurveyList();
      renderWorkflowHeader();
      _maybeRenderStages();
    });
  });
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

function _filterDealsImpl(query) {
  state.searchQuery = query || '';
  state.filteredContacts = applySearchFilter(state.contacts);
  state.currentPage = 1;
  document.dispatchEvent(new CustomEvent('mo:contacts-changed'));
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

function _clearCommentDraft() {
  const area  = document.getElementById('comment-input-area');
  const input = document.getElementById('comment-input');
  if (area)  area.classList.add('hidden');
  if (input) input.value = '';
  _updateBeforeUnloadGuard();
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
        // Also sync the same entry in state.filteredContacts so the board re-render
        // sees the updated status — _mergeContactIntoState only touches state.contacts.
        if (state.filteredContacts) {
          const fi = state.filteredContacts.findIndex(c => c.id === fresh.id);
          if (fi !== -1) state.filteredContacts[fi] = state.contacts.find(c => c.id === fresh.id) || state.filteredContacts[fi];
        }
        anyChanged = true;
      }
    }

    if (anyChanged) {
      document.dispatchEvent(new CustomEvent('mo:contacts-changed'));
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

// ── Room-assignments stale banner ──────────────────────────────────────────────
// Lightweight DOM renderer for the room-assignments stale indicator, shown as a
// fixed bottom banner on all pages that load workflow-core.js.  Created and
// removed dynamically so no per-page HTML markup is required (mirrors the
// open-leads badge pattern).
function _renderRoomAssignmentsStaleBanner() {
  const BANNER_ID = 'room-stale-banner';
  const existing = document.getElementById(BANNER_ID);
  if (state.roomAssignmentsStale && !_roomStaleBannerDismissed) {
    if (!existing) {
      const el = document.createElement('div');
      el.id = BANNER_ID;
      el.className = 'room-stale-banner';
      el.setAttribute('role', 'alert');
      const span = document.createElement('span');
      span.textContent = 'Room data may be out of date \u2014 showing last cached assignments';
      const btn = document.createElement('button');
      btn.className = 'room-stale-banner-dismiss';
      btn.setAttribute('aria-label', 'dismiss stale banner');
      btn.textContent = '\u00d7';
      btn.addEventListener('click', () => {
        _roomStaleBannerDismissed = true;
        el.remove();
      });
      el.appendChild(span);
      el.appendChild(btn);
      document.body.appendChild(el);
    }
  } else {
    // Reset the dismissed flag when data is fresh so the banner can reappear
    // if the data becomes stale again in a future fetch.
    if (!state.roomAssignmentsStale) _roomStaleBannerDismissed = false;
    if (existing) existing.remove();
  }
}

// ── Open-leads stale badge ─────────────────────────────────────────────────────
// Lightweight DOM renderer for the open-leads stale indicator, shown as a
// fixed bottom banner on all pages that load workflow-core.js (customers,
// sales, survey, customer-detail, etc.).  Registered as the
// renderWorkflowStages implementation so existing call sites continue to work.
function _renderOpenLeadsStaleBadge() {
  const BADGE_ID = 'open-leads-stale-hint';
  const existing = document.getElementById(BADGE_ID);
  if (state.openLeadsStale) {
    if (!existing) {
      const el = document.createElement('div');
      el.id = BADGE_ID;
      el.className = 'ls-stale-hint';
      el.innerHTML = '<span>\u26a0\ufe0f Lead data may be slightly out of date \u2014 refresh to update.</span>';
      document.body.appendChild(el);
    }
  } else {
    if (existing) existing.remove();
  }
}

// ── Register implementations with core.js dispatchers ─────────────────────────
registerWorkflowLoader(_loadWorkflowImpl);
registerOpenLeadsLoader(_loadOpenLeadsImpl);
registerWorkflowStagesLoader(_loadWorkflowStagesImpl);
registerWorkflowStagesRenderer(_renderOpenLeadsStaleBadge);
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

// openLeadStatusPicker — replaced by the React LeadStatusPicker component in
// src/react/components/pickers/LeadStatusPicker.tsx (task #1364).
// Kept as a no-op shim so any remaining vanilla-JS call sites degrade gracefully.
function openLeadStatusPicker(_event, _contactId, _opts) {
  // No-op: picker is now rendered by React.
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

// openCardStagePicker — was already a no-op stub; kept as a no-op shim.
function openCardStagePicker(_event, _contactId, _roomIdx) {
  closeCardPicker();
}

// openCardSubstagePicker — replaced by the React SubstagePicker component in
// src/react/components/pickers/SubstagePicker.tsx (task #1364).
// Kept as a no-op shim so any remaining vanilla-JS call sites degrade gracefully.
function openCardSubstagePicker(_event, _contactId, _roomIdx) {
  // No-op: picker is now rendered by React.
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
    loadLeadStatusCounts().catch(() => {});
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
          loadLeadStatusCounts().catch(() => {});
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
    renderCustomerList();
    renderWorkflowHeader();
    renderWorkflowStages();
  }

  _apply(statusKey, newHw);

  try {
    await PATCH_REQ(`/api/contacts/${contactId}`, { hs_lead_status: statusKey, hw_lead_substatus: newHw });
    if (state.pendingLeadStatus) delete state.pendingLeadStatus[contactId];
    loadLeadStatusCounts().catch(() => {});
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
        loadLeadStatusCounts().catch(() => {});
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
