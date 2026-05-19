// ── New Customer Modal ────────────────────────────────────────────────────────
function openNewCustomerModal() {
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
    // Background refresh to pick up server sort order
    loadOpenLeads().then(() => { state.filteredContacts = [...state.contacts]; renderCustomerList(); }).catch(() => {});
  } catch (e) {
    showError(e.message || 'Failed to create customer.');
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Create Customer'; }
  }
}

// ── Build List Items ──────────────────────────────────────────────────────────
function buildListItems() {
  const items = [];
  for (const contact of state.filteredContacts) {
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

// ── Customer List ─────────────────────────────────────────────────────────────
function renderCustomerList() {
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
    const qbBadge   = qbInvs.length > 0
      ? `<span class="qb-badge" title="${qbInvs.length} outstanding invoice${qbInvs.length !== 1 ? 's' : ''}">£${qbTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
      : '';

    const stagePillHtml = stageLabel && colour
      ? `<span class="stage-pill" style="background:${colour.light};color:${colour.text}">${escHtml(stageLabel)}</span>`
      : `<span class="stage-pill" style="background:${stageColour('sales').light};color:${stageColour('sales').text}">Sales</span>`;

    const statusLabel = roomStatus === 'declined' ? 'Declined' : roomStatus === 'complete' ? 'Complete' : roomStatus === 'remedial' ? 'Remedial' : 'Active';
    const statusMini = `<span class="status-mini status-mini-${roomStatus}" onclick="openStatusPicker(event,'${contact.id}',${roomIdx})" title="Change status">${statusLabel}</span>`;

    const customerNumBadge = customerNum
      ? `<span class="customer-num-badge" title="Customer number">${escHtml(customerNum)}</span>`
      : '';

    return `
      <div class="customer-card ${isSelected ? 'selected' : ''} ${isArchived ? 'card-archived' : ''}"
           data-contact-id="${contact.id}" data-room-idx="${roomIdx}"
           onclick="selectContact('${contact.id}', ${roomIdx})">
        <div class="customer-card-name">
          ${urgencyDot}<span class="name-text">${escHtml(displayName)}</span>
          ${statusMini}
        </div>
        <div class="customer-card-meta">
          ${stagePillHtml}
          ${qbBadge}
          ${customerNumBadge}
          ${email ? `<span class="customer-card-value">${escHtml(email)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// ── Quick Card Actions ────────────────────────────────────────────────────────

// Load, apply an updater fn, save, and refresh the list — without opening the workflow
async function quickLoadAndUpdate(contactId, roomIdx, updater) {
  if (contactId === state.selectedContactId) {
    // Modify in-memory state directly
    updater(state.allRooms, roomIdx);
    updateRoomCache();
    try { await saveWorkflowData(); } catch { showToast('Failed to save', true); return; }
    renderCustomerList();
    if (state.selectedRoomIdx === roomIdx) {
      renderWorkflowHeader();
      renderRoomTabs();
      renderWorkflowStages();
    }
    return;
  }
  let rooms;
  try { rooms = await GET(`/api/contacts/${contactId}/localdata`); } catch { rooms = null; }
  if (!Array.isArray(rooms) || rooms.length === 0) {
    rooms = [{ room: 'Main', stageKey: 'sales', statusId: null, comments: [], roomStatus: 'active' }];
  }
  rooms = rooms.map(r => ({
    room: r.room || 'Main', stageKey: r.stageKey || 'sales',
    statusId: r.statusId || null, comments: r.comments || [],
    roomStatus: r.roomStatus || 'active'
  }));
  if (roomIdx >= rooms.length) roomIdx = rooms.length - 1;
  updater(rooms, roomIdx);
  try { await POST(`/api/contacts/${contactId}/localdata`, rooms); } catch { showToast('Failed to save', true); return; }
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
  popup.innerHTML = Object.entries(state.workflow?.stages || {}).map(([key, s]) =>
    `<button class="card-picker-opt" data-stage-key="${escHtml(key)}">${escHtml(s.label)}</button>`
  ).join('');
  popup.querySelectorAll('[data-stage-key]').forEach(btn => {
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
  closeCardPicker();
  const rect = event.currentTarget.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.id = 'card-picker-popup';
  popup.className = 'card-picker-popup';
  const top = Math.min(rect.bottom + 4, window.innerHeight - 140);
  popup.style.cssText = `top:${top}px;left:${Math.max(4, rect.left)}px;`;
  popup.innerHTML = [
    { value: 'active',   label: 'Active' },
    { value: 'declined', label: 'Declined' },
    { value: 'complete', label: 'Complete' },
    { value: 'remedial', label: 'Remedial' }
  ].map(({ value, label }) =>
    `<button class="card-picker-opt card-picker-status-${value}" onclick="confirmStatusChange('${contactId}',${roomIdx},'${value}')">${label}</button>`
  ).join('');
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
