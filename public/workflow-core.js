// Workflow definition, stage colours, workflow/leads data loaders,
// list filters, and the undo bottom bar.
// Loaded only on pages that show workflow data (sales, projects).

// ── Workflow Definition ────────────────────────────────────────────────────────
const DEFAULT_WORKFLOW = {
  stages: {
    sales: {
      label: 'Sales',
      statuses: [
        {
          id: 'form_submission', label: 'Form submission',
          hint: 'Email + WhatsApp customer asking for more information',
          subStatuses: [
            { id: 'website',   label: 'Website contact received' },
            { id: 'whatsapp',  label: 'WhatsApp message received' },
            { id: 'call',      label: 'Call received' },
            { id: 'instagram', label: 'Instagram message received' },
            { id: 'facebook',  label: 'Facebook message received' },
            { id: 'email',     label: 'Email received' },
          ]
        },
        {
          id: 'attempted_contact', label: 'Attempted to contact',
          hint: 'If no response in 2 working days, call to discuss',
          subStatuses: [
            { id: 'email_sent',       label: 'Email sent' },
            { id: 'whatsapp_sent',    label: 'WhatsApp sent' },
            { id: 'called_customer',  label: 'Called customer' },
            { id: 'no_response',      label: 'No response' },
          ]
        },
        { id: 'in_progress',    label: 'In progress',    hint: '' },
        { id: 'awaiting_photos', label: 'Awaiting photos', hint: '' },
        { id: 'rough_estimate', label: 'Rough estimate',  hint: 'Data collected: rough dimensions, photos, ideas, price range' },
        { id: 'unqualified',    label: 'Unqualified',     hint: '',                                               terminal: true },
        { id: 'not_suitable',   label: 'Not suitable',    hint: '',                                               terminal: true },
        { id: 'bad_timing',     label: 'Bad timing',      hint: 'Get back in touch in 1 month, or suggested date', terminal: true },
        { id: 'no_response_x3', label: 'No response ×3',  hint: 'Mark as cold lead, archive after 4 weeks',       terminal: true },
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

async function _loadOpenLeadsImpl() {
  const data = await GET('/api/open-leads');
  state.contacts = data.results || [];
  _reapplyPendingLeadStatuses();
  state.filteredContacts = [...state.contacts];
}

async function loadAllContacts() {
  const data = await GET('/api/contacts-all');
  state.contacts = data.results || [];
  _reapplyPendingLeadStatuses();
  state.filteredContacts = [...state.contacts];
  try { sessionStorage.setItem('contacts_all_cache', JSON.stringify(state.contacts)); } catch {}
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

async function _loadWorkflowStagesImpl() {
  const data = await GET('/api/localdata/all').catch(() => ({}));
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

async function loadLeadStatuses() {
  try {
    const rows = await GET('/api/lead-statuses');
    if (Array.isArray(rows) && rows.length > 0) {
      LEAD_STATUS_OPTIONS = rows.map(r => ({
        value:               r.key,
        label:               r.label,
        excluded_from_sales: !!r.excluded_from_sales,
      }));
    }
  } catch (e) {
    console.warn('Could not load lead statuses from server, using defaults:', e.message);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  loadLeadStatuses().then(() => {
    if (typeof populateLeadStatusFilter === 'function') populateLeadStatusFilter();
    if (typeof renderCustomerList === 'function') renderCustomerList();
  });
});

// ── Cross-tab lead-status refresh ─────────────────────────────────────────────
// When the admin settings panel saves a lead-status change in another tab,
// it broadcasts on this channel so open contact lists can re-render immediately
// without requiring the user to leave and return to the tab.
if (typeof BroadcastChannel !== 'undefined') {
  const _lsChannel = new BroadcastChannel('lead_statuses_changed');
  _lsChannel.addEventListener('message', () => {
    loadLeadStatuses().then(() => {
      if (typeof populateLeadStatusFilter === 'function') populateLeadStatusFilter();
      if (typeof renderCustomerList === 'function') renderCustomerList();
    });
  });
}

function populateLeadStatusFilter() {
  const sel = document.getElementById('lead-status-filter');
  if (!sel) return;

  const counts = {};
  for (const c of state.contacts) {
    const s = c.properties?.hs_lead_status || '';
    if (s) counts[s] = (counts[s] || 0) + 1;
  }

  const prevValue = sel.value;
  sel.innerHTML = `<option value="">All statuses</option>` +
    LEAD_STATUS_OPTIONS.map(({ value, label }) => {
      const n = counts[value] || 0;
      const attrs = n === 0 ? ' disabled style="color:#cbd5e1"' : '';
      return `<option value="${escHtml(value)}"${attrs}>${escHtml(label)} (${n})</option>`;
    }).join('');

  if (prevValue) sel.value = prevValue;
}

// ── Filters ───────────────────────────────────────────────────────────────────
function _filterDealsImpl(query) {
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

function setLeadStatusFilter(value) {
  state.leadStatusFilter = value;
  renderCustomerList();
}

function setSortBy(value) {
  state.sortBy = value;
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
  // Edit-contact modal with in-progress changes
  if (typeof isContactEditDirty === 'function' && isContactEditDirty()) return true;
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
