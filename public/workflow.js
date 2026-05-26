// ── Quick Card Actions ────────────────────────────────────────────────────────

// Load, apply an updater fn, save, and refresh the list — without opening the workflow
async function quickLoadAndUpdate(contactId, roomIdx, updater) {
  if (contactId === state.selectedContactId) {
    // Modify in-memory state directly
    updater(state.allRooms, roomIdx);
    updateRoomCache();
    document.dispatchEvent(new CustomEvent('mo:contacts-changed'));
    if (state.selectedRoomIdx === roomIdx) {
      renderWorkflowHeader();
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
