// Workflow definition, stage colours, workflow/leads data loaders,
// list filters, and the undo bottom bar.
// Loaded only on pages that show workflow data (sales, projects).

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

// Record the date a room first entered a stage — never overwrites an existing date.
function recordStageDate(room, stageKey) {
  if (!room.stageDates) room.stageDates = {};
  if (!room.stageDates[stageKey]) room.stageDates[stageKey] = todayISO();
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
    room: r.room, stageKey: r.stageKey, roomStatus: r.roomStatus || 'active',
    assignedFitterId: r.assignedFitterId || null
  }));
}

// ── Data loaders ──────────────────────────────────────────────────────────────
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

async function loadAllContacts() {
  const data = await GET('/api/contacts-all');
  state.contacts = data.results || [];
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

const LEAD_STATUS_OPTIONS = [
  { value: 'NEW',                  label: 'New' },
  { value: 'OPEN',                 label: 'Open' },
  { value: 'IN_PROGRESS',          label: 'In Progress' },
  { value: 'OPEN_DEAL',            label: 'Open Deal' },
  { value: 'CONNECTED',            label: 'Connected' },
  { value: 'ATTEMPTED_TO_CONTACT', label: 'Attempted to Contact' },
  { value: 'UNQUALIFIED',          label: 'Unqualified' },
  { value: 'BAD_TIMING',           label: 'Bad Timing' },
];

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

async function refreshDeals() {
  const loader = (state.contactsViewMode === 'all') ? loadAllContacts() : loadOpenLeads();
  await Promise.all([loader, loadWorkflowStages()]);
  if (state.contactsViewMode === 'all') populateLeadStatusFilter();
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

// ── Unsaved-changes guard ─────────────────────────────────────────────────────

function hasUnsavedChanges() {
  if (_deferredSave) return true;
  const commentArea  = document.getElementById('comment-input-area');
  const commentInput = document.getElementById('comment-input');
  if (commentArea && !commentArea.classList.contains('hidden') &&
      commentInput && commentInput.value.trim()) return true;
  return false;
}

function discardPendingSave() {
  if (_deferredSave) {
    clearTimeout(_deferredSave.timerId);
    _deferredSave    = null;
    _deferredSnapshot = null;
  }
}

function _clearCommentDraft() {
  const area  = document.getElementById('comment-input-area');
  const input = document.getElementById('comment-input');
  if (area)  area.classList.add('hidden');
  if (input) input.value = '';
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
