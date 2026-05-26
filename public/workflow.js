// ── New Customer slide-over panel ────────────────────────────────────────────
function _ensureNewCustomerPanel() {
  let panel = document.getElementById('new-customer-panel');
  if (panel) return panel;

  const overlay = document.createElement('div');
  overlay.id = 'new-customer-overlay';
  overlay.className = 'nc-panel-overlay';
  overlay.style.display = 'none';
  overlay.addEventListener('click', closeNewCustomerModal);

  panel = document.createElement('aside');
  panel.id = 'new-customer-panel';
  panel.className = 'nc-panel';
  panel.innerHTML = `
    <div class="nc-panel-header">
      <h2 class="nc-panel-title">New Customer</h2>
      <button type="button" class="nc-panel-close" id="nc-panel-close-btn" title="Close" aria-label="Close">
        <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>
    <div class="nc-panel-body">
      <form id="new-customer-form" novalidate>
        <div class="nc-form-grid">
          <label class="nc-form-row">
            <span class="nc-label-text">First name <span class="nc-required">*</span></span>
            <input id="nc-firstname" type="text" required autocomplete="given-name" class="nc-input">
          </label>
          <label class="nc-form-row">
            <span class="nc-label-text">Last name</span>
            <input id="nc-lastname" type="text" autocomplete="family-name" class="nc-input">
          </label>
        </div>
        <label class="nc-form-row">
          <span class="nc-label-text">Email <span class="nc-required">*</span></span>
          <input id="nc-email" type="email" required autocomplete="email" class="nc-input">
        </label>
        <label class="nc-form-row">
          <span class="nc-label-text">Phone</span>
          <input id="nc-phone" type="tel" autocomplete="tel" class="nc-input">
        </label>
        <label class="nc-form-row nc-form-row-last">
          <span class="nc-label-text">Postcode <span class="nc-required">*</span></span>
          <input id="nc-postcode" type="text" required autocomplete="postal-code" class="nc-input nc-postcode">
        </label>
        <div id="nc-error" class="nc-error"></div>
        <div class="nc-actions">
          <button type="button" id="nc-cancel-btn" class="nc-btn-cancel">Cancel</button>
          <button type="submit" id="nc-submit" class="nc-btn-submit">Create Customer</button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(panel);

  panel.querySelector('#nc-panel-close-btn').addEventListener('click', closeNewCustomerModal);
  panel.querySelector('#nc-cancel-btn').addEventListener('click', closeNewCustomerModal);
  panel.querySelector('#new-customer-form').addEventListener('submit', submitNewCustomer);
  return panel;
}

function openNewCustomerModal() {
  if (isViewerPrivilege()) return;
  const panel   = _ensureNewCustomerPanel();
  const overlay = document.getElementById('new-customer-overlay');
  const form    = document.getElementById('new-customer-form');
  const err     = document.getElementById('nc-error');
  if (form) form.reset();
  if (err)  { err.style.display = 'none'; err.textContent = ''; }
  if (overlay) overlay.style.display = 'block';
  // Force reflow so the transform transition runs
  void panel.offsetWidth;
  panel.classList.add('nc-panel-open');
  setTimeout(() => document.getElementById('nc-firstname')?.focus(), 60);
}

function closeNewCustomerModal() {
  const overlay = document.getElementById('new-customer-overlay');
  const panel   = document.getElementById('new-customer-panel');
  if (panel) panel.classList.remove('nc-panel-open');
  if (overlay) overlay.style.display = 'none';
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
    document.dispatchEvent(new CustomEvent('mo:contacts-changed'));
    const customerNum = contact.properties?.customer_number;
    showToast(`Customer created${customerNum ? ` — ${customerNum}` : ''}`);
    // Background refresh to pick up server sort order (respect current view mode)
    if (state.contactsViewMode === 'all') {
      const leadStatus = state.leadStatusFilter || '';
      const sort       = state.sortBy || 'newest';
      Promise.all([
        loadContactsPage({ page: 1, leadStatus, sort }),
        loadLeadStatusCounts(),
      ]).then(() => document.dispatchEvent(new CustomEvent('mo:contacts-changed'))).catch(() => {});
    } else {
      loadOpenLeads()
        .then(() => { state.filteredContacts = [...state.contacts]; document.dispatchEvent(new CustomEvent('mo:contacts-changed')); })
        .catch(() => {});
    }
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
    document.dispatchEvent(new CustomEvent('mo:contacts-changed'));
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
    room: r.room, stageKey: r.stageKey, roomStatus: r.roomStatus || 'active',
    statusId: r.statusId || null,
    sourceId: r.sourceId || null,
    stageDates: r.stageDates || null,
  }));
  document.dispatchEvent(new CustomEvent('mo:contacts-changed'));
}

// ── Contact Detail Edit ───────────────────────────────────────────────────────
// NOTE: CustomerDetailPage.tsx (React) now owns contact editing. The vanilla-JS
// inline-edit form functions that previously lived here have been removed.

// HTML fragment shown next to the lead-status pill: chip (current sub) or +.
// Returns '' when there's nothing to show.
function renderSubstatusAffordance(contact) {
  const statusKey = contact?.properties?.hs_lead_status || '';
  if (!statusKey) return '';
  const subs = _substatusesForStatus(statusKey);
  if (!subs.length) return '';
  const cid = contact?.id || '';
  const editable = canEditPrivilege();
  const current = _currentSubstatusFor(contact);
  if (current) {
    const label = escHtml(current.label);
    if (!editable) return `<span class="lead-substatus-chip" title="Sub-status">${label}</span>`;
    return `<span class="lead-substatus-chip lsb-clickable" title="Change sub-status" role="button" tabindex="-1" onclick="openLeadSubstatusPicker(event,'${cid}')">${label}</span>`;
  }
  if (!editable) return '';
  return `<button type="button" class="lead-substatus-add" title="Set sub-status" onclick="openLeadSubstatusPicker(event,'${cid}')">+</button>`;
}

async function openLeadSubstatusPicker(event, contactId) {
  event.stopPropagation();
  { if (!canEditPrivilege()) return; }
  closeCardPicker();

  let contact = state.contacts.find(c => c.id === contactId);
  if (!contact && state.selectedContact?.id === contactId) contact = state.selectedContact;
  const statusKey = contact?.properties?.hs_lead_status || '';
  const subs = _substatusesForStatus(statusKey);
  if (!statusKey || !subs.length) return;

  const current = _currentSubstatusFor(contact);

  const rect = event.currentTarget.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.id = 'card-picker-popup';
  popup.className = 'card-picker-popup';
  const top = Math.min(rect.bottom + 4, window.innerHeight - 300);
  popup.style.cssText = `top:${top}px;left:${Math.max(4, rect.left)}px;`;

  const clearBtn = document.createElement('button');
  clearBtn.className = 'card-picker-opt card-picker-opt--clear' + (current ? '' : ' card-picker-opt--disabled');
  clearBtn.textContent = '✕ Clear sub-status';
  if (current) {
    clearBtn.addEventListener('click', () => quickSetLeadSubstatus(contactId, ''));
  } else {
    clearBtn.disabled = true;
  }
  popup.appendChild(clearBtn);

  subs.forEach(sub => {
    const btn = document.createElement('button');
    const isActive = current && current.key === sub.substatus_key;
    btn.className = 'card-picker-opt' + (isActive ? ' card-picker-opt--active' : '');
    btn.textContent = sub.label || sub.substatus_key;
    btn.addEventListener('click', () => quickSetLeadSubstatus(contactId, sub.substatus_key));
    popup.appendChild(btn);
  });

  document.body.appendChild(popup);
  setTimeout(() => document.addEventListener('click', closeCardPicker, { once: true }), 0);
}

async function quickSetLeadSubstatus(contactId, newSubKey) {
  closeCardPicker();

  let contact = state.contacts.find(c => c.id === contactId);
  if (!contact && state.selectedContact?.id === contactId) contact = state.selectedContact;
  if (!contact) return;

  const statusKey = contact.properties?.hs_lead_status || '';
  if (!statusKey && newSubKey) {
    showToast('Set a lead status before choosing a sub-status.', true);
    return;
  }

  const prevHw = contact.properties?.hw_lead_substatus || '';
  // Storage convention: ${STATUS_KEY}__${SUBSTATUS_KEY} (see server.js).
  const newHw = newSubKey
    ? `${String(statusKey).toUpperCase()}__${String(newSubKey).toUpperCase()}`
    : '';
  if (prevHw === newHw) return;

  function _applySubstatus(hw) {
    if (contact) {
      contact.properties = { ...(contact.properties || {}), hw_lead_substatus: hw };
    }
    if (state.selectedContact && state.selectedContact.id === contactId &&
        state.selectedContact !== contact) {
      state.selectedContact.properties = {
        ...(state.selectedContact.properties || {}),
        hw_lead_substatus: hw,
      };
    }
    if (state.selectedContactId) {
      const fresh = state.contacts.find(c => c.id === state.selectedContactId);
      if (fresh) state.selectedContact = fresh;
    }
    document.dispatchEvent(new CustomEvent('mo:contacts-changed'));
    renderWorkflowHeader();
  }

  _applySubstatus(newHw);

  try {
    await PATCH_REQ(`/api/contacts/${contactId}`, { hw_lead_substatus: newHw });
    const subs = _substatusesForStatus(statusKey);
    const newLabel = newSubKey
      ? (subs.find(s => String(s.substatus_key).toUpperCase() === String(newSubKey).toUpperCase())?.label || newSubKey)
      : null;
    showBottomUndo(newLabel ? `Sub-status set to ${newLabel}` : `Sub-status cleared`, async () => {
      _applySubstatus(prevHw);
      await PATCH_REQ(`/api/contacts/${contactId}`, { hw_lead_substatus: prevHw }).catch(() => {});
    });
  } catch (e) {
    _applySubstatus(prevHw);
    if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not update sub-status — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not update sub-status — HubSpot rate limit reached. Please try again in a moment.', true);
    } else if (e.code === 'HUBSPOT_VERIFY_FAILED') {
      showToast("Sub-status didn't save in HubSpot — please try again.", true);
    } else if (e.code === 'PIPELINE_EDIT_FORBIDDEN') {
      showToast('You do not have permission to change the sub-status.', true);
    } else {
      showToast('Failed to update sub-status', true);
    }
  }
}
