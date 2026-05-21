// ── Mobile Panel Navigation ───────────────────────────────────────────────────
function showWorkflowPanel() {
  document.body.classList.add('showing-workflow');
  const wp = document.getElementById('workflow-panel');
  if (wp) wp.scrollTop = 0;
}

function _performGoBack() {
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

// ── Inline-edit commit / discard helpers ─────────────────────────────────────
// These know about sales.js-specific forms (new-room-name, task-subject) so
// they live here rather than in workflow-core.js.

async function _commitActiveInlineEdit() {
  // Query by element ID so this works whether or not the field is focused.
  if (document.getElementById('new-room-name')?.value.trim()) {
    await submitAddRoom();
  }
  if (document.getElementById('task-subject')?.value.trim()) {
    await saveNewTask();
  }
  if (typeof isContactEditDirty === 'function' && isContactEditDirty()) {
    const ok = await submitContactEdit({ preventDefault(){} });
    // If the edit-contact form couldn't be saved (e.g. required field missing)
    // throw so the caller aborts navigation and the user can fix the form.
    if (!ok) throw new Error('Contact edit not saved');
  }
}

function _discardActiveInlineEdit() {
  // Hide whichever inline form(s) are currently open with content.
  if (document.getElementById('new-room-name')) {
    hideAddRoomForm();
  }
  if (document.getElementById('task-subject')) {
    state.showAddTask = false;
    renderTasks();
  }
  if (typeof isContactEditOpen === 'function' && isContactEditOpen()) {
    closeContactEdit();
  }
}

async function goBack() {
  captureNotes();
  if (typeof closeContactEditIfPristine === 'function') closeContactEditIfPristine();

  if (hasUnsavedChanges()) {
    showUnsavedChangesBar(
      async () => {
        await _commitActiveInlineEdit();
        await persistCommentDraft();
        await flushDeferredSave();
        if (state.selectedContactId) { try { await saveWorkflowData(); } catch (e) {
          if (e.code === 'HUBSPOT_AUTH') {
            showToast('Could not save — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
          } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
            showToast('Could not save — HubSpot rate limit reached. Please try again in a moment.', true);
          } else {
            showToast('Failed to save', true);
          }
        } }
        _performGoBack();
      },
      () => {
        _discardActiveInlineEdit();
        _clearCommentDraft();
        discardPendingSave();
        _performGoBack();
      }
    );
    return;
  }

  await flushDeferredSave();
  if (state.selectedContactId) { try { await saveWorkflowData(); } catch (e) {
    if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not save — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not save — HubSpot rate limit reached. Please try again in a moment.', true);
    } else {
      showToast('Failed to save', true);
    }
  } }
  _performGoBack();
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
    const stageDates = { ...(room.stageDates || {}) };
    if (!stageDates.designvisit) stageDates.designvisit = todayISO();
    return { ...room, stageKey: 'designvisit', completedStatuses: cs, stageDates };
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
  // Close a pristine open edit-contact modal so it doesn't get stranded.
  if (state.selectedContactId && state.selectedContactId !== contactId
      && typeof closeContactEditIfPristine === 'function') {
    closeContactEditIfPristine();
  }
  // Guard for unsaved changes when switching to a different contact
  if (state.selectedContactId && state.selectedContactId !== contactId && hasUnsavedChanges()) {
    showUnsavedChangesBar(
      async () => {
        await _commitActiveInlineEdit();
        await persistCommentDraft();
        await flushDeferredSave();
        try { await saveWorkflowData(); } catch (e) {
          if (e.code === 'HUBSPOT_AUTH') {
            showToast('Could not save — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
          } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
            showToast('Could not save — HubSpot rate limit reached. Please try again in a moment.', true);
          } else {
            showToast('Failed to save', true);
          }
        }
        _doSelectContact(contactId, roomIdx);
      },
      () => {
        _discardActiveInlineEdit();
        _clearCommentDraft();
        discardPendingSave();
        _doSelectContact(contactId, roomIdx);
      }
    );
    return;
  }
  _doSelectContact(contactId, roomIdx);
}

async function _doSelectContact(contactId, roomIdx) {
  // Always flush unsaved notes/workflow for current contact before switching
  captureNotes();
  if (state.selectedContactId && state.selectedContactId !== contactId) {
    await flushDeferredSave();
    try { await saveWorkflowData(); } catch (e) {
      if (e.code === 'HUBSPOT_AUTH') {
        showToast('Could not save — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
      } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
        showToast('Could not save — HubSpot rate limit reached. Please try again in a moment.', true);
      } else {
        showToast('Failed to save', true);
      }
    }
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
  _cancelNoteAutosaveTimer();
  _noteAutosaveDraft      = null;

  document.getElementById('empty-state').classList.add('hidden');
  const wv = document.getElementById('workflow-view');
  wv.innerHTML = `
    <button class="back-btn" onclick="goBack()">
      <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7"/>
      </svg>
      Customers
    </button>
    <div class="bg-white border-b border-slate-200 px-4 sm:px-6 py-4 shadow-sm">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1 min-w-0">
          <div class="skeleton-line skeleton-wf-name"></div>
          <div class="flex items-center gap-2 mt-3">
            <div class="skeleton-line skeleton-wf-badge"></div>
            <div class="skeleton-line skeleton-wf-email"></div>
            <div class="skeleton-line skeleton-wf-phone"></div>
          </div>
        </div>
        <div class="skeleton-line skeleton-wf-select"></div>
      </div>
    </div>
    <div class="workflow-inner">
      <div class="space-y-2">
        <div class="skeleton-stage-row"><div class="flex items-center gap-3 flex-1"><div class="skeleton-line skeleton-stage-dot"></div><div class="skeleton-line skeleton-stage-label"></div></div><div class="skeleton-line skeleton-stage-count"></div></div>
        <div class="skeleton-stage-row"><div class="flex items-center gap-3 flex-1"><div class="skeleton-line skeleton-stage-dot"></div><div class="skeleton-line skeleton-stage-label skeleton-stage-label-md"></div></div><div class="skeleton-line skeleton-stage-count"></div></div>
        <div class="skeleton-stage-row"><div class="flex items-center gap-3 flex-1"><div class="skeleton-line skeleton-stage-dot"></div><div class="skeleton-line skeleton-stage-label skeleton-stage-label-sm"></div></div><div class="skeleton-line skeleton-stage-count"></div></div>
      </div>
    </div>
  `;
  wv.classList.remove('hidden');
  void wv.offsetWidth;
  showWorkflowPanel();

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
        assignedFitterId:  r.assignedFitterId || null,
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
    _restoreNoteDraftIfPresent();
  } catch (e) {
    const isDbError = e.code === 'DB_ERROR';
    const msg = isDbError
      ? 'This customer couldn\'t be loaded — there was a problem reaching the database.'
      : `Failed to load: ${escHtml(e.message)}`;
    wv.innerHTML = `
      <div class="p-6 text-red-500 text-sm" style="text-align:center">
        <p>${msg}</p>
        <button onclick="selectContact(state.selectedContactId, state.selectedRoomIdx ?? 0)" style="margin-top:0.75rem;padding:0.4rem 1rem;border:1px solid #6b7280;border-radius:0.375rem;background:#f9fafb;cursor:pointer;font-size:0.875rem;color:#374151;">Retry</button>
        ${isDbError ? '<p style="margin-top:0.5rem;font-size:0.8rem;color:#6b7280;">If this keeps happening, try refreshing the page.</p>' : ''}
      </div>`;
  } finally {
    state.loadingContact = false;
  }
}

// ── Room Management ───────────────────────────────────────────────────────────
async function switchRoom(idx) {
  if (idx === state.selectedRoomIdx) return;
  captureNotes();
  if (typeof closeContactEditIfPristine === 'function') closeContactEditIfPristine();

  if (hasUnsavedChanges()) {
    showUnsavedChangesBar(
      async () => {
        await _commitActiveInlineEdit();
        await persistCommentDraft();
        await flushDeferredSave();
        try { await saveWorkflowData(); } catch (e) {
          if (e.code === 'HUBSPOT_AUTH') {
            showToast('Could not save — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
          } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
            showToast('Could not save — HubSpot rate limit reached. Please try again in a moment.', true);
          } else {
            showToast('Failed to save', true);
          }
        }
        _doSwitchRoom(idx);
      },
      () => {
        _discardActiveInlineEdit();
        _clearCommentDraft();
        discardPendingSave();
        _doSwitchRoom(idx);
      }
    );
    return;
  }

  await flushDeferredSave();
  try { await saveWorkflowData(); } catch (e) {
    if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not save — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not save — HubSpot rate limit reached. Please try again in a moment.', true);
    } else {
      showToast('Failed to save', true);
    }
  }
  _doSwitchRoom(idx);
}

function _doSwitchRoom(idx) {
  state.selectedRoomIdx = idx;
  state.workflowData = state.allRooms[idx];
  state.expandedStages = new Set();
  renderFullWorkflowView();
  _restoreNoteDraftIfPresent();
}

function showAddRoomForm() {
  state.addingRoom = true;
  renderRoomTabs();
  setTimeout(() => document.getElementById('new-room-name')?.focus(), 30);
  _updateBeforeUnloadGuard();
}

function hideAddRoomForm() {
  state.addingRoom = false;
  renderRoomTabs();
  _updateBeforeUnloadGuard();
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
  try { await saveWorkflowData(); } catch (e) {
    if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not save — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not save — HubSpot rate limit reached. Please try again in a moment.', true);
    } else {
      showToast('Failed to save room', true);
    }
  }
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
    <div id="contact-edit-inline" class="contact-edit-inline hidden"></div>
    <div class="workflow-inner">
      <div id="comments-section" class="mb-5"></div>
      <div id="room-tabs-section" class="mb-5"></div>
      <div id="invoices-section" class="mb-5"></div>
      <div id="tasks-section" class="mb-6"></div>
      <div id="google-emails-section" class="mb-5"></div>
      <div id="workflow-stages" class="space-y-2"></div>
    </div>
  `;
  document.getElementById('workflow-stages').addEventListener('click', function(e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const key = target.dataset.key;
    if (action === 'toggleStage' && key) {
      toggleStage(key);
    } else if (action === 'setStatusChecked' && key) {
      setStatusChecked(key, target.dataset.statusId, target.dataset.checked === 'true');
    } else if (action === 'moveBackToStage' && key) {
      moveBackToStage(key);
    }
  });
  renderWorkflowHeader();
  renderComments();
  renderRoomTabs();
  renderWorkflowInvoices();
  renderTasks();
  renderGoogleEmailSection();
  renderWorkflowStages();
  renderComments();
}

// captureNotes retained as no-op — called before navigation to flush any pending state
function captureNotes() {}

// ── Google Emails (customer detail) ──────────────────────────────────────────
function _googleAuthToast() {
  showToast('Google account disconnected — reconnect in Settings', true);
}

function showGmailListLoading(label = 'Loading…') {
  const list = document.getElementById('gmail-list');
  if (list) {
    list.innerHTML = `<div class="flex items-center gap-2" style="padding:8px 0"><div class="spinner" style="width:14px;height:14px"></div> ${escHtml(label)}</div>`;
  }
}

async function renderGoogleEmailSection() {
  const el = document.getElementById('google-emails-section');
  if (!el) return;

  if (!state.authStatus?.google) { el.innerHTML = ''; return; }

  const contactEmail = state.selectedContact?.properties?.email || '';
  if (!contactEmail) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <div class="notes-header">
      <span class="notes-header-label">Gmail</span>
      <button class="btn-new-note" data-viewer-hide onclick="openEmailCompose()">+ Compose</button>
    </div>
    <div id="gmail-list" class="text-sm" style="color:var(--stone-deep)"></div>
    <div id="gmail-compose" class="hidden" style="margin-top:10px"></div>
  `;
  showGmailListLoading();

  try {
    const { messages } = await GET(`/api/emails?email=${encodeURIComponent(contactEmail)}`);
    const list = document.getElementById('gmail-list');
    if (!list) return;
    if (!messages || messages.length === 0) {
      list.innerHTML = `<p style="font-size:0.85rem;padding:4px 0;font-style:italic">No emails found with ${escHtml(contactEmail)}</p>`;
      return;
    }
    list.innerHTML = messages.map(m => {
      const dateStr = m.date ? new Date(m.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
      const from = m.from.replace(/<[^>]+>/, '').trim() || m.from;
      return `
        <div class="comment-item" style="margin-bottom:6px">
          <div class="comment-meta">
            <span class="comment-author">${escHtml(from)}</span>
            ${dateStr ? `<span class="comment-meta-sep">·</span><span class="comment-date">${escHtml(dateStr)}</span>` : ''}
          </div>
          <div class="comment-text" style="font-weight:500">${escHtml(m.subject || '(no subject)')}</div>
          ${m.snippet ? `<div class="comment-text" style="font-size:0.8rem;opacity:0.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(m.snippet)}</div>` : ''}
        </div>
      `;
    }).join('');
  } catch (e) {
    const list = document.getElementById('gmail-list');
    if (!list) return;
    if (e.code === 'GOOGLE_AUTH') {
      list.innerHTML = `<p style="font-size:0.85rem;color:#b91c1c;padding:4px 0">Google account disconnected — <a href="/profile" style="color:var(--orchid);text-decoration:underline">reconnect in Settings</a></p>`;
    } else {
      list.innerHTML = `<p style="font-size:0.85rem;color:#b91c1c;padding:4px 0">Could not load emails. Please try again.</p>`;
    }
  }
}

function openEmailCompose() {
  if (isViewerOnly()) return;
  const compose = document.getElementById('gmail-compose');
  if (!compose) return;
  const to = state.selectedContact?.properties?.email || '';
  compose.classList.remove('hidden');
  compose.innerHTML = `
    <div style="border:1px solid var(--stone-light);border-radius:10px;padding:14px;background:#fff">
      <div style="margin-bottom:8px;font-size:0.8rem;font-weight:600;color:var(--ink-2)">New email</div>
      <input id="gmail-to" type="email" value="${escHtml(to)}" placeholder="To"
        class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:border-blue-400 bg-white" style="font-size:16px">
      <input id="gmail-subject" type="text" placeholder="Subject"
        class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:border-blue-400 bg-white" style="font-size:16px">
      <textarea id="gmail-body" rows="4" placeholder="Message…"
        class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:border-blue-400 bg-white" style="font-size:16px;resize:vertical"></textarea>
      <div class="flex gap-2 justify-end">
        <button onclick="closeEmailCompose()" class="btn-cancel-note">Cancel</button>
        <button id="gmail-send-btn" onclick="submitEmail()" class="btn-save-note">Send</button>
      </div>
      <div id="gmail-send-error" style="display:none;margin-top:6px;font-size:0.8rem;color:#b91c1c"></div>
    </div>
  `;
  document.getElementById('gmail-subject')?.focus();
}

function closeEmailCompose() {
  const compose = document.getElementById('gmail-compose');
  if (compose) { compose.innerHTML = ''; compose.classList.add('hidden'); }
}

async function submitEmail() {
  const to      = document.getElementById('gmail-to')?.value.trim();
  const subject = document.getElementById('gmail-subject')?.value.trim();
  const body    = document.getElementById('gmail-body')?.value.trim();
  const errEl   = document.getElementById('gmail-send-error');
  const sendBtn = document.getElementById('gmail-send-btn');

  if (!to || !subject || !body) {
    if (errEl) { errEl.textContent = 'Please fill in all fields.'; errEl.style.display = ''; }
    return;
  }

  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending…'; }
  if (errEl) errEl.style.display = 'none';

  try {
    await POST('/api/emails/send', { to, subject, body });
    closeEmailCompose();
    showToast('Email sent');
    showGmailListLoading('Refreshing…');
    setTimeout(() => renderGoogleEmailSection(), 2000);
  } catch (e) {
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
    let msg;
    if (e.code === 'GOOGLE_AUTH') {
      msg = 'Google account disconnected — reconnect in Settings';
      _googleAuthToast();
    } else {
      msg = 'Failed to send email. Please try again.';
      showToast(msg, true);
    }
    if (errEl) { errEl.textContent = msg; errEl.style.display = ''; }
  }
}

// ── Room Tabs ─────────────────────────────────────────────────────────────────
// Implementation registered with core.js via registerRoomTabsRenderer below.
function _renderRoomTabsImpl() {
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
      ${canDelete ? `<button class="room-tab-del" title="Delete room" data-viewer-hide
        onclick="event.stopPropagation();deleteRoom(${idx})">×</button>` : ''}
    </span>
  `).join('');

  const addForm = state.addingRoom ? `
    <div class="flex gap-2 mt-2">
      <input id="new-room-name" type="text" placeholder="e.g. Master bedroom..."
        class="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400 bg-white"
        style="font-size:16px" oninput="_updateBeforeUnloadGuard()"
        onkeydown="if(event.key==='Enter')submitAddRoom();if(event.key==='Escape')hideAddRoomForm()">
      <button onclick="submitAddRoom()" class="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-blue-700 transition whitespace-nowrap">Add</button>
      <button onclick="hideAddRoomForm()" class="text-xs text-slate-500 px-2 hover:text-slate-700">✕</button>
    </div>
  ` : '';

  const startVal  = state.workflowData?.installStart  || '';
  const finishVal = state.workflowData?.installFinish || '';

  el.innerHTML = `
    <div class="flex items-center gap-1.5 flex-wrap">
      ${tabs}
      <button onclick="showAddRoomForm()" class="room-tab-add" data-viewer-hide>+ Room</button>
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
  updateRoomCache();
  const label = field === 'installStart' ? 'Installation start' : 'Installation finish';
  scheduleSave(`${label} updated`, snapshot);
}

// ── Workflow Header ───────────────────────────────────────────────────────────
// Implementation registered with core.js via registerWorkflowHeaderRenderer below.
function _renderWorkflowHeaderImpl() {
  const el = document.getElementById('workflow-header');
  if (!el) return;

  const contact    = state.selectedContact;
  const name       = contactName(contact);
  const email      = contact?.properties?.email || '';
  const phone      = contact?.properties?.phone || '';
  const city       = contact?.properties?.city  || '';
  const customerNum = contact?.properties?.customer_number || '';
  const stageKey   = state.workflowData?.stageKey || 'sales';
  const colour     = stageColour(stageKey);
  const stageLabel = state.workflow?.stages?.[stageKey]?.label || stageKey;

  const stageOptions = Object.entries(state.workflow?.stages || {}).map(([key, s]) =>
    `<option value="${escHtml(key)}" ${key === stageKey ? 'selected' : ''}>${escHtml(s.label)}</option>`
  ).join('');

  el.innerHTML = `
    <div class="flex items-start justify-between gap-4 flex-wrap">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2.5 min-w-0">
          <h1 class="text-xl font-bold text-slate-900 truncate">${escHtml(name)}</h1>
          ${customerNum ? `<span class="customer-num-badge">${escHtml(customerNum)}</span>` : ''}
          <button class="contact-edit-btn" onclick="openContactEdit()" title="Edit contact details" data-viewer-hide>
            <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
            </svg>
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-2 mt-1.5">
          <span class="text-xs font-semibold px-2.5 py-1 rounded-full"
                style="background:${colour.light};color:${colour.text}">${escHtml(stageLabel)}</span>
          ${(() => {
            const raw = contact?.properties?.hs_lead_status || '';
            const lsMap = {
              'OPEN_DEAL':            { label: 'Open Deal',   cls: 'lsb-open-deal' },
              'NEW':                  { label: 'New',          cls: 'lsb-new' },
              'IN_PROGRESS':          { label: 'In Progress',  cls: 'lsb-in-progress' },
              'OPEN':                 { label: 'Open',         cls: 'lsb-new' },
              'CONNECTED':            { label: 'Connected',    cls: 'lsb-connected' },
              'ATTEMPTED_TO_CONTACT': { label: 'Attempted',    cls: '' },
              'UNQUALIFIED':          { label: 'Unqualified',  cls: 'lsb-unqualified' },
              'BAD_TIMING':           { label: 'Bad Timing',   cls: 'lsb-bad-timing' },
            };
            const cid = contact?.id || '';
            if (!raw) {
              return `<span class="lead-status-badge lsb-empty" title="Set lead status" onclick="openLeadStatusPicker(event,'${cid}')">+ Lead Status</span>`;
            }
            const entry = lsMap[raw] || { label: raw.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()), cls: '' };
            return `<span class="lead-status-badge ${entry.cls} lsb-clickable" title="Change lead status" onclick="openLeadStatusPicker(event,'${cid}')">${escHtml(entry.label)}</span>`;
          })()}
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
// Implementation registered with core.js via registerWorkflowStagesRenderer below.
function _renderWorkflowStagesImpl() {
  const el = document.getElementById('workflow-stages');
  if (!el || !state.workflow) return;

  const currentStageKey = state.workflowData?.stageKey || 'sales';
  const currentStatusId = state.workflowData?.statusId;
  const currentStageIdx = STAGE_KEYS.indexOf(currentStageKey);

  const completedStatuses = state.workflowData?.completedStatuses || {};

  const stagesHtml = Object.entries(state.workflow.stages).map(([key, stage], i) => {
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
                 data-action="setStatusChecked" data-key="${escHtml(key)}" data-status-id="${escHtml(status.id)}" data-checked="${!done}">
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
            <button class="btn-move-back" data-action="moveBackToStage" data-key="${escHtml(key)}">← Set as current stage</button>
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
        <div class="stage-header-row" ${isFuture ? '' : `data-action="toggleStage" data-key="${escHtml(key)}"`}
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

  el.innerHTML = stagesHtml;
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
      renderProjectsView();
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
        renderProjectsView();
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
  renderProjectsView();
  renderWorkflowStages();
  renderWorkflowHeader();
  const label = state.workflow?.stages?.[stageKey]?.label || stageKey;
  scheduleSave(`Moved back to ${label}`, snapshot);
}

// ── Save Workflow Data ────────────────────────────────────────────────────────
// Implementation registered with core.js via registerWorkflowDataSaver below.
async function _saveWorkflowDataImpl() {
  if (isViewerOnly()) return;
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

// ── Note auto-save ─────────────────────────────────────────────────────────
let _noteAutosaveTimer = null;
let _noteAutosaveDraft = null; // comment object most recently auto-saved into state

function _setNoteAutosaveStatus(text) {
  const el = document.getElementById('note-autosave-status');
  if (el) el.textContent = text;
}

function _cancelNoteAutosaveTimer() {
  if (_noteAutosaveTimer) { clearTimeout(_noteAutosaveTimer); _noteAutosaveTimer = null; }
}

function _removeAutosaveDraftFromState() {
  if (_noteAutosaveDraft && state.workflowData?.comments) {
    const idx = state.workflowData.comments.indexOf(_noteAutosaveDraft);
    if (idx !== -1) state.workflowData.comments.splice(idx, 1);
  }
  _noteAutosaveDraft = null;
}

function _scheduleNoteAutosave() {
  _cancelNoteAutosaveTimer();
  _noteAutosaveTimer = setTimeout(async () => {
    _noteAutosaveTimer = null;
    const input = document.getElementById('comment-input');
    const text = input?.value.trim();
    if (!text || !state.workflowData) return;
    _removeAutosaveDraftFromState();
    const u = state.user;
    const author = [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.email || '';
    const draft = { text, date: new Date().toISOString(), author, isDraft: true };
    if (!state.workflowData.comments) state.workflowData.comments = [];
    state.workflowData.comments.push(draft);
    _noteAutosaveDraft = draft;
    _setNoteAutosaveStatus('Saving…');
    try {
      await saveWorkflowData();
      _setNoteAutosaveStatus('Saved');
      setTimeout(() => _setNoteAutosaveStatus(''), 3000);
    } catch (e) {
      _removeAutosaveDraftFromState();
      _setNoteAutosaveStatus('');
      if (e.code === 'HUBSPOT_AUTH') {
        showToast('Could not save note — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
      } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
        showToast('Could not save note — HubSpot rate limit reached. Please try again in a moment.', true);
      } else {
        showToast('Failed to save note', true);
      }
    }
  }, 4000);
}

// ── Notes / Comments ──────────────────────────────────────────────────────────
function renderComments() {
  const el = document.getElementById('comments-section');
  if (!el) return;
  const allComments = state.workflowData?.comments || [];
  const comments = allComments.filter(c => !c.isDraft);
  el.innerHTML = `
    <div class="notes-header">
      <span class="notes-header-label">Notes</span>
      <span id="note-autosave-status" class="note-autosave-status"></span>
      <button class="btn-new-note" onclick="showAddComment()" data-viewer-hide>+ New note</button>
    </div>
    <div id="comment-input-area" class="comment-input-area hidden">
      <div id="draft-resume-banner" class="draft-resume-banner hidden">
        <span class="draft-resume-banner-text">Draft restored — review and save or cancel to discard.</span>
        <button type="button" class="draft-resume-banner-close" aria-label="Dismiss banner" onclick="dismissDraftResumeBanner()">×</button>
      </div>
      <textarea id="comment-input" rows="3" class="notes-textarea"
        placeholder="Add a note..."
        onkeydown="if(event.ctrlKey&&event.key==='Enter')addComment()"
        oninput="_updateBeforeUnloadGuard();_scheduleNoteAutosave()"
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
              <div class="comment-meta">
                ${c.author ? `<span class="comment-author">${escHtml(c.author)}</span><span class="comment-meta-sep">·</span>` : ''}
                <span class="comment-date">${escHtml(formatDate(c.date))}</span>
              </div>
              <div class="comment-text">${escHtml(c.text)}</div>
            </div>
          `).join('')
        : `<p class="text-sm italic" style="color:var(--stone-deep)">No notes yet.</p>`
      }
    </div>
  `;
}

function _restoreNoteDraftIfPresent() {
  if (!state.workflowData?.comments) return;
  const draft = state.workflowData.comments.find(c => c.isDraft);
  if (!draft) return;
  // Keep the draft entry in comments (isDraft:true) so unrelated saves
  // (stage/task/room changes) continue to persist it to HubSpot until the
  // user explicitly saves or cancels.  _removeAutosaveDraftFromState() will
  // remove it by reference on Save/Cancel.
  _noteAutosaveDraft = draft;
  const area   = document.getElementById('comment-input-area');
  const input  = document.getElementById('comment-input');
  const banner = document.getElementById('draft-resume-banner');
  if (!area || !input) return;
  input.value = draft.text;
  area.classList.remove('hidden');
  if (banner) banner.classList.remove('hidden');
  _updateBeforeUnloadGuard();
}

// Persist a typed-but-not-yet-saved comment draft before navigating away.
// Appends the draft to state.workflowData.comments so the subsequent
// saveWorkflowData() call in the save path persists it to the server.
async function persistCommentDraft() {
  _cancelNoteAutosaveTimer();
  const area  = document.getElementById('comment-input-area');
  const input = document.getElementById('comment-input');
  if (!area || area.classList.contains('hidden') || !input) return;
  const text = input.value.trim();
  if (!text || !state.workflowData) return;
  if (!state.workflowData.comments) state.workflowData.comments = [];
  // If the auto-save already committed this exact draft, don't push a duplicate
  if (_noteAutosaveDraft && _noteAutosaveDraft.text === text) {
    _noteAutosaveDraft = null;
    _clearCommentDraft();
    return;
  }
  // Remove any stale auto-saved draft before pushing the final version
  _removeAutosaveDraftFromState();
  const u = state.user;
  const author = [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.email || '';
  state.workflowData.comments.push({ text, date: new Date().toISOString(), author, isDraft: true });
  _clearCommentDraft();
}

function dismissDraftResumeBanner() {
  document.getElementById('draft-resume-banner')?.classList.add('hidden');
}

function showAddComment() {
  const area = document.getElementById('comment-input-area');
  if (!area) return;
  area.classList.remove('hidden');
  document.getElementById('draft-resume-banner')?.classList.add('hidden');
  document.getElementById('comment-input')?.focus();
  _updateBeforeUnloadGuard();
}

async function hideAddComment() {
  _cancelNoteAutosaveTimer();
  const hadAutosave = _noteAutosaveDraft !== null;
  _removeAutosaveDraftFromState();
  const area = document.getElementById('comment-input-area');
  if (area) area.classList.add('hidden');
  _updateBeforeUnloadGuard();
  if (hadAutosave) {
    try { await saveWorkflowData(); } catch { /* silent — draft already removed from state */ }
  }
}

async function addComment() {
  _cancelNoteAutosaveTimer();
  _removeAutosaveDraftFromState();
  const input = document.getElementById('comment-input');
  const text  = input?.value.trim();
  if (!text) return;
  if (!state.workflowData.comments) state.workflowData.comments = [];
  const u = state.user;
  const author = [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.email || '';
  const comment = { text, date: new Date().toISOString(), author };
  state.workflowData.comments.push(comment);
  input.value = '';
  hideAddComment();
  renderComments();
  try {
    await saveWorkflowData();
    // Re-fetch the contact so the list reflects the latest server state (e.g.
    // HubSpot last-activity timestamp).  Route through _mergeContactIntoState
    // so any in-flight optimistic lead-status change on the badge is preserved
    // rather than overwritten by the fresh server value.
    const freshContact = await GET(`/api/contacts/${state.selectedContactId}`).catch(() => null);
    if (freshContact) {
      _mergeContactIntoState(freshContact);
      renderCustomerList();
    }
  } catch (e) {
    state.workflowData.comments.pop();
    renderComments();
    if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not save note — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not save note — HubSpot rate limit reached. Please try again in a moment.', true);
    } else {
      showToast('Failed to save note', true);
    }
  }
}

// ── Tasks ─────────────────────────────────────────────────────────────────────
function renderTasks() {
  const el = document.getElementById('tasks-section');
  if (!el) return;

  const stageOptions = Object.entries(state.workflow?.stages || {}).map(([key, s]) =>
    `<option value="${escHtml(key)}">${escHtml(s.label)}</option>`
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
      <button onclick="toggleAddTask()" id="add-task-btn" data-viewer-hide
        class="text-xs font-semibold text-blue-600 hover:text-blue-700 px-2.5 py-1 rounded-lg hover:bg-blue-50 transition">
        ${state.showAddTask ? 'Cancel' : '+ Add task'}
      </button>
    </div>
    ${state.showAddTask ? `
      <div class="add-task-form">
        <input id="task-subject" type="text" placeholder="Task description..."
          class="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm mb-2 focus:outline-none focus:border-blue-400 bg-white"
          style="font-size:16px" oninput="_updateBeforeUnloadGuard()"
          onkeydown="if(event.key==='Enter')saveNewTask()">
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
  _updateBeforeUnloadGuard();
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
    _updateBeforeUnloadGuard();
  } catch (e) {
    if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not create task — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not create task — HubSpot rate limit reached. Please try again in a moment.', true);
    } else {
      showToast('Failed to create task', true);
    }
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
  } catch (e) {
    task.properties.hs_task_status = prevStatus;
    state.contactUrgencyCache[state.selectedContactId] = getTaskUrgency(state.tasks);
    renderCustomerList();
    renderTasks();
    if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not update task — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not update task — HubSpot rate limit reached. Please try again in a moment.', true);
    } else {
      showToast('Failed to update task', true);
    }
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
  } catch (e) {
    state.tasks.splice(idx, 0, removed);
    state.contactUrgencyCache[state.selectedContactId] = getTaskUrgency(state.tasks);
    renderCustomerList();
    renderTasks();
    if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not delete task — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not delete task — HubSpot rate limit reached. Please try again in a moment.', true);
    } else {
      showToast('Failed to delete task', true);
    }
  }
}

function renderWorkflowInvoices() {
  const el = document.getElementById('invoices-section');
  if (!el) return;

  if (!state.qb.loadError && (!state.qb.statusKnown || state.qb.loading || (state.qb.connected && !state.qb.loaded))) {
    el.innerHTML = `
      <div class="qb-section">
        <div class="qb-section-title">Invoices</div>
        <div class="qb-invoice-row" style="pointer-events:none">
          <div class="qb-invoice-meta">
            <div class="skeleton-line" style="height:11px;width:90px"></div>
            <div class="skeleton-line" style="height:9px;width:64px;margin-top:4px"></div>
          </div>
          <div class="skeleton-line" style="height:13px;width:48px;flex-shrink:0"></div>
        </div>
        <div class="qb-invoice-row" style="pointer-events:none">
          <div class="qb-invoice-meta">
            <div class="skeleton-line" style="height:11px;width:74px"></div>
            <div class="skeleton-line" style="height:9px;width:56px;margin-top:4px"></div>
          </div>
          <div class="skeleton-line" style="height:13px;width:42px;flex-shrink:0"></div>
        </div>
      </div>`;
    return;
  }

  if (state.qb.loadError) {
    const isDbError = state.qb.errorCode === 'DB_ERROR';
    const msg = isDbError
      ? 'Database unreachable'
      : (state.qb.error || 'QuickBooks error');
    el.innerHTML = `
      <div class="qb-section">
        <div class="qb-section-title">Invoices</div>
        <p class="text-sm" style="color:#ef4444;margin-bottom:6px">${escHtml(msg)}</p>
        <button onclick="loadQBInvoices()" class="qb-refresh-btn" style="font-size:12px;padding:5px 10px">
          <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
          Retry
        </button>
      </div>`;
    return;
  }

  if (!state.qb.connected) { el.innerHTML = ''; return; }

  const contact = state.selectedContact;
  if (!contact) { el.innerHTML = ''; return; }

  const invoices = matchInvoicesForContact(contact);
  if (!invoices.length) {
    el.innerHTML = `<div class="qb-section"><div class="qb-section-title">Invoices <span class="qb-section-company">${escHtml(state.qb.company || 'QuickBooks')}</span></div><p class="text-sm text-slate-400">No outstanding invoices</p></div>`;
    return;
  }

  const total = invoices.reduce((s, inv) => s + inv.balance, 0);
  const rows  = invoices.sort((a, b) => b.balance - a.balance).map(inv => {
    const isPaid      = inv.balance != null && Number(inv.balance) === 0;
    const overdue     = !isPaid && inv.dueDate && new Date(inv.dueDate) < new Date();
    const statusKey   = isPaid ? 'paid' : overdue ? 'overdue' : 'open';
    const statusLabel = isPaid ? 'Paid' : overdue ? 'Overdue' : 'Open';
    return `
      <div class="qb-invoice-row">
        <div class="qb-invoice-meta">
          <span class="qb-invoice-num">Invoice #${escHtml(inv.docNumber || inv.id)}</span>
          ${inv.dueDate ? `<span class="qb-invoice-date">Due ${fmtQBDate(inv.dueDate)}</span>` : ''}
        </div>
        <div class="flex items-center gap-1" style="flex-shrink:0">
          <span class="inv-status-badge inv-status-${statusKey}">${statusLabel}</span>
          <span class="qb-invoice-amount">${fmtGBP(inv.balance)}</span>
        </div>
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

// ── Register implementations with core.js dispatchers ─────────────────────────
registerRoomTabsRenderer(_renderRoomTabsImpl);
registerWorkflowHeaderRenderer(_renderWorkflowHeaderImpl);
registerWorkflowStagesRenderer(_renderWorkflowStagesImpl);
registerWorkflowDataSaver(_saveWorkflowDataImpl);

