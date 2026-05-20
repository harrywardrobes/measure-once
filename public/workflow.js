// ── New Customer Modal ────────────────────────────────────────────────────────
function openNewCustomerModal() {
  if (isViewerOnly()) return;
  const overlay = document.getElementById('new-customer-overlay');
  const modal   = document.getElementById('new-customer-modal');
  const form    = document.getElementById('new-customer-form');
  const err     = document.getElementById('nc-error');
  if (form)    form.reset();
  if (err)     { err.style.display = 'none'; err.textContent = ''; }
  if (overlay) { overlay.classList.remove('hidden'); }
  if (modal)   { modal.style.display = 'flex'; modal.classList.remove('hidden'); }
  setTimeout(() => document.getElementById('nc-firstname')?.focus(), 50);
}

function closeNewCustomerModal() {
  const overlay = document.getElementById('new-customer-overlay');
  const modal   = document.getElementById('new-customer-modal');
  if (overlay) overlay.classList.add('hidden');
  if (modal)   { modal.style.display = 'none'; modal.classList.add('hidden'); }
}

async function submitNewCustomer(ev) {
  ev.preventDefault();
  const firstname = document.getElementById('nc-firstname')?.value.trim();
  const lastname  = document.getElementById('nc-lastname')?.value.trim();
  const email     = document.getElementById('nc-email')?.value.trim();
  const phone     = document.getElementById('nc-phone')?.value.trim();
  const postcode  = document.getElementById('nc-postcode')?.value.trim();
  const errEl     = document.getElementById('nc-error');
  const submitBtn = document.getElementById('nc-submit');

  const showError = msg => {
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
  };

  if (!firstname) { showError('First name is required.'); return; }
  if (!email)     { showError('Email is required.'); return; }
  if (!postcode)  { showError('Postcode is required.'); return; }

  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Creating…'; }

  try {
    const contact = await POST('/api/contacts', { firstname, lastname, email, phone, postcode });

    // Insert into local state so it appears immediately, then refresh from server for correct sort order
    state.contacts.unshift(contact);
    state.filteredContacts = [...state.contacts];
    closeNewCustomerModal();
    renderCustomerList();
    const customerNum = contact.properties?.customer_number;
    showToast(`Customer created${customerNum ? ` — ${customerNum}` : ''}`);
    // Background refresh to pick up server sort order (respect current view mode)
    const refreshLoader = (state.contactsViewMode === 'all') ? loadAllContacts() : loadOpenLeads();
    refreshLoader.then(() => { state.filteredContacts = [...state.contacts]; if (state.contactsViewMode === 'all') populateLeadStatusFilter(); renderCustomerList(); }).catch(() => {});
  } catch (e) {
    if (e.code === 'HUBSPOT_AUTH') {
      showError('HubSpot token is invalid or expired — ask an admin to update the token.');
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showError('HubSpot rate limit reached — please wait a moment and try again.');
    } else {
      showError(e.message || 'Failed to create customer.');
    }
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Create Customer'; }
  }
}

// ── Build List Items ──────────────────────────────────────────────────────────
function buildListItems() {
  const items = [];
  for (const contact of state.filteredContacts) {
    // Apply lead-status filter (only relevant in "all" view)
    if (state.leadStatusFilter) {
      const ls = contact.properties?.hs_lead_status || '';
      if (ls !== state.leadStatusFilter) continue;
    }

    const cached = state.contactStageCache[contact.id];
    if (cached && cached.length > 0) {
      cached.forEach((r, idx) => {
        const roomStatus = r.roomStatus || 'active';
        if (roomStatus !== 'active' && !state.showArchived) return;
        if (state.stageFilter && r.stageKey !== state.stageFilter) return;
        items.push({ contact, roomIdx: idx, roomName: r.room, stageKey: r.stageKey, roomStatus });
      });
    } else {
      // No local data yet — default to Sales
      if (!state.stageFilter || state.stageFilter === 'sales') {
        items.push({ contact, roomIdx: 0, roomName: null, stageKey: 'sales', roomStatus: 'active' });
      }
    }
  }

  const sortBy = state.sortBy || 'newest';
  items.sort((a, b) => {
    if (sortBy === 'name-asc') {
      return contactName(a.contact).localeCompare(contactName(b.contact));
    }
    if (sortBy === 'name-desc') {
      return contactName(b.contact).localeCompare(contactName(a.contact));
    }
    if (sortBy === 'stage') {
      const ai = STAGE_KEYS.indexOf(a.stageKey);
      const bi = STAGE_KEYS.indexOf(b.stageKey);
      return ai - bi;
    }
    // 'newest' — sort by createdate descending (most recent first)
    const ad = parseInt(a.contact.properties?.createdate || '0');
    const bd = parseInt(b.contact.properties?.createdate || '0');
    return bd - ad;
  });

  return items;
}

// ── Customer List Navigation ──────────────────────────────────────────────────
function goToCustomer(contactId) {
  const list = document.getElementById('customer-list');
  if (list) {
    try { sessionStorage.setItem('customers_scroll', String(list.scrollTop)); } catch {}
  }
  try {
    sessionStorage.setItem('customers_filters', JSON.stringify({
      contactsViewMode:  state.contactsViewMode   || 'all',
      stageFilter:       state.stageFilter         || '',
      sortBy:            state.sortBy              || 'newest',
      showArchived:      !!state.showArchived,
      leadStatusFilter:  state.leadStatusFilter    || '',
    }));
  } catch {}
  location.href = '/customers/' + contactId;
}

function restoreCustomerListScroll() {
  const saved = sessionStorage.getItem('customers_scroll');
  if (!saved) return;
  sessionStorage.removeItem('customers_scroll');
  const list = document.getElementById('customer-list');
  if (list) list.scrollTop = parseInt(saved, 10) || 0;
}

// Restore filter/sort state saved by goToCustomer before navigating away.
// Returns true if any saved state was found and applied.
function restoreCustomerListFilters() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem('customers_filters')); } catch {}
  sessionStorage.removeItem('customers_filters');
  if (!saved) return false;

  // Apply state values
  state.contactsViewMode  = saved.contactsViewMode  || 'all';
  state.stageFilter       = saved.stageFilter        || '';
  state.sortBy            = saved.sortBy             || 'newest';
  state.showArchived      = !!saved.showArchived;
  state.leadStatusFilter  = saved.leadStatusFilter   || '';

  // Sync UI elements to restored state
  const activeBtn = document.getElementById('view-active-btn');
  const allBtn    = document.getElementById('view-all-btn');
  if (activeBtn) activeBtn.classList.toggle('filter-btn-active', state.contactsViewMode === 'active');
  if (allBtn)    allBtn.classList.toggle('filter-btn-active',   state.contactsViewMode === 'all');

  const stageSelect = document.getElementById('stage-filter');
  if (stageSelect) stageSelect.value = state.stageFilter;

  const sortSelect = document.getElementById('sort-select');
  if (sortSelect) sortSelect.value = state.sortBy;

  const archivedBtn = document.getElementById('archived-toggle');
  if (archivedBtn) archivedBtn.classList.toggle('filter-btn-active', state.showArchived);

  const lsSelect = document.getElementById('lead-status-filter');
  if (lsSelect) lsSelect.value = state.leadStatusFilter;

  const lsRow = document.getElementById('lead-status-filter-row');
  if (lsRow) lsRow.classList.toggle('hidden', state.contactsViewMode !== 'all');

  return true;
}

// ── Customer List ─────────────────────────────────────────────────────────────
// Registered below as the renderer for pages that carry #customer-list.
// sales.js registers renderSalesView on the sales page (see registerCustomerListRenderer
// call at the top of sales.js), which overrides this registration on that page.
function _renderCustomerListImpl() {
  const list  = document.getElementById('customer-list');
  if (!list) return; // Sales-only DOM; safe no-op on other pages
  const count = document.getElementById('deal-count');
  const items = buildListItems();

  if (!items.length) {
    list.innerHTML = `<div class="p-4 text-sm text-slate-400 text-center mt-4">No customers match</div>`;
    count.textContent = '';
    return;
  }

  count.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;

  list.innerHTML = items.map(({ contact, roomIdx, roomName, stageKey, roomStatus }) => {
    const name         = contactName(contact);
    const email        = contact.properties?.email || '';
    const customerNum  = contact.properties?.customer_number || '';
    const colour     = stageKey ? stageColour(stageKey) : null;
    const stageLabel = stageKey ? (state.workflow?.stages?.[stageKey]?.label || stageKey) : null;
    const isSelected = contact.id === state.selectedContactId && roomIdx === state.selectedRoomIdx;
    const urgency    = state.contactUrgencyCache[contact.id];
    const isArchived = roomStatus !== 'active';
    const multiRoom  = (state.contactStageCache[contact.id]?.length || 0) > 1;
    const displayName = (multiRoom && roomName && roomName !== 'Main')
      ? `${name} — ${roomName}` : name;

    const urgencyDot = urgency === 'red'
      ? `<span class="urgency-dot urgency-red" title="Urgent: task due within 1 working day"></span>`
      : urgency === 'orange'
        ? `<span class="urgency-dot urgency-orange" title="Task due within 2 working days"></span>`
        : '';

    const qbInvs    = matchInvoicesForContact(contact);
    const qbTotal   = qbInvs.reduce((s, inv) => s + inv.balance, 0);
    const qbInvIdsAttr = escHtml(JSON.stringify(qbInvs.map(inv => inv.id)));
    const qbBadge   = qbInvs.length > 0
      ? `<button class="qb-badge" title="${qbInvs.length} outstanding invoice${qbInvs.length !== 1 ? 's' : ''}" data-inv-ids="${qbInvIdsAttr}" onclick="event.stopPropagation();openInvoicePanelFromBadge(this)">£${qbTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</button>`
      : '';

    const stagePillHtml = stageLabel && colour
      ? `<span class="stage-pill" style="background:${colour.light};color:${colour.text}">${escHtml(stageLabel)}</span>`
      : `<span class="stage-pill" style="background:${stageColour('sales').light};color:${stageColour('sales').text}">Sales</span>`;

    const statusLabel = roomStatus === 'declined' ? 'Declined' : roomStatus === 'complete' ? 'Complete' : roomStatus === 'remedial' ? 'Remedial' : 'Active';
    const statusMini = `<span class="status-mini status-mini-${roomStatus}" onclick="openStatusPicker(event,'${contact.id}',${roomIdx})" title="Change status">${statusLabel}</span>`;

    const customerNumBadge = customerNum
      ? `<span class="customer-num-badge" title="Customer number">${escHtml(customerNum)}</span>`
      : '';

    const leadStatusBadge = (() => {
      if (state.contactsViewMode !== 'all') return '';
      const raw = contact.properties?.hs_lead_status || '';
      const map = {
        'OPEN_DEAL':            { label: 'Open Deal',   cls: 'lsb-open-deal' },
        'NEW':                  { label: 'New',          cls: 'lsb-new' },
        'IN_PROGRESS':          { label: 'In Progress',  cls: 'lsb-in-progress' },
        'OPEN':                 { label: 'Open',         cls: 'lsb-new' },
        'CONNECTED':            { label: 'Connected',    cls: 'lsb-connected' },
        'ATTEMPTED_TO_CONTACT': { label: 'Attempted',    cls: '' },
        'UNQUALIFIED':          { label: 'Unqualified',  cls: 'lsb-unqualified' },
        'BAD_TIMING':           { label: 'Bad Timing',   cls: 'lsb-bad-timing' },
      };
      if (!raw) {
        return `<span class="lead-status-badge lsb-empty" title="Set lead status" onclick="openLeadStatusPicker(event,'${contact.id}')">+ Lead Status</span>`;
      }
      const entry = map[raw] || { label: raw.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()), cls: '' };
      return `<span class="lead-status-badge ${entry.cls} lsb-clickable" title="Change lead status" onclick="openLeadStatusPicker(event,'${contact.id}')">${escHtml(entry.label)}</span>`;
    })();

    return `
      <div class="customer-card ${isArchived ? 'card-archived' : ''}"
           data-contact-id="${contact.id}" data-room-idx="${roomIdx}"
           onclick="goToCustomer(this.dataset.contactId)">
        <div class="customer-card-name">
          ${urgencyDot}<span class="name-text">${escHtml(displayName)}</span>
          ${statusMini}
        </div>
        <div class="customer-card-meta">
          ${stagePillHtml}
          ${leadStatusBadge}
          ${qbBadge}
          ${customerNumBadge}
          ${email ? `<span class="customer-card-value">${escHtml(email)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}
registerCustomerListRenderer(_renderCustomerListImpl);

// ── Quick Card Actions ────────────────────────────────────────────────────────

// Load, apply an updater fn, save, and refresh the list — without opening the workflow
async function quickLoadAndUpdate(contactId, roomIdx, updater) {
  if (contactId === state.selectedContactId) {
    // Modify in-memory state directly
    updater(state.allRooms, roomIdx);
    updateRoomCache();
    try { await saveWorkflowData(); } catch (e) {
      if (e.code === 'HUBSPOT_AUTH') {
        showToast('Could not save — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
      } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
        showToast('Could not save — HubSpot rate limit reached. Please try again in a moment.', true);
      } else {
        showToast('Failed to save', true);
      }
      return;
    }
    renderCustomerList();
    if (state.selectedRoomIdx === roomIdx) {
      renderWorkflowHeader();
      renderRoomTabs();
      renderWorkflowStages();
    }
    return;
  }
  let rawData;
  try { rawData = await GET(`/api/contacts/${contactId}/localdata`); } catch { rawData = null; }
  let rooms;
  let notes = '';
  if (Array.isArray(rawData) && rawData.length > 0) {
    rooms = rawData;
  } else if (rawData && Array.isArray(rawData.rooms) && rawData.rooms.length > 0) {
    rooms = rawData.rooms;
    notes = rawData.notes || '';
  } else {
    rooms = [{ room: 'Main', stageKey: 'sales', statusId: null, comments: [], roomStatus: 'active' }];
  }
  rooms = rooms.map(r => ({
    ...r,
    room: r.room || 'Main', stageKey: r.stageKey || 'sales',
    statusId: r.statusId || null, comments: r.comments || [],
    roomStatus: r.roomStatus || 'active'
  }));
  if (roomIdx >= rooms.length) roomIdx = rooms.length - 1;
  updater(rooms, roomIdx);
  try { await POST(`/api/contacts/${contactId}/localdata`, { rooms, notes }); } catch (e) {
    if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not save — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not save — HubSpot rate limit reached. Please try again in a moment.', true);
    } else {
      showToast('Failed to save', true);
    }
    return;
  }
  state.contactStageCache[contactId] = rooms.map(r => ({
    room: r.room, stageKey: r.stageKey, roomStatus: r.roomStatus || 'active'
  }));
  renderCustomerList();
}

function closeCardPicker() {
  document.getElementById('card-picker-popup')?.remove();
  document.removeEventListener('click', closeCardPicker);
}

function openStagePicker(event, contactId, roomIdx) {
  event.stopPropagation();
  closeCardPicker();
  const rect = event.currentTarget.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.id = 'card-picker-popup';
  popup.className = 'card-picker-popup';
  // Use viewport coords (position: fixed)
  const top = Math.min(rect.bottom + 4, window.innerHeight - 320);
  popup.style.cssText = `top:${top}px;left:${Math.max(4, rect.left)}px;`;
  const currentStageKey = state.contactStageCache[contactId]?.[roomIdx]?.stageKey || null;
  popup.innerHTML = Object.entries(state.workflow?.stages || {}).map(([key, s]) => {
    const isActive = key === currentStageKey;
    const classes = `card-picker-opt${isActive ? ' card-picker-opt--active' : ''}`;
    const disabled = isActive ? 'disabled' : '';
    return `<button class="${classes}" data-stage-key="${escHtml(key)}" ${disabled}>${isActive ? '✓ ' : ''}${escHtml(s.label)}</button>`;
  }).join('');
  popup.querySelectorAll('[data-stage-key]:not([disabled])').forEach(btn => {
    const k = btn.dataset.stageKey;
    btn.addEventListener('click', () => quickSetStage(contactId, roomIdx, k));
  });
  document.body.appendChild(popup);
  setTimeout(() => document.addEventListener('click', closeCardPicker, { once: true }), 0);
}

async function quickSetStage(contactId, roomIdx, stageKey, showUndo = true) {
  closeCardPicker();
  const prevStageKey = state.contactStageCache[contactId]?.[roomIdx]?.stageKey || null;
  await quickLoadAndUpdate(contactId, roomIdx, (rooms, idx) => {
    if (rooms[idx]) { rooms[idx].stageKey = stageKey; rooms[idx].statusId = null; }
  });
  if (showUndo && prevStageKey && prevStageKey !== stageKey) {
    const newLabel = state.workflow?.stages?.[stageKey]?.label || stageKey;
    showBottomUndo(`Stage changed to ${newLabel}`, () => quickSetStage(contactId, roomIdx, prevStageKey, false));
  }
}

function openStatusPicker(event, contactId, roomIdx) {
  event.stopPropagation();
  if (isViewerOnly()) return;
  closeCardPicker();
  const rect = event.currentTarget.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.id = 'card-picker-popup';
  popup.className = 'card-picker-popup';
  const top = Math.min(rect.bottom + 4, window.innerHeight - 140);
  popup.style.cssText = `top:${top}px;left:${Math.max(4, rect.left)}px;`;
  const currentStatus = state.contactStageCache[contactId]?.[roomIdx]?.roomStatus || 'active';
  popup.innerHTML = [
    { value: 'active',   label: 'Active' },
    { value: 'declined', label: 'Declined' },
    { value: 'complete', label: 'Complete' },
    { value: 'remedial', label: 'Remedial' }
  ].map(({ value, label }) => {
    const isActive = value === currentStatus;
    const classes = `card-picker-opt card-picker-status-${value}${isActive ? ' card-picker-opt--active' : ''}`;
    const onclick = isActive ? '' : `onclick="confirmStatusChange('${contactId}',${roomIdx},'${value}')"`;
    const disabled = isActive ? 'disabled' : '';
    return `<button class="${classes}" ${onclick} ${disabled}>${isActive ? '✓ ' : ''}${label}</button>`;
  }).join('');
  document.body.appendChild(popup);
  setTimeout(() => document.addEventListener('click', closeCardPicker, { once: true }), 0);
}

async function confirmStatusChange(contactId, roomIdx, newStatus) {
  closeCardPicker();
  const prevStatus = state.contactStageCache[contactId]?.[roomIdx]?.roomStatus || 'active';
  if (prevStatus === newStatus) return;
  await quickLoadAndUpdate(contactId, roomIdx, (rooms, idx) => {
    if (rooms[idx]) rooms[idx].roomStatus = newStatus;
  });
  const labels = { active: 'Active', declined: 'Declined', complete: 'Complete', remedial: 'Remedial' };
  showBottomUndo(`Status set to ${labels[newStatus] || newStatus}`, async () => {
    await quickLoadAndUpdate(contactId, roomIdx, (rooms, idx) => {
      if (rooms[idx]) rooms[idx].roomStatus = prevStatus;
    });
  });
}

async function quickSetRoomStatus(contactId, roomIdx, newStatus) {
  await quickLoadAndUpdate(contactId, roomIdx, (rooms, idx) => {
    if (rooms[idx]) rooms[idx].roomStatus = newStatus;
  });
  renderCustomerList();
}

// ── Lead Status Picker ────────────────────────────────────────────────────────

async function openLeadStatusPicker(event, contactId) {
  event.stopPropagation();
  if (isViewerOnly()) return;
  closeCardPicker();
  const rect = event.currentTarget.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.id = 'card-picker-popup';
  popup.className = 'card-picker-popup';
  const top = Math.min(rect.bottom + 4, window.innerHeight - 300);
  popup.style.cssText = `top:${top}px;left:${Math.max(4, rect.left)}px;`;

  const stalePrevStatus = state.contacts.find(c => c.id === contactId)?.properties?.hs_lead_status || '';

  // Loading state while we refresh from HubSpot so the user can't pick a stale option.
  const loadingEl = document.createElement('div');
  loadingEl.style.cssText = 'padding:12px 16px;color:#64748b;font-size:13px;';
  loadingEl.textContent = 'Loading current status…';
  popup.appendChild(loadingEl);
  document.body.appendChild(popup);
  // Defer dismiss handler until after the picker is fully built, so loading-state
  // clicks don't consume the once-listener before the real picker appears.

  let currentLeadStatus = stalePrevStatus;
  let driftedTo = null;
  try {
    const fresh = await GET(`/api/contacts/${contactId}`);
    const freshStatus = fresh?.properties?.hs_lead_status || '';
    // Don't override the UI value if an optimistic change is mid-flight for this contact.
    const pending = state.pendingLeadStatus && Object.prototype.hasOwnProperty.call(state.pendingLeadStatus, contactId);
    if (!pending) {
      if (freshStatus !== stalePrevStatus) driftedTo = freshStatus;
      currentLeadStatus = freshStatus;
      if (typeof _mergeContactIntoState === 'function') {
        _mergeContactIntoState(fresh);
      }
      _syncLeadStatusCache(contactId, freshStatus);
      populateLeadStatusFilter();
      renderCustomerList();
      if (typeof renderWorkflowHeader === 'function') renderWorkflowHeader();
    }
  } catch (e) {
    showToast('Could not refresh lead status from HubSpot — showing last known value.', true);
  }

  // User may have closed the popup (clicked elsewhere) while loading.
  if (!document.body.contains(popup)) {
    if (driftedTo !== null) {
      const newLabel = driftedTo ? (LEAD_STATUS_OPTIONS.find(o => o.value === driftedTo)?.label || driftedTo) : 'cleared';
      showToast(`Lead status was updated in HubSpot to ${newLabel}`);
    }
    return;
  }

  popup.innerHTML = '';
  const clearBtn = document.createElement('button');
  clearBtn.className = 'card-picker-opt card-picker-opt--clear' + (currentLeadStatus ? '' : ' card-picker-opt--disabled');
  clearBtn.textContent = '✕ Clear status';
  if (currentLeadStatus) {
    clearBtn.addEventListener('click', () => quickSetLeadStatus(contactId, ''));
  } else {
    clearBtn.disabled = true;
  }
  popup.appendChild(clearBtn);

  LEAD_STATUS_OPTIONS.forEach(({ value, label }) => {
    const btn = document.createElement('button');
    const isActive = value === currentLeadStatus;
    btn.className = 'card-picker-opt' + (isActive ? ' card-picker-opt--active' : '');
    btn.dataset.leadStatus = value;
    btn.textContent = label;
    btn.addEventListener('click', () => quickSetLeadStatus(contactId, value));
    popup.appendChild(btn);
  });
  setTimeout(() => document.addEventListener('click', closeCardPicker, { once: true }), 0);

  if (driftedTo !== null) {
    const newLabel = driftedTo ? (LEAD_STATUS_OPTIONS.find(o => o.value === driftedTo)?.label || driftedTo) : 'cleared';
    showToast(`Lead status was updated in HubSpot to ${newLabel}`);
  }
}

// ── Contact Detail Edit ───────────────────────────────────────────────────────
const _CONTACT_FIELD_LABELS = {
  firstname: 'first name',
  lastname:  'last name',
  email:     'email',
  phone:     'phone',
  address:   'address',
  city:      'city',
  zip:       'postcode',
};

function _fillContactEditForm(props) {
  const f = props || {};
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  set('ec-firstname', f.firstname);
  set('ec-lastname',  f.lastname);
  set('ec-email',     f.email);
  set('ec-phone',     f.phone);
  set('ec-address',   f.address);
  set('ec-city',      f.city);
  set('ec-zip',       f.zip);
}

// Snapshot of the form values at the moment the modal was last (re)populated,
// used to detect unsaved edits when the user tries to navigate away.
let _editContactOriginal = null;

const _EC_FIELD_IDS = ['ec-firstname','ec-lastname','ec-email','ec-phone','ec-address','ec-city','ec-zip'];

function _readContactEditForm() {
  const out = {};
  for (const id of _EC_FIELD_IDS) {
    const el = document.getElementById(id);
    out[id] = el ? el.value.trim() : '';
  }
  return out;
}

function _captureContactEditOriginal() {
  _editContactOriginal = _readContactEditForm();
}

function isContactEditOpen() {
  const modal = document.getElementById('edit-contact-modal');
  return !!(modal && !modal.classList.contains('hidden'));
}

function isContactEditDirty() {
  if (!_editContactOriginal) return false;
  if (!isContactEditOpen()) return false;
  const current = _readContactEditForm();
  for (const id of _EC_FIELD_IDS) {
    if ((current[id] || '') !== (_editContactOriginal[id] || '')) return true;
  }
  return false;
}

async function openContactEdit() {
  if (isViewerOnly()) return;
  const contactId = state.selectedContactId;
  if (!contactId) return;

  const overlay   = document.getElementById('edit-contact-overlay');
  const modal     = document.getElementById('edit-contact-modal');
  if (!overlay || !modal) return;

  const errEl     = document.getElementById('ec-error');
  const submitBtn = document.getElementById('ec-submit');
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

  // Pre-fill with known values immediately, then open modal
  const contact = state.contacts.find(c => c.id === contactId);
  _fillContactEditForm(contact?.properties || {});
  _captureContactEditOriginal();
  overlay.classList.remove('hidden');
  modal.style.display = 'flex';
  modal.classList.remove('hidden');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Loading…'; }

  // Refresh from HubSpot and detect drift in editable fields
  try {
    const fresh    = await GET(`/api/contacts/${contactId}`);
    const oldProps = contact?.properties || {};
    const newProps = fresh?.properties   || {};

    const driftedLabels = Object.keys(_CONTACT_FIELD_LABELS).filter(f =>
      (newProps[f] || '') !== (oldProps[f] || '')
    ).map(f => _CONTACT_FIELD_LABELS[f]);

    // Only re-baseline the dirty snapshot if the user hasn't started editing
    // yet — otherwise their in-progress edits would suddenly look "clean".
    const wasDirty = isContactEditDirty();
    _fillContactEditForm(newProps);
    if (!wasDirty) _captureContactEditOriginal();

    if (typeof _mergeContactIntoState === 'function') _mergeContactIntoState(fresh);

    if (driftedLabels.length > 0) {
      const summary = driftedLabels.length === 1
        ? driftedLabels[0]
        : `${driftedLabels.slice(0, -1).join(', ')} and ${driftedLabels.slice(-1)}`;
      showToast(`HubSpot has a newer value for ${summary} — form updated.`);
    }
  } catch {
    showToast('Could not refresh contact from HubSpot — showing last known values.', true);
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Save'; }
  }
}

function closeContactEdit() {
  const overlay = document.getElementById('edit-contact-overlay');
  const modal   = document.getElementById('edit-contact-modal');
  if (overlay) overlay.classList.add('hidden');
  if (modal)   { modal.style.display = 'none'; modal.classList.add('hidden'); }
  _editContactOriginal = null;
  if (typeof _updateBeforeUnloadGuard === 'function') _updateBeforeUnloadGuard();
}

// Guarded close used by the overlay click and the X / Cancel buttons. If the
// user has unsaved edits, show the same bottom-bar prompt used elsewhere
// instead of silently discarding their changes.
function requestCloseContactEdit() {
  if (isContactEditDirty()) {
    showUnsavedChangesBar(
      async () => { await submitContactEdit({ preventDefault(){} }); },
      ()       => { closeContactEdit(); }
    );
    return;
  }
  closeContactEdit();
}

async function submitContactEdit(ev) {
  ev.preventDefault();
  const contactId = state.selectedContactId;
  if (!contactId) return false;

  const trim = id => document.getElementById(id)?.value.trim() || '';
  const fields = {
    firstname: trim('ec-firstname'),
    lastname:  trim('ec-lastname'),
    email:     trim('ec-email'),
    phone:     trim('ec-phone'),
    address:   trim('ec-address'),
    city:      trim('ec-city'),
    zip:       trim('ec-zip'),
  };

  const errEl     = document.getElementById('ec-error');
  const submitBtn = document.getElementById('ec-submit');
  const showError = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

  if (!fields.firstname) { showError('First name is required.'); return false; }

  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }

  const contact   = state.contacts.find(c => c.id === contactId);
  const prevProps = { ...(contact?.properties || {}) };

  function _applyContactFields(props) {
    if (contact) {
      contact.properties = { ...(contact.properties || {}), ...props };
      if (state.selectedContactId === contactId) state.selectedContact = contact;
    }
    renderCustomerList();
    if (typeof renderWorkflowHeader === 'function') renderWorkflowHeader();
  }

  _applyContactFields(fields);
  closeContactEdit();

  const prevTitle = document.title;
  if (contact) document.title = contactName(contact);

  try {
    await PATCH_REQ(`/api/contacts/${contactId}`, fields);
    showToast('Contact updated');
    return true;
  } catch (e) {
    _applyContactFields(prevProps);
    document.title = prevTitle;
    if (e.code === 'HUBSPOT_VERIFY_FAILED') {
      showToast("Contact details didn't save in HubSpot — please try again.", true);
    } else if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not update contact — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not update contact — HubSpot rate limit reached. Please try again in a moment.', true);
    } else {
      showToast('Failed to update contact', true);
    }
    // PATCH failed but the modal is already closed and local state reverted —
    // the user has been notified via toast, so navigation may still proceed.
    return true;
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Save'; }
  }
}

// Closes the modal silently if it is open without any unsaved edits, so a
// pristine open modal doesn't get stranded across room/contact navigation.
function closeContactEditIfPristine() {
  if (isContactEditOpen() && !isContactEditDirty()) {
    closeContactEdit();
  }
}

function _syncLeadStatusCache(contactId, status) {
  try {
    const cached = sessionStorage.getItem('contacts_all_cache');
    if (!cached) return;
    const arr = JSON.parse(cached);
    const ci = arr.findIndex(c => c.id === contactId);
    if (ci >= 0) {
      arr[ci].properties = { ...(arr[ci].properties || {}), hs_lead_status: status };
      sessionStorage.setItem('contacts_all_cache', JSON.stringify(arr));
    }
  } catch {}
}

async function quickSetLeadStatus(contactId, newStatus) {
  closeCardPicker();
  const contact = state.contacts.find(c => c.id === contactId);
  const prevStatus = contact?.properties?.hs_lead_status || null;
  if (prevStatus === newStatus) return;

  function _applyLeadStatus(status) {
    if (contact) {
      contact.properties = { ...(contact.properties || {}), hs_lead_status: status };
    }
    // Defensive refresh: re-read selectedContact from the contacts array so the
    // detail panel always sees the freshly-mutated object, regardless of which
    // direction the change came from (list → detail or detail → list).
    if (state.selectedContactId) {
      const fresh = state.contacts.find(c => c.id === state.selectedContactId);
      if (fresh) state.selectedContact = fresh;
    }
    // Record pending optimistic status (including '' for a clear) so any
    // contact refresh that replaces state.contacts can re-apply it before
    // the PATCH response arrives. The entry is only removed once the PATCH
    // resolves, not when the status value is empty.
    state.pendingLeadStatus = state.pendingLeadStatus || {};
    state.pendingLeadStatus[contactId] = status;
    _syncLeadStatusCache(contactId, status);
    populateLeadStatusFilter();
    renderCustomerList();
    if (typeof renderWorkflowHeader === 'function') renderWorkflowHeader();
  }

  // Optimistic update
  _applyLeadStatus(newStatus);

  try {
    await PATCH_REQ(`/api/contacts/${contactId}`, { hs_lead_status: newStatus });
    // PATCH succeeded — server now has the new value, so no longer pending.
    if (state.pendingLeadStatus) delete state.pendingLeadStatus[contactId];
    const newLabel = newStatus ? (LEAD_STATUS_OPTIONS.find(o => o.value === newStatus)?.label || newStatus) : null;
    showBottomUndo(newLabel ? `Lead status set to ${newLabel}` : 'Lead status cleared', async () => {
      _applyLeadStatus(prevStatus || '');
      await PATCH_REQ(`/api/contacts/${contactId}`, { hs_lead_status: prevStatus || '' })
        .catch(() => {})
        .finally(() => { if (state.pendingLeadStatus) delete state.pendingLeadStatus[contactId]; });
    });
  } catch (e) {
    // Revert on failure: update pending to the reverted value, then clear once
    // we know the PATCH round-trip is done (no second request needed since we
    // never sent a successful change).
    _applyLeadStatus(prevStatus || '');
    if (state.pendingLeadStatus) delete state.pendingLeadStatus[contactId];
    if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not update lead status — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not update lead status — HubSpot rate limit reached. Please try again in a moment.', true);
    } else if (e.code === 'HUBSPOT_VERIFY_FAILED') {
      showToast("Lead status didn't save in HubSpot — please try again.", true);
    } else {
      showToast('Failed to update lead status', true);
    }
  }
}
