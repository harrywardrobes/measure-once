// ── Quick Card Actions ────────────────────────────────────────────────────────

// Load, apply an updater fn, save, and refresh the list — without opening the workflow
async function quickLoadAndUpdate(contactId, roomIdx, updater) {
  if (contactId === state.selectedContactId) {
    // Modify in-memory state directly for immediate UI feedback.
    updater(state.allRooms, roomIdx);
    updateRoomCache();
    document.dispatchEvent(new CustomEvent('mo:contacts-changed'));
    if (state.selectedRoomIdx === roomIdx) {
      renderWorkflowHeader();
      renderWorkflowStages();
    }
    // Also persist to the server so the change is not lost on reload.
    // Fetch notes separately so we do not overwrite them with an empty string.
    let notes = '';
    try {
      const existing = await GET(`/api/contacts/${contactId}/localdata`);
      if (existing && typeof existing.notes === 'string') notes = existing.notes;
    } catch { /* fall back to '' on network error */ }
    const rooms = state.allRooms;
    try {
      await POST(`/api/contacts/${contactId}/localdata`, { rooms, notes });
    } catch (e) {
      if (e.code === 'HUBSPOT_AUTH') {
        showToast('Could not save — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
      } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
        showToast('Could not save — HubSpot rate limit reached. Please try again in a moment.', true);
      } else {
        showToast('Failed to save', true);
      }
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

