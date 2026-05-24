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
  document.querySelectorAll('.customer-project-card-selected').forEach(el => el.classList.remove('customer-project-card-selected'));
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

// ── HubSpot lead status → workflow stage sync ────────────────────────────────
// Map the admin-configured lead_status_config.stage (uppercase) to the
// lowercase stageKey used in STAGE_KEYS. Only the three "pipeline" stages
// drive lead-status sync; later stages (order/workshop/…) have no dedicated
// lead-status mapping. Still required: consulted by syncRoomFromHubSpot below
// and by the per-LS card-action label lookup in renderWorkflowStages.
const LS_STAGE_TO_KEY = {
  SALES:        'sales',
  DESIGN_VISIT: 'designvisit',
  SURVEY:       'survey',
};

function _lsMappedStageKey(leadStatus) {
  if (!leadStatus || typeof LEAD_STATUS_OPTIONS === 'undefined') return null;
  const opt = LEAD_STATUS_OPTIONS.find(o => o.value === String(leadStatus).toUpperCase());
  const upper = opt?.stage;
  return upper ? (LS_STAGE_TO_KEY[upper] || null) : null;
}

// Pull a room back to the admin-mapped stage for its HubSpot lead status
// when the local stageKey sits AHEAD of the LS-mapped one. Handles the case
// where a user walked HubSpot LS backward (e.g. Survey → Open Deal) and the
// local workflow row went stale. Only applies to the three pipeline stages
// (sales / designvisit / survey); order/workshop/… intentionally have no LS
// mapping and are left untouched.
function syncRoomFromHubSpot(room, leadStatus) {
  if (!leadStatus) return room;
  const targetKey = _lsMappedStageKey(leadStatus);
  if (!targetKey || STAGE_KEYS.indexOf(targetKey) === -1) return room;
  const curIdx = STAGE_KEYS.indexOf(room.stageKey || 'sales');
  const tgtIdx = STAGE_KEYS.indexOf(targetKey);
  if (curIdx === -1 || tgtIdx >= curIdx) return room;
  const stageDates = { ...(room.stageDates || {}) };
  if (!stageDates[targetKey]) stageDates[targetKey] = todayISO();
  return { ...room, stageKey: targetKey, stageDates };
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
  state.focusedStageKey   = null;
  state.focusedLeadStatus = null;
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
      state.allRooms = [{ room: 'Main', stageKey: 'sales', completedStatuses: {}, comments: [], stageDates: { sales: todayISO() } }];
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
        stageDates,
        substateDates:     r.substateDates ? { ...r.substateDates } : {},
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

    let resolvedRoomIdx = roomIdx;
    try {
      const saved = localStorage.getItem('customerRoomIdx_' + contactId);
      if (saved !== null) {
        const n = parseInt(saved, 10);
        if (!isNaN(n) && n >= 0 && n < state.allRooms.length) resolvedRoomIdx = n;
      }
    } catch (_) {}
    state.selectedRoomIdx = Math.min(resolvedRoomIdx, state.allRooms.length - 1);
    state.workflowData = state.allRooms[state.selectedRoomIdx];
    state.focusedStageKey = state.workflowData?.stageKey || 'sales';

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
  state.focusedStageKey = state.workflowData?.stageKey || 'sales';
  try { localStorage.setItem('customerRoomIdx_' + state.selectedContactId, String(idx)); } catch (_) {}
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
  state.allRooms.push({ room: name, stageKey: 'sales', completedStatuses: {}, comments: [], stageDates: { sales: todayISO() } });
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
      <div id="upcoming-visits-section" class="mb-5"></div>
      <div id="past-visits-section" class="mb-5"></div>
      <div id="design-visits-section" class="mb-5"></div>
      <div id="tasks-section" class="mb-6"></div>
      <div id="google-emails-section" class="mb-5"></div>
      <div id="whatsapp-history-section" class="mb-5"></div>
      <div id="workflow-stages" class="space-y-2"></div>
    </div>
  `;
  document.getElementById('workflow-stages').addEventListener('click', function(e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    if (action === 'setFocusedLeadStatus' && target.dataset.value) {
      state.focusedLeadStatus = target.dataset.value;
      renderWorkflowStages();
    } else if (action === 'focusPrevLeadStatus' || action === 'focusNextLeadStatus') {
      const rail = (typeof LEAD_STATUS_OPTIONS !== 'undefined' ? LEAD_STATUS_OPTIONS : [])
        .filter(o => !o.excluded_from_sales);
      if (rail.length) {
        const cur = state.focusedLeadStatus || rail[0].value;
        const i = rail.findIndex(e => e.value === cur);
        const next = action === 'focusPrevLeadStatus' ? i - 1 : i + 1;
        if (next >= 0 && next < rail.length) {
          state.focusedLeadStatus = rail[next].value;
          renderWorkflowStages();
        }
      }
    } else if (action === 'setLeadSubstatusChecked') {
      setLeadSubstatusChecked(target.dataset.statusValue, target.dataset.substatusKey, target.dataset.checked === 'true');
    }
  });
  renderWorkflowHeader();
  renderComments();
  renderRoomTabs();
  renderWorkflowInvoices();
  renderUpcomingVisits();
  renderPastVisits();
  renderDesignVisits();
  renderTasks();
  renderGoogleEmailSection();
  renderWhatsAppHistory();
  renderWorkflowStages();
  renderComments();
}

// captureNotes retained as no-op — called before navigation to flush any pending state
function captureNotes() {}

// ── WhatsApp History (customer detail) ───────────────────────────────────────
async function renderWhatsAppHistory() {
  const el = document.getElementById('whatsapp-history-section');
  if (!el) return;

  if (!state.whatsappEnabled || isViewerOnly()) { el.innerHTML = ''; return; }

  const contactId = state.selectedContactId;
  if (!contactId) { el.innerHTML = ''; return; }

  try {
    const { messages } = await GET(`/api/whatsapp/history/${encodeURIComponent(contactId)}`);
    if (!messages || messages.length === 0) { el.innerHTML = ''; return; }

    el.innerHTML = `
      <div class="notes-header">
        <span class="notes-header-label">WhatsApp sent</span>
      </div>
      <div id="whatsapp-history-list"></div>
    `;

    const list = document.getElementById('whatsapp-history-list');
    list.innerHTML = messages.map((m, idx) => {
      const dateStr = m.sent_at
        ? new Date(m.sent_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        : '';
      const senderName = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.sender_email || 'Unknown';

      let preview, fullContent;
      if (m.mode === 'template') {
        const tplLabel = m.template_name || 'Template message';
        preview = `Template: ${tplLabel}`;
        let params = null;
        try { params = m.template_params ? JSON.parse(m.template_params) : null; } catch (_) {}
        if (params && params.length > 0) {
          const paramRows = params.map((v, i) =>
            `<div style="margin-top:2px"><span style="color:#6b7280;font-size:0.75rem">{{${i+1}}}</span> ${escHtml(String(v))}</div>`
          ).join('');
          fullContent = `<div style="font-weight:500">${escHtml(tplLabel)}</div>${paramRows}`;
        } else {
          fullContent = `<div style="font-weight:500">${escHtml(tplLabel)}</div><div style="color:#6b7280;font-size:0.75rem;margin-top:2px">No parameter values recorded</div>`;
        }
      } else {
        preview = m.message_text || 'Free-form message';
        fullContent = escHtml(m.message_text || 'Free-form message');
      }

      return `
        <div class="comment-item" style="margin-bottom:6px;cursor:pointer" onclick="(function(el){var x=el.querySelector('.wa-full');var p=el.querySelector('.wa-preview');var t=el.querySelector('.wa-toggle');if(x.style.display==='none'){x.style.display='';p.style.display='none';t.textContent='▲';}else{x.style.display='none';p.style.display='';t.textContent='▼';}})(this)">
          <div class="comment-meta">
            <span class="comment-author">${escHtml(senderName)}</span>
            ${dateStr ? `<span class="comment-meta-sep">·</span><span class="comment-date">${escHtml(dateStr)}</span>` : ''}
            <span class="comment-meta-sep">·</span>
            <span style="font-size:0.75rem;background:#dcfce7;color:#15803d;border-radius:4px;padding:1px 6px;font-weight:500">WhatsApp</span>
            <span class="wa-toggle" style="margin-left:auto;font-size:0.65rem;color:#9ca3af;padding-left:6px">▼</span>
          </div>
          <div class="comment-text wa-preview" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(preview)}</div>
          <div class="wa-full" style="display:none;white-space:pre-wrap;font-size:0.85rem;line-height:1.5;padding-top:2px">${fullContent}</div>
        </div>
      `;
    }).join('');
  } catch (_) {
    el.innerHTML = '';
  }
}

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
  const address    = contact?.properties?.address || '';
  const city       = contact?.properties?.city  || '';
  const zip        = contact?.properties?.zip   || '';
  const customerNum = contact?.properties?.customer_number || '';
  const stageKey   = state.workflowData?.stageKey || 'sales';
  const colour     = stageColour(stageKey);
  const stageLabel = state.workflow?.stages?.[stageKey]?.label || stageKey;

  const cityLine = [city, zip].filter(Boolean).join(' ');

  const leadStatusHtml = (() => {
    const raw = contact?.properties?.hs_lead_status || '';
    const CSS_CLASS_MAP = {
      'OPEN_DEAL':            'lsb-open-deal',
      'NEW':                  'lsb-new',
      'IN_PROGRESS':          'lsb-in-progress',
      'OPEN':                 'lsb-new',
      'CONNECTED':            'lsb-connected',
      'ATTEMPTED_TO_CONTACT': '',
      'UNQUALIFIED':          'lsb-unqualified',
      'BAD_TIMING':           'lsb-bad-timing',
    };
    const cid = state.selectedContactId || contact?.id || '';
    const editable = canEditPipeline();
    let pillHtml;
    if (!raw) {
      const nullLabel = (typeof NULL_LEAD_STATUS_LABEL !== 'undefined' ? NULL_LEAD_STATUS_LABEL : null) || 'No status';
      pillHtml = editable
        ? `<span class="lead-status-badge lsb-empty" title="Set lead status" onclick="openLeadStatusPicker(event,'${cid}',{showSubstatuses:true})">${escHtml(nullLabel)}</span>`
        : `<span class="lead-status-badge lsb-empty">${escHtml(nullLabel)}</span>`;
    } else {
      const cls = CSS_CLASS_MAP[raw] || '';
      const currentSub = (typeof _currentSubstatusFor === 'function') ? _currentSubstatusFor(contact) : null;
      let displayLabel;
      let titleText;
      if (currentSub) {
        const parentOpt = LEAD_STATUS_OPTIONS.find(o => o.value === raw);
        const parentLabel = parentOpt ? parentOpt.label : raw.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
        displayLabel = `${escHtml(currentSub.label)}<span class="ls-pill-parent">${escHtml(parentLabel)}</span>`;
        titleText = 'Change lead status / sub-status';
      } else {
        const opt = LEAD_STATUS_OPTIONS.find(o => o.value === raw);
        displayLabel = escHtml(opt ? opt.label : raw.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()));
        titleText = 'Change lead status';
      }
      pillHtml = editable
        ? `<span class="lead-status-badge ${cls} lsb-clickable" title="${titleText}" onclick="openLeadStatusPicker(event,'${cid}',{showSubstatuses:true})">${displayLabel}</span>`
        : `<span class="lead-status-badge ${cls}">${displayLabel}</span>`;
    }
    return pillHtml;
  })();

  el.innerHTML = `
    <div class="customer-header-wrap" style="max-width:1100px;margin:0 auto;">
      <div class="flex items-start justify-between gap-6 flex-wrap">
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
          ${(address || cityLine) ? `<div class="mt-3 space-y-0.5">
            ${address  ? `<div class="text-sm text-slate-500">${escHtml(address)}</div>` : ''}
            ${cityLine ? `<div class="text-sm text-slate-500">${escHtml(cityLine)}</div>` : ''}
          </div>` : ''}
          ${(email || phone) ? `<div class="mt-3 space-y-1">
            ${email ? `<div><a href="mailto:${escHtml(email)}" class="text-sm text-blue-600 hover:underline">${escHtml(email)}</a></div>` : ''}
            ${phone ? `<div class="text-sm text-slate-500 flex items-center gap-1.5">
              <span>${escHtml(phone)}</span>
              ${state.whatsappEnabled ? `<button onclick="openWhatsAppModal()" title="Send WhatsApp message" data-viewer-hide
                style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#25D366;border:none;cursor:pointer;flex-shrink:0;padding:0;vertical-align:middle">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
              </button>` : ''}
            </div>` : ''}
          </div>` : ''}
        </div>
        <div class="flex flex-wrap items-center justify-end gap-2 shrink-0">
          <span class="text-xs font-semibold px-2.5 py-1 rounded-full"
                style="background:${colour.light};color:${colour.text}">${escHtml(stageLabel)}</span>
          ${leadStatusHtml}
        </div>
      </div>
    </div>
  `;
}

// ── Workflow Stages ───────────────────────────────────────────────────────────
// Implementation registered with core.js via registerWorkflowStagesRenderer below.
// The customer-detail tracker is driven by the admin-configured lead statuses
// (loaded from /api/lead-statuses via workflow-core's loadLeadStatuses). Each
// rail entry corresponds to one lead status; its checklist rows are the
// sub-statuses (loaded via /api/lead-substatuses).
//
// Cold-start / empty-config handling:
//   1. /api/lead-statuses hasn't responded yet → keep the existing skeleton
//      so we don't flash the seeded NEW/OPEN/IN_PROGRESS defaults (they may
//      not match the admin's real config). On subsequent renders before the
//      fetch resolves, render an empty wrapper so the panel isn't blank.
//   2. Loaded but the admin has no visible lead statuses → render an
//      explanatory empty state pointing to the admin tab.
//   3. Loaded with visible entries → drive the rail from them.
function _renderWorkflowStagesImpl() {
  const el = document.getElementById('workflow-stages');
  if (!el) return;

  const loaded = (typeof LEAD_STATUSES_LOADED !== 'undefined' && LEAD_STATUSES_LOADED);
  const rail = loaded
    ? (typeof LEAD_STATUS_OPTIONS !== 'undefined' ? LEAD_STATUS_OPTIONS : [])
        .filter(o => !o.excluded_from_sales)
    : [];

  if (!loaded) {
    // Cold start / API 503 — keep the skeleton if it's still in the DOM,
    // otherwise leave the panel empty until the fetch resolves.
    if (el.querySelector('.skeleton-stage-row')) return;
    el.innerHTML = '';
    return;
  }
  if (rail.length === 0) {
    el.innerHTML = `<div class="ls-empty-tasks" style="padding:1rem;text-align:center;color:var(--ink-3)">
      No lead statuses configured. An admin can add them in Settings → Lead statuses.
    </div>`;
    return;
  }

  const contact     = state.selectedContact || null;
  const props       = contact?.properties || {};
  const currentLs   = String(props.hs_lead_status || '').toUpperCase();
  const currentSub  = String(props.hw_lead_substatus || '');
  const currentIdx  = rail.findIndex(e => String(e.value).toUpperCase() === currentLs);

  // Resolve / clamp the focused entry.
  let focusedValue = state.focusedLeadStatus;
  if (!focusedValue || !rail.find(e => e.value === focusedValue)) {
    focusedValue = currentIdx !== -1 ? rail[currentIdx].value : rail[0].value;
    state.focusedLeadStatus = focusedValue;
  }
  const focusedIdx    = rail.findIndex(e => e.value === focusedValue);
  const focusedEntry  = rail[focusedIdx];
  const focusedColour = STAGE_COLOURS[focusedIdx % STAGE_COLOURS.length] || STAGE_COLOURS[0];

  const isFocusedCurrent = focusedIdx === currentIdx;
  const isFocusedPast    = currentIdx !== -1 && focusedIdx < currentIdx;
  const isFocusedFuture  = currentIdx === -1 || focusedIdx > currentIdx;

  const canEdit = canEditPipeline();

  // Sub-statuses for the focused entry, in admin order.
  const allSubs = (typeof LEAD_SUBSTATUSES !== 'undefined' ? LEAD_SUBSTATUSES : []);
  const focusedSubs = allSubs
    .filter(s => String(s.status_key).toUpperCase() === String(focusedValue).toUpperCase())
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  // The currently-ticked sub-status key (only meaningful when the focused
  // entry IS the contact's current lead status — sub-status belongs to one LS).
  const focusPrefix    = `${String(focusedValue).toUpperCase()}__`;
  const tickedSubKey   = isFocusedCurrent && currentSub.toUpperCase().startsWith(focusPrefix)
    ? currentSub.slice(focusPrefix.length).toUpperCase()
    : '';

  // ── Vertical numbered rail ─────────────────────────────────────────────────
  const railHtml = rail.map((entry, i) => {
    const colour    = STAGE_COLOURS[i % STAGE_COLOURS.length] || STAGE_COLOURS[0];
    const isCurrent = i === currentIdx;
    const isPast    = currentIdx !== -1 && i < currentIdx;
    const isFocused = entry.value === focusedValue;

    let badge;
    if (isPast) {
      badge = `<div class="ls-rail-badge ls-rail-badge-done" style="background:${colour.bg};border-color:${colour.bg}">
        <svg width="11" height="9" fill="none" stroke="#fff" viewBox="0 0 12 10" aria-hidden="true">
          <polyline points="1,5 4.5,8.5 11,1" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>`;
    } else if (isCurrent) {
      badge = `<div class="ls-rail-badge ls-rail-badge-current" style="background:${colour.bg};border-color:${colour.bg};color:#fff">${i + 1}</div>`;
    } else {
      badge = `<div class="ls-rail-badge ls-rail-badge-future">${i + 1}</div>`;
    }

    const labelStyle = isCurrent
      ? `color:${colour.text};font-weight:700`
      : isPast
        ? 'color:var(--ink-2);font-weight:600'
        : 'color:var(--ink-3);font-weight:500';

    const focusStyle = isFocused ? `--ls-focus-bg:${colour.bg};--ls-focus-tint:${colour.light}` : '';

    return `<div class="ls-rail-item ${isFocused ? 'ls-rail-item-focused' : ''} ${isPast ? 'ls-rail-item-past' : ''} ${isCurrent ? 'ls-rail-item-current' : ''}"
              role="listitem"
              data-action="setFocusedLeadStatus" data-value="${escHtml(entry.value)}"
              style="${focusStyle}"
              title="${escHtml(entry.label)}">
        ${badge}
        <span class="ls-rail-label" style="${labelStyle}">${escHtml(entry.label)}</span>
      </div>`;
  }).join('');

  // ── Task rows (sub-statuses) ───────────────────────────────────────────────
  let tasksHtml;
  if (focusedSubs.length === 0) {
    tasksHtml = `<div class="ls-empty-tasks">No sub-statuses configured for this stage.</div>`;
  } else {
    tasksHtml = focusedSubs.map(s => {
      const subKey  = String(s.substatus_key).toUpperCase();
      const done    = subKey === tickedSubKey;
      const checkBg = done ? `background:${focusedColour.bg};border-color:${focusedColour.bg}` : '';
      const tick    = done ? `<svg width="10" height="8" fill="none" stroke="#fff" viewBox="0 0 12 10" aria-hidden="true">
          <polyline points="1,5 4.5,8.5 11,1" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>` : '';
      if (!canEdit) {
        return `<div class="status-task-row ${done ? 'status-task-done' : ''}" style="cursor:default;pointer-events:none">
          <div class="status-task-check ${done ? 'status-task-check-done' : ''}" style="${checkBg}">${tick}</div>
          <div class="status-text">
            <span class="status-label ${done ? 'status-label-done' : ''}">${escHtml(s.label)}</span>
          </div>
        </div>`;
      }
      return `<div class="status-task-row ${done ? 'status-task-done' : ''}"
           data-action="setLeadSubstatusChecked"
           data-status-value="${escHtml(focusedValue)}"
           data-substatus-key="${escHtml(subKey)}"
           data-checked="${!done}">
        <div class="status-task-check ${done ? 'status-task-check-done' : ''}" style="${checkBg}">${tick}</div>
        <div class="status-text">
          <span class="status-label ${done ? 'status-label-done' : ''}">${escHtml(s.label)}</span>
        </div>
      </div>`;
    }).join('');
  }

  // ── Card-action label strip (mirrors Sales/Survey card actions) ────────────
  let actionHtml = '';
  {
    const leadKey  = focusedValue || '';
    const hwSubVal = isFocusedCurrent ? currentSub : '';
    const stageKeyForAction = (focusedEntry?.stage && LS_STAGE_TO_KEY[focusedEntry.stage]) || '';
    let label = '';
    if (typeof substatusActionLabelLookup === 'function') {
      label = substatusActionLabelLookup(leadKey, hwSubVal) || '';
    }
    if (!label && stageKeyForAction && typeof stageOrLeadStatusActionLabel === 'function') {
      label = stageOrLeadStatusActionLabel(stageKeyForAction, leadKey, '') || '';
    }
    if (label) {
      const actionTint = focusedColour.light || '#f3f4f6';
      const actionText = focusedColour.text  || '#374151';
      const handlerAttrs = (typeof cardActionHandlerAttrs === 'function')
        ? cardActionHandlerAttrs(stageKeyForAction, leadKey, hwSubVal, {
            contactId:    contact?.id,
            contactName:  (typeof contactName === 'function' ? contactName(contact || {}) : ''),
            contactEmail: props.email || '',
          })
        : '';
      const _cahNameMatch = handlerAttrs && handlerAttrs.match(/data-card-action-name="([^"]*)"/);
      const _cahName = _cahNameMatch ? _cahNameMatch[1].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '';
      const _stripLabel = _cahName || label;
      const interactiveAttrs = handlerAttrs
        ? `${handlerAttrs} role="button" tabindex="0" title="Run action" style="background:${actionTint};cursor:pointer"`
        : `style="background:${actionTint}"`;
      actionHtml = `
        <div class="eq-card-action" ${interactiveAttrs}>
          <span class="eq-card-action-label" style="color:${actionText}">${escHtml(_stripLabel)}</span>
        </div>`;
    }
  }

  const hasPrev = focusedIdx > 0;
  const hasNext = focusedIdx < rail.length - 1;

  el.innerHTML = `
    <div class="ls-tracker">
      <div class="ls-rail" role="list">${railHtml}</div>
      <div class="ls-panel" style="border-top:3px solid ${focusedColour.bg}">
        <div class="stage-panel-header">
          <div class="stage-panel-header-row">
            <div class="stage-panel-title-block">
              <div class="stage-panel-name" style="color:${isFocusedFuture ? 'var(--ink-3)' : focusedColour.text}">${escHtml(focusedEntry.label)}</div>
              <div class="stage-panel-meta">
                ${isFocusedCurrent ? `<span class="stage-sublabel">Current stage</span>` : ''}
                ${isFocusedPast    ? `<span class="stage-sublabel">Completed</span>`     : ''}
                ${isFocusedFuture  ? `<span class="stage-sublabel">Upcoming</span>`      : ''}
              </div>
            </div>
            <div class="stage-panel-nav">
              <button class="stage-nav-btn" ${!hasPrev ? 'disabled' : ''} data-action="focusPrevLeadStatus" title="Previous stage">
                <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7"/>
                </svg>
              </button>
              <button class="stage-nav-btn" ${!hasNext ? 'disabled' : ''} data-action="focusNextLeadStatus" title="Next stage">
                <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
        <div class="stage-statuses">${tasksHtml}</div>
        ${actionHtml ? `<div class="stage-panel-actions">${actionHtml}</div>` : ''}
      </div>
    </div>
  `;
}

// Write a sub-status tick back to HubSpot. When ticking a row that belongs to
// a different lead status than the contact's current one, hs_lead_status is
// updated in the same PATCH so the rail's "current" marker follows along.
function setLeadSubstatusChecked(statusValue, substatusKey, checked) {
  if (!canEditPipeline()) return;
  const contact   = state.selectedContact;
  const contactId = contact?.id;
  if (!contactId) return;

  const newLs   = String(statusValue || '').toUpperCase();
  const subKey  = String(substatusKey || '').toUpperCase();
  if (!newLs) return;

  const fullVal = checked ? `${newLs}__${subKey}` : '';
  const prevLs  = String(contact.properties?.hs_lead_status || '').toUpperCase();
  const changeLs = checked && newLs !== prevLs;

  const body = { hw_lead_substatus: fullVal };
  if (changeLs) body.hs_lead_status = newLs;

  // Optimistic local update so the rail/tick reflects the click immediately.
  const prevProps   = { ...(contact.properties || {}) };
  const nextProps   = {
    ...(contact.properties || {}),
    hw_lead_substatus: fullVal,
    ...(changeLs ? { hs_lead_status: newLs } : {}),
  };
  contact.properties = nextProps;
  if (state.selectedContact) state.selectedContact.properties = nextProps;
  const listEntry = state.contacts?.find(c => String(c.id) === String(contactId));
  if (listEntry) listEntry.properties = nextProps;

  if (changeLs) state.focusedLeadStatus = newLs;
  renderWorkflowStages();
  if (typeof renderWorkflowHeader === 'function') renderWorkflowHeader();
  if (typeof renderCustomerList   === 'function') renderCustomerList();

  PATCH_REQ(`/api/contacts/${contactId}`, body)
    .then(() => {
      if (typeof loadLeadStatusCounts === 'function' && changeLs) {
        loadLeadStatusCounts()
          .then(() => { if (typeof populateLeadStatusFilter === 'function') populateLeadStatusFilter(); })
          .catch(() => {});
      }
    })
    .catch(err => {
      contact.properties = prevProps;
      if (state.selectedContact) state.selectedContact.properties = prevProps;
      if (listEntry) listEntry.properties = prevProps;
      renderWorkflowStages();
      if (typeof renderWorkflowHeader === 'function') renderWorkflowHeader();
      if (typeof renderCustomerList   === 'function') renderCustomerList();
      if (err?.code === 'HUBSPOT_AUTH') {
        showToast('Could not update — HubSpot token is invalid or expired.', true);
      } else if (err?.code === 'HUBSPOT_RATE_LIMIT') {
        showToast('Could not update — HubSpot rate limit reached. Please try again.', true);
      } else {
        showToast('Could not update sub-status in HubSpot', true);
      }
    });
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
    await PATCH_REQ(`/api/tasks/${taskId}`, { hs_task_status: newStatus, contactId: state.selectedContactId });
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
    await api('DELETE', `/api/tasks/${taskId}`, { contactId: state.selectedContactId });
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

// ── WhatsApp Modal ────────────────────────────────────────────────────────────
let _waMode = 'template';
let _waTemplates = null; // null = not yet fetched, [] = fetched (may be empty)
let _waTemplatesFetching = false;

function openWhatsAppModal() {
  const phone = state.selectedContact?.properties?.phone || '';
  if (!phone) return;

  const modal = document.getElementById('whatsapp-modal');
  if (!modal) return;

  const toEl = document.getElementById('whatsapp-to');
  if (toEl) toEl.textContent = `To: ${phone}`;

  _waMode = 'template';
  _waApplyTabStyles();
  _waShowPanel('template');
  _waClearFeedback();

  modal.style.display = 'flex';
  modal.classList.remove('hidden');

  _waFetchTemplates();
}

function closeWhatsAppModal() {
  const modal = document.getElementById('whatsapp-modal');
  if (!modal) return;
  modal.style.display = 'none';
  modal.classList.add('hidden');
}

function waSetMode(mode) {
  _waMode = mode;
  _waApplyTabStyles();
  _waShowPanel(mode);
  _waClearFeedback();
}

function _waApplyTabStyles() {
  const tabTemplate = document.getElementById('wa-tab-template');
  const tabFreeform = document.getElementById('wa-tab-freeform');
  if (!tabTemplate || !tabFreeform) return;
  const activeStyle = 'background:#f0fdf4;color:#15803d;';
  const inactiveStyle = 'background:#f8fafc;color:#374151;';
  tabTemplate.style.cssText = `flex:1;padding:8px 0;font-size:0.82rem;font-weight:600;border:none;cursor:pointer;transition:background 0.15s;${_waMode === 'template' ? activeStyle : inactiveStyle}`;
  tabFreeform.style.cssText = `flex:1;padding:8px 0;font-size:0.82rem;font-weight:600;border:none;cursor:pointer;transition:background 0.15s;border-left:1px solid #e2e8f0;${_waMode === 'freeform' ? activeStyle : inactiveStyle}`;
}

function _waShowPanel(mode) {
  const pTemplate = document.getElementById('wa-panel-template');
  const pFreeform = document.getElementById('wa-panel-freeform');
  if (pTemplate) pTemplate.style.display = mode === 'template' ? '' : 'none';
  if (pFreeform) pFreeform.classList.toggle('hidden', mode !== 'freeform');
}

function _waClearFeedback() {
  const errEl = document.getElementById('wa-send-error');
  const okEl  = document.getElementById('wa-send-success');
  if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
  if (okEl)  { okEl.classList.add('hidden'); }
}

async function _waFetchTemplates() {
  if (_waTemplates !== null) {
    _waRenderTemplates(_waTemplates);
    return;
  }
  if (_waTemplatesFetching) return;
  _waTemplatesFetching = true;

  const loadEl  = document.getElementById('wa-templates-loading');
  const errEl   = document.getElementById('wa-templates-error');
  const selEl   = document.getElementById('wa-template-select');
  if (loadEl) loadEl.style.display = '';
  if (errEl)  errEl.classList.add('hidden');
  if (selEl)  selEl.classList.add('hidden');

  try {
    const templates = await GET('/api/whatsapp/templates');
    _waTemplates = templates;
    _waRenderTemplates(templates);
  } catch (e) {
    if (errEl) {
      errEl.textContent = e.message || 'Could not load templates.';
      errEl.classList.remove('hidden');
    }
    if (loadEl) loadEl.style.display = 'none';
  } finally {
    _waTemplatesFetching = false;
  }
}

function _waRenderTemplates(templates) {
  const loadEl = document.getElementById('wa-templates-loading');
  const selEl  = document.getElementById('wa-template-select');
  if (loadEl) loadEl.style.display = 'none';
  if (!selEl) return;

  selEl.innerHTML = '<option value="">— Select a template —</option>' +
    templates.map(t => `<option value="${escHtml(t.name)}" data-lang="${escHtml(t.language || 'en_US')}">${escHtml(t.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))}</option>`).join('');
  selEl.classList.remove('hidden');

  if (templates.length === 0) {
    const errEl = document.getElementById('wa-templates-error');
    if (errEl) {
      errEl.textContent = 'No approved templates found. Templates are managed in Meta Business Manager.';
      errEl.classList.remove('hidden');
    }
  }
}

function waOnTemplateChange() {
  const selEl      = document.getElementById('wa-template-select');
  const previewEl  = document.getElementById('wa-template-preview');
  const paramsEl   = document.getElementById('wa-template-params');
  if (!selEl || !previewEl || !paramsEl) return;

  const name = selEl.value;
  if (!name || !_waTemplates) {
    previewEl.style.display = 'none';
    paramsEl.style.display = 'none';
    return;
  }

  const tpl = _waTemplates.find(t => t.name === name);
  if (!tpl) { previewEl.style.display = 'none'; paramsEl.style.display = 'none'; return; }

  const bodyComp = (tpl.components || []).find(c => c.type === 'BODY');
  if (bodyComp?.text) {
    previewEl.textContent = bodyComp.text;
    previewEl.style.display = '';
  } else {
    previewEl.style.display = 'none';
  }

  const params = bodyComp?.parameters || [];
  if (params.length > 0) {
    paramsEl.style.display = '';
    paramsEl.innerHTML = params.map(p => `
      <div style="margin-bottom:8px">
        <label style="font-size:0.78rem;font-weight:600;color:#374151;display:block;margin-bottom:4px">
          Parameter {{${p.index}}}${p.example ? ` <span style="font-weight:400;color:#9ca3af">e.g. ${escHtml(p.example)}</span>` : ''}
        </label>
        <input type="text" id="wa-param-${p.index}" placeholder="Value for {{${p.index}}}"
          style="width:100%;border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px;font-size:0.875rem;box-sizing:border-box;font-size:16px">
      </div>
    `).join('');
  } else {
    paramsEl.style.display = 'none';
    paramsEl.innerHTML = '';
  }
}

async function waSubmit() {
  const phone = state.selectedContact?.properties?.phone || '';
  if (!phone) return;

  const sendBtn = document.getElementById('wa-send-btn');
  const errEl   = document.getElementById('wa-send-error');
  const okEl    = document.getElementById('wa-send-success');

  _waClearFeedback();
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending…'; }

  let payload = { contactPhone: phone, contactId: state.selectedContactId || undefined, mode: _waMode };

  if (_waMode === 'template') {
    const selEl = document.getElementById('wa-template-select');
    const templateName = selEl?.value;
    if (!templateName) {
      if (errEl) { errEl.textContent = 'Please select a template.'; errEl.classList.remove('hidden'); }
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
      return;
    }
    const selectedOpt = selEl.selectedOptions[0];
    const lang = selectedOpt?.dataset?.lang || 'en_US';
    const tpl  = _waTemplates?.find(t => t.name === templateName);
    const bodyComp = (tpl?.components || []).find(c => c.type === 'BODY');
    const params = bodyComp?.parameters || [];
    const vals = params.map(p => {
      const inp = document.getElementById(`wa-param-${p.index}`);
      return inp ? inp.value.trim() : '';
    });
    payload.templateName = templateName;
    payload.templateLanguage = lang;
    payload.templateParams = vals;
  } else {
    const text = document.getElementById('wa-freeform-text')?.value.trim();
    if (!text) {
      if (errEl) { errEl.textContent = 'Please enter a message.'; errEl.classList.remove('hidden'); }
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
      return;
    }
    payload.message = text;
  }

  try {
    await POST('/api/whatsapp/send', payload);
    if (okEl) okEl.classList.remove('hidden');
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
    setTimeout(() => { closeWhatsAppModal(); renderWhatsAppHistory(); }, 2000);
  } catch (e) {
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
    let msg = e.message || 'Failed to send. Please try again.';
    if (e.code === 'OUTSIDE_WINDOW') {
      msg = 'Outside the 24-hour window — please send a template message instead.';
      waSetMode('template');
    } else if (e.code === 'NOT_ON_WHATSAPP') {
      msg = 'This phone number is not registered on WhatsApp.';
    }
    if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
  }
}

// Close modal on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('whatsapp-modal');
    if (modal && modal.style.display !== 'none') closeWhatsAppModal();
  }
});

// ── Upcoming visits (per-customer) ────────────────────────────────────────────
const VISIT_TYPE_LABELS = {
  design:       'Design visit',
  survey:       'Survey',
  installation: 'Installation',
  remedial:     'Remedial',
  workshop:     'Workshop',
  other:        'Visit',
};

function _fmtVisitWhen(startIso, endIso) {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const datePart = s.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
  const tFmt = d => d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
  return `${datePart} · ${tFmt(s)}–${tFmt(e)}`;
}

async function renderUpcomingVisits() {
  const el = document.getElementById('upcoming-visits-section');
  if (!el) return;
  const contactId = state.selectedContactId;
  if (!contactId) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <div class="notes-header">
      <span class="notes-header-label">Upcoming visits</span>
    </div>
    <div id="upcoming-visits-list" class="text-sm" style="color:var(--stone-deep)">
      <p style="font-size:0.85rem;padding:4px 0;font-style:italic">Loading…</p>
    </div>
  `;

  const from = new Date();
  const to   = new Date(Date.now() + 366 * 24 * 60 * 60 * 1000);
  let visits;
  try {
    visits = await GET(`/api/visits?from=${from.toISOString()}&to=${to.toISOString()}`);
  } catch {
    const list = document.getElementById('upcoming-visits-list');
    if (list) list.innerHTML = `<p style="font-size:0.85rem;color:#b91c1c;padding:4px 0">Could not load visits.</p>`;
    return;
  }

  const cidStr = String(contactId);
  const mine = (visits || [])
    .filter(v => String(v.customerId || '') === cidStr && new Date(v.endAt) > from)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

  const list = document.getElementById('upcoming-visits-list');
  if (!list) return;

  if (!mine.length) {
    list.innerHTML = `<p style="font-size:0.85rem;padding:4px 0;font-style:italic">No upcoming visits scheduled.</p>`;
    return;
  }

  const viewer = isViewerOnly();
  list.innerHTML = mine.map(v => {
    const label = VISIT_TYPE_LABELS[v.type] || 'Visit';
    const when  = _fmtVisitWhen(v.startAt, v.endAt);
    const title = v.title || label;
    return `
      <div class="comment-item" style="margin-bottom:6px;display:flex;align-items:flex-start;gap:8px;justify-content:space-between">
        <div style="flex:1;min-width:0">
          <div class="comment-text" style="font-weight:500">${escHtml(title)}</div>
          <div class="comment-meta" style="margin-top:2px">
            <span style="font-size:0.7rem;background:#ede9fe;color:#6b21a8;border-radius:4px;padding:1px 6px;font-weight:600">${escHtml(label)}</span>
            <span class="comment-meta-sep">·</span>
            <span class="comment-date">${escHtml(when)}</span>
            ${v.location ? `<span class="comment-meta-sep">·</span><span class="comment-date">${escHtml(v.location)}</span>` : ''}
          </div>
          ${v.notes ? `<div class="comment-text" style="font-size:0.8rem;opacity:0.75;white-space:pre-wrap;margin-top:4px">${escHtml(v.notes)}</div>` : ''}
        </div>
        ${viewer ? '' : `
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn-cancel-note" style="padding:4px 10px;font-size:0.75rem" onclick="editUpcomingVisit(${v.id})">Edit</button>
          <button class="btn-cancel-note" style="padding:4px 10px;font-size:0.75rem;color:#b91c1c" onclick="cancelUpcomingVisit(${v.id})">Cancel</button>
        </div>`}
      </div>
    `;
  }).join('');
}

const _pastVisitsExpanded = new Map();

async function renderPastVisits() {
  const el = document.getElementById('past-visits-section');
  if (!el) return;
  const contactId = state.selectedContactId;
  if (!contactId) { el.innerHTML = ''; return; }

  const cidStr = String(contactId);
  const expanded = _pastVisitsExpanded.get(cidStr) === true;

  el.innerHTML = `
    <div class="notes-header" style="cursor:pointer;user-select:none" id="past-visits-toggle">
      <span class="notes-header-label">Past visits</span>
      <span id="past-visits-caret" style="font-size:0.75rem;color:var(--stone-deep);margin-left:6px">${expanded ? '▾' : '▸'}</span>
    </div>
    <div id="past-visits-list" class="text-sm" style="color:var(--stone-deep);${expanded ? '' : 'display:none'}">
      <p style="font-size:0.85rem;padding:4px 0;font-style:italic">Loading…</p>
    </div>
  `;

  const toggle = document.getElementById('past-visits-toggle');
  toggle.addEventListener('click', () => {
    const next = !(_pastVisitsExpanded.get(cidStr) === true);
    _pastVisitsExpanded.set(cidStr, next);
    renderPastVisits();
  });

  if (!expanded) return;

  const now = new Date();
  const from = new Date(Date.now() - 366 * 24 * 60 * 60 * 1000);
  let visits;
  try {
    visits = await GET(`/api/visits?from=${from.toISOString()}&to=${now.toISOString()}`);
  } catch {
    const list = document.getElementById('past-visits-list');
    if (list) list.innerHTML = `<p style="font-size:0.85rem;color:#b91c1c;padding:4px 0">Could not load visits.</p>`;
    return;
  }

  const mine = (visits || [])
    .filter(v => String(v.customerId || '') === cidStr && new Date(v.endAt) < now)
    .sort((a, b) => new Date(b.startAt) - new Date(a.startAt));

  const list = document.getElementById('past-visits-list');
  if (!list) return;

  if (!mine.length) {
    list.innerHTML = `<p style="font-size:0.85rem;padding:4px 0;font-style:italic">No past visits in the last year.</p>`;
    return;
  }

  list.innerHTML = mine.map(v => {
    const label = VISIT_TYPE_LABELS[v.type] || 'Visit';
    const when  = _fmtVisitWhen(v.startAt, v.endAt);
    const title = v.title || label;
    return `
      <div class="comment-item" style="margin-bottom:6px">
        <div style="flex:1;min-width:0">
          <div class="comment-text" style="font-weight:500">${escHtml(title)}</div>
          <div class="comment-meta" style="margin-top:2px">
            <span style="font-size:0.7rem;background:#e5e7eb;color:#374151;border-radius:4px;padding:1px 6px;font-weight:600">${escHtml(label)}</span>
            <span class="comment-meta-sep">·</span>
            <span class="comment-date">${escHtml(when)}</span>
            ${v.location ? `<span class="comment-meta-sep">·</span><span class="comment-date">${escHtml(v.location)}</span>` : ''}
          </div>
          ${v.notes ? `<div class="comment-text" style="font-size:0.8rem;opacity:0.75;white-space:pre-wrap;margin-top:4px">${escHtml(v.notes)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// ── Design Visits ─────────────────────────────────────────────────────────────
const DESIGN_VISIT_STATUS_LABELS = {
  draft:               { label: 'Draft',              bg: '#fef3c7', fg: '#92400e' },
  submitted:           { label: 'Submitted',          bg: '#dbeafe', fg: '#1e40af' },
  signed_off:          { label: 'Signed off',         bg: '#dcfce7', fg: '#166534' },
  revision_requested:  { label: 'Revision requested', bg: '#fee2e2', fg: '#991b1b' },
};

function _fmtDesignVisitWhen(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch { return '—'; }
}

async function renderDesignVisits() {
  const el = document.getElementById('design-visits-section');
  if (!el) return;
  const contactId = state.selectedContactId;
  if (!contactId) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <div class="notes-header">
      <span class="notes-header-label">Design visits</span>
    </div>
    <div id="design-visits-list" class="text-sm" style="color:var(--stone-deep)">
      <p style="font-size:0.85rem;padding:4px 0;font-style:italic">Loading…</p>
    </div>
  `;

  let visits;
  try {
    visits = await GET(`/api/design-visits?contactId=${encodeURIComponent(contactId)}`);
  } catch {
    const list = document.getElementById('design-visits-list');
    if (list) list.innerHTML = `<p style="font-size:0.85rem;color:#b91c1c;padding:4px 0">Could not load design visits.</p>`;
    return;
  }

  const list = document.getElementById('design-visits-list');
  if (!list) return;

  if (!visits || !visits.length) {
    list.innerHTML = `<p style="font-size:0.85rem;padding:4px 0;font-style:italic">No design visits yet.</p>`;
    return;
  }

  const isAdmin = state.user?.privilege_level === 'admin';

  list.innerHTML = visits.map(v => {
    const st = DESIGN_VISIT_STATUS_LABELS[v.status] || { label: v.status || 'Unknown', bg: '#e5e7eb', fg: '#374151' };
    const when     = _fmtDesignVisitWhen(v.visit_date || v.created_at);
    const totalGbp = ((Number(v.estimate_total_pence) || 0) / 100).toFixed(2);
    const canRevise  = v.status === 'submitted' || v.status === 'signed_off';
    const expanded = _designVisitsExpanded.has(v.id);
    return `
      <div class="comment-item" style="margin-bottom:6px;flex-direction:column;align-items:stretch;gap:6px">
        <div style="display:flex;align-items:flex-start;gap:8px;justify-content:space-between">
          <div style="flex:1;min-width:0">
            <div class="comment-text" style="font-weight:500">${escHtml(when)}</div>
            <div class="comment-meta" style="margin-top:2px">
              <span style="font-size:0.7rem;background:${st.bg};color:${st.fg};border-radius:4px;padding:1px 6px;font-weight:600">${escHtml(st.label)}</span>
              <span class="comment-meta-sep">·</span>
              <span class="comment-date">Estimate: £${escHtml(totalGbp)}</span>
              ${v.qb_estimate_doc_num ? `<span class="comment-meta-sep">·</span><span class="comment-date">QB #${escHtml(v.qb_estimate_doc_num)}</span>` : ''}
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end">
            <button class="btn-cancel-note" style="padding:4px 10px;font-size:0.75rem" onclick="toggleDesignVisitReview(${v.id})">${expanded ? 'Hide' : 'Review'}</button>
            ${isAdmin && canRevise ? `<button class="btn-cancel-note" style="padding:4px 10px;font-size:0.75rem" onclick="markDesignVisitRevision(${v.id})">Request revision</button>` : ''}
            ${isAdmin ? `<button class="btn-cancel-note" style="padding:4px 10px;font-size:0.75rem;color:#b91c1c" onclick="deleteDesignVisit(${v.id})">Delete</button>` : ''}
          </div>
        </div>
        ${expanded ? `<div id="design-visit-detail-${v.id}" style="font-size:0.8rem;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px">Loading…</div>` : ''}
      </div>
    `;
  }).join('');

  for (const id of _designVisitsExpanded) {
    if (visits.find(v => v.id === id)) _loadDesignVisitDetail(id);
  }
}

const _designVisitsExpanded = new Set();

async function toggleDesignVisitReview(id) {
  if (_designVisitsExpanded.has(id)) _designVisitsExpanded.delete(id);
  else _designVisitsExpanded.add(id);
  renderDesignVisits();
}

async function _loadDesignVisitDetail(id) {
  const el = document.getElementById(`design-visit-detail-${id}`);
  if (!el) return;
  let v;
  try { v = await GET(`/api/design-visits/${id}`); }
  catch (e) { el.innerHTML = `<span style="color:#b91c1c">Could not load: ${escHtml(e.message || '')}</span>`; return; }

  const rows = (v.rooms || []).map(r => {
    const total = (Number(r.unit_price_pence) || 0) * (Number(r.unit_count) || 0);
    const dims = [r.width_mm, r.height_mm, r.depth_mm].filter(Boolean).join(' × ');
    return `
      <tr>
        <td style="padding:4px 8px;border-top:1px solid #e2e8f0">${escHtml(r.room_name || '')}</td>
        <td style="padding:4px 8px;border-top:1px solid #e2e8f0">${escHtml(r.door_style_name || '—')}</td>
        <td style="padding:4px 8px;border-top:1px solid #e2e8f0">${dims ? escHtml(dims + ' mm') : '—'}</td>
        <td style="padding:4px 8px;border-top:1px solid #e2e8f0;text-align:right">${r.unit_count}</td>
        <td style="padding:4px 8px;border-top:1px solid #e2e8f0;text-align:right">£${(total / 100).toFixed(2)}</td>
      </tr>
    `;
  }).join('');
  const grand = (v.rooms || []).reduce((s, r) => s + (Number(r.unit_price_pence) || 0) * (Number(r.unit_count) || 0), 0);

  el.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px;color:#475569">
      ${v.handle_name         ? `<span><strong>Handle:</strong> ${escHtml(v.handle_name)}</span>` : ''}
      ${v.furniture_range_name ? `<span><strong>Furniture range:</strong> ${escHtml(v.furniture_range_name)}</span>` : ''}
      ${v.location            ? `<span><strong>Location:</strong> ${escHtml(v.location)}</span>` : ''}
    </div>
    ${(v.rooms || []).length ? `
      <table style="width:100%;border-collapse:collapse;font-size:0.78rem">
        <thead>
          <tr style="background:#f1f5f9;color:#475569">
            <th style="text-align:left;padding:4px 8px">Room</th>
            <th style="text-align:left;padding:4px 8px">Style</th>
            <th style="text-align:left;padding:4px 8px">Dimensions</th>
            <th style="text-align:right;padding:4px 8px">Qty</th>
            <th style="text-align:right;padding:4px 8px">Total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><td colspan="4" style="padding:6px 8px;font-weight:600;border-top:2px solid #cbd5e1">Estimate total</td>
              <td style="padding:6px 8px;font-weight:600;text-align:right;border-top:2px solid #cbd5e1">£${(grand / 100).toFixed(2)}</td></tr>
        </tfoot>
      </table>
    ` : `<p style="font-style:italic;color:#64748b">No rooms recorded.</p>`}
    ${v.notes          ? `<div style="margin-top:8px;white-space:pre-wrap"><strong>Notes:</strong> ${escHtml(v.notes)}</div>` : ''}
    ${v.revision_note  ? `<div style="margin-top:8px;white-space:pre-wrap;color:#991b1b"><strong>Revision note:</strong> ${escHtml(v.revision_note)}</div>` : ''}
  `;
}

async function markDesignVisitRevision(id) {
  if (state.user?.privilege_level !== 'admin') return;
  const note = prompt('Revision note (optional):', '');
  if (note === null) return;
  try {
    await POST(`/api/design-visits/${id}/revision`, { revisionNote: note });
    showToast('Visit marked for revision');
    renderDesignVisits();
  } catch (e) {
    showToast(`Could not mark for revision: ${e.message || 'error'}`, true);
  }
}

async function deleteDesignVisit(id) {
  if (state.user?.privilege_level !== 'admin') return;
  if (!confirm('Delete this design visit? This cannot be undone.')) return;
  try {
    await DELETE_REQ(`/api/design-visits/${id}`);
    showToast('Design visit deleted');
    renderDesignVisits();
  } catch (e) {
    showToast(`Could not delete: ${e.message || 'error'}`, true);
  }
}

function _toLocalDtInput(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function editUpcomingVisit(id) {
  if (isViewerOnly()) return;
  let visits;
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to   = new Date(Date.now() + 366 * 24 * 60 * 60 * 1000);
  try {
    visits = await GET(`/api/visits?from=${from.toISOString()}&to=${to.toISOString()}`);
  } catch { showToast('Could not load visit', true); return; }
  const v = (visits || []).find(x => x.id === id);
  if (!v) { showToast('Visit not found', true); return; }

  if (!state.platformUsers || !state.platformUsers.length) {
    try { state.platformUsers = await GET('/api/platform-users'); }
    catch { state.platformUsers = []; }
  }

  const startDef = _toLocalDtInput(new Date(v.startAt));
  const duration = Math.max(5, Math.round((new Date(v.endAt) - new Date(v.startAt)) / 60000));
  const label    = VISIT_TYPE_LABELS[v.type] || 'Visit';
  const roleOptions = ['designer','surveyor','fitter','manager'].map(r => {
    const sel = v.assigneeRole === r ? 'selected' : '';
    return `<option value="${r}" ${sel}>${r.charAt(0).toUpperCase()+r.slice(1)}</option>`;
  }).join('');
  const userOptions = (state.platformUsers || []).map(u => {
    const name = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email;
    const sel = v.assigneeId === u.id ? 'selected' : '';
    return `<option value="${escHtml(u.id)}" ${sel}>${escHtml(name)}</option>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px 22px;width:100%;max-width:460px;box-shadow:0 20px 60px rgba(0,0,0,0.25);font-family:inherit">
      <h3 style="margin:0 0 14px;font-size:1.05rem;font-weight:700;color:#1f2937">Edit ${escHtml(label)}</h3>
      <label style="display:block;font-size:0.78rem;color:#4b5563;margin:8px 0 4px;font-weight:600">Title</label>
      <input id="uv-title" type="text" maxlength="120" value="${escHtml(v.title || '')}" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:0.92rem;box-sizing:border-box">
      <div style="display:flex;gap:10px">
        <div style="flex:1">
          <label style="display:block;font-size:0.78rem;color:#4b5563;margin:8px 0 4px;font-weight:600">Start</label>
          <input id="uv-start" type="datetime-local" value="${escHtml(startDef)}" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:0.92rem;box-sizing:border-box">
        </div>
        <div style="flex:1">
          <label style="display:block;font-size:0.78rem;color:#4b5563;margin:8px 0 4px;font-weight:600">Duration (min)</label>
          <input id="uv-duration" type="number" min="5" max="1440" step="5" value="${duration}" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:0.92rem;box-sizing:border-box">
        </div>
      </div>
      <label style="display:block;font-size:0.78rem;color:#4b5563;margin:8px 0 4px;font-weight:600">Location</label>
      <input id="uv-location" type="text" maxlength="300" value="${escHtml(v.location || '')}" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:0.92rem;box-sizing:border-box">
      <div style="display:flex;gap:10px">
        <div style="flex:1">
          <label style="display:block;font-size:0.78rem;color:#4b5563;margin:8px 0 4px;font-weight:600">Assigned role</label>
          <select id="uv-assignee-role" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:0.92rem;box-sizing:border-box">
            <option value="">— None —</option>
            ${roleOptions}
          </select>
        </div>
        <div style="flex:1">
          <label style="display:block;font-size:0.78rem;color:#4b5563;margin:8px 0 4px;font-weight:600">Assigned to</label>
          <select id="uv-assignee-id" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:0.92rem;box-sizing:border-box">
            <option value="">— None —</option>
            ${userOptions}
          </select>
        </div>
      </div>
      <label style="display:block;font-size:0.78rem;color:#4b5563;margin:8px 0 4px;font-weight:600">Notes</label>
      <textarea id="uv-notes" maxlength="4000" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:0.92rem;box-sizing:border-box;resize:vertical;min-height:90px">${escHtml(v.notes || '')}</textarea>
      <div id="uv-error" style="color:#b91c1c;font-size:0.82rem;margin-top:8px;min-height:18px"></div>
      <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end">
        <button id="uv-cancel" type="button" style="padding:8px 16px;border-radius:8px;border:none;font-size:0.88rem;font-weight:600;cursor:pointer;background:#f3f4f6;color:#374151">Cancel</button>
        <button id="uv-save" type="button" style="padding:8px 16px;border-radius:8px;border:none;font-size:0.88rem;font-weight:600;cursor:pointer;background:#8B2BFF;color:#fff">Save</button>
      </div>
    </div>
  `;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  overlay.querySelector('#uv-cancel').addEventListener('click', () => overlay.remove());

  const saveBtn = overlay.querySelector('#uv-save');
  saveBtn.addEventListener('click', async () => {
    const errEl = overlay.querySelector('#uv-error');
    errEl.textContent = '';
    const titleV    = overlay.querySelector('#uv-title').value.trim();
    const startV    = overlay.querySelector('#uv-start').value;
    const durationV = parseInt(overlay.querySelector('#uv-duration').value, 10);
    const locationV = overlay.querySelector('#uv-location').value.trim();
    const notesV    = overlay.querySelector('#uv-notes').value.trim();
    const roleV     = overlay.querySelector('#uv-assignee-role').value || null;
    const userV     = overlay.querySelector('#uv-assignee-id').value || null;
    if (!startV) { errEl.textContent = 'Start time is required.'; return; }
    if (!Number.isInteger(durationV) || durationV < 5) { errEl.textContent = 'Duration must be ≥ 5 minutes.'; return; }
    const start = new Date(startV);
    const end   = new Date(start.getTime() + durationV * 60000);
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      await PATCH_REQ(`/api/visits/${id}`, {
        type:         v.type,
        title:        titleV || null,
        customerId:   v.customerId || null,
        customerName: v.customerName || null,
        startAt:      start.toISOString(),
        endAt:        end.toISOString(),
        location:     locationV || null,
        notes:        notesV    || null,
        assigneeId:   userV,
        assigneeRole: roleV,
      });
      overlay.remove();
      showToast('Visit updated');
      renderUpcomingVisits();
    } catch (e) {
      saveBtn.disabled = false; saveBtn.textContent = 'Save';
      errEl.textContent = 'Could not save: ' + (e.message || 'error');
    }
  });
}

async function cancelUpcomingVisit(id) {
  if (isViewerOnly()) return;
  if (!confirm('Cancel this visit?')) return;
  try {
    await DELETE_REQ(`/api/visits/${id}`);
    showToast('Visit cancelled');
    renderUpcomingVisits();
  } catch {
    showToast('Failed to cancel visit', true);
  }
}

// ── Register implementations with core.js dispatchers ─────────────────────────
registerRoomTabsRenderer(_renderRoomTabsImpl);
registerWorkflowHeaderRenderer(_renderWorkflowHeaderImpl);
registerWorkflowStagesRenderer(_renderWorkflowStagesImpl);
registerWorkflowDataSaver(_saveWorkflowDataImpl);

