// ── Projects View ─────────────────────────────────────────────────────────────
function setProjectStageFilter(key) {
  state.projectStageFilter = key;
  renderProjectsView();
}

async function ensureProjectPlatformUsers() {
  if (state.platformUsers && state.platformUsers.length) return;
  try {
    state.platformUsers = await GET('/api/platform-users');
  } catch {
    state.platformUsers = [];
  }
}

async function renderProjectsView() {
  const view = document.getElementById('projects-view');
  if (!view) return;

  await ensureProjectPlatformUsers();

  const filter    = state.projectStageFilter;
  const myRooms   = filter === '__mine__';
  const stageKey  = myRooms ? '' : filter;
  const currentId = state.user?.id;
  const privLevel = state.user?.privilege_level || 'member';
  const canAssign = !!state.user?.isAdmin || privLevel === 'manager' || privLevel === 'admin';

  // Collect contacts that have at least one active room with saved data
  const rows = [];
  for (const contact of state.contacts) {
    const cached = state.contactStageCache[contact.id];
    if (!cached || cached.length === 0) continue;
    const activeRooms = cached
      .map((r, idx) => ({ ...r, roomIdx: idx }))
      .filter(r => (r.roomStatus || 'active') === 'active')
      .filter(r => !stageKey || r.stageKey === stageKey)
      .filter(r => !myRooms || r.assignedFitterId === currentId);
    if (!activeRooms.length) continue;
    rows.push({ contact, rooms: activeRooms });
  }

  // Sort by most advanced room stage, later stages first
  rows.sort((a, b) => {
    const maxStage = row => Math.max(...row.rooms.map(r => STAGE_KEYS.indexOf(r.stageKey)));
    return maxStage(b) - maxStage(a);
  });

  // Within each row, sort rooms by stage descending
  rows.forEach(row => row.rooms.sort((a, b) =>
    STAGE_KEYS.indexOf(b.stageKey) - STAGE_KEYS.indexOf(a.stageKey)
  ));

  const stageTabs = [
    { key: '', label: 'All' },
    { key: '__mine__', label: 'My rooms' },
    ...STAGE_KEYS.map(k => ({ key: k, label: state.workflow?.stages?.[k]?.label || k }))
  ].map(({ key, label }) => {
    const colour  = (key && key !== '__mine__') ? stageColour(key) : null;
    const active  = filter === key;
    const style   = active && colour
      ? `background:${colour.bg};color:#fff;border-color:${colour.bg}`
      : active
        ? 'background:var(--plum);color:#fff;border-color:var(--plum)'
        : '';
    return `<button class="project-stage-tab ${active ? 'project-stage-tab-active' : ''}"
      style="${style}" data-stage-filter="${escHtml(key)}">${escHtml(label)}</button>`;
  }).join('');

  const emptyMsg = myRooms
    ? 'No rooms are currently assigned to you.'
    : 'No projects at this stage.';
  const bodyHtml = !rows.length
    ? `<p class="projects-empty-msg">${emptyMsg}</p>`
    : rows.map(({ contact, rooms }) => customerCardHtml(contact, rooms, canAssign)).join('');

  view.innerHTML = `
    <div class="project-stage-tabs-bar">
      ${stageTabs}
    </div>
    <div class="projects-inner">
      ${bodyHtml}
    </div>
  `;

  view.querySelector('.project-stage-tabs-bar').addEventListener('click', function(e) {
    const btn = e.target.closest('[data-stage-filter]');
    if (!btn) return;
    setProjectStageFilter(btn.dataset.stageFilter);
  });

  view.addEventListener('click', function(e) {
    // Fitter chip click — open assignment picker (admin only)
    const chip = e.target.closest('[data-fitter-contact-id]');
    if (chip) {
      e.stopPropagation();
      openFitterPicker(chip.dataset.fitterContactId, parseInt(chip.dataset.fitterRoomIdx, 10));
      return;
    }

    // Room row click — navigate to contact
    const row = e.target.closest('[data-contact-id]');
    if (!row) return;
    openProject(row.dataset.contactId, parseInt(row.dataset.roomIdx, 10));
  });
}

function fitterChipHtml(room, contactId, canAssign) {
  const users   = state.platformUsers || [];
  const fitter  = room.assignedFitterId ? users.find(u => u.id === room.assignedFitterId) : null;
  const unknownAssigned = room.assignedFitterId && !fitter;
  const name    = fitter
    ? escHtml(`${fitter.firstName || ''} ${fitter.lastName || ''}`.trim() || fitter.email || 'Fitter')
    : unknownAssigned ? 'Assigned (unknown)' : 'Unassigned';
  const img     = fitter?.profileImageUrl
    ? `<img src="${escHtml(fitter.profileImageUrl)}" alt="" class="fitter-chip-avatar">`
    : `<span class="fitter-chip-avatar fitter-chip-avatar-initials">${escHtml(fitterInitials(fitter))}</span>`;

  if (canAssign) {
    return `<button class="fitter-chip fitter-chip-admin" aria-label="Assign fitter"
        data-fitter-contact-id="${escHtml(contactId)}" data-fitter-room-idx="${escHtml(String(room.roomIdx))}"
        title="${fitter ? 'Reassign fitter' : 'Assign a fitter'}">
      ${fitter ? img : ''}
      <span class="fitter-chip-name ${fitter ? '' : 'fitter-chip-unassigned'}">${name}</span>
    </button>`;
  }

  return `<span class="fitter-chip">
    ${fitter ? img : ''}
    <span class="fitter-chip-name ${fitter ? '' : 'fitter-chip-unassigned'}">${name}</span>
  </span>`;
}

function fitterInitials(fitter) {
  if (!fitter) return '+';
  const parts = [fitter.firstName, fitter.lastName].filter(Boolean);
  if (parts.length) return parts.map(s => s[0]).join('').toUpperCase();
  return (fitter.email || '?')[0].toUpperCase();
}

function customerCardHtml(contact, rooms, isAdmin) {
  const name      = escHtml(contactName(contact));
  const contactId = escHtml(contact.id || '');

  const roomRows = rooms.map(r => {
    const colour     = stageColour(r.stageKey);
    const stageLabel = escHtml(state.workflow?.stages?.[r.stageKey]?.label || r.stageKey);
    const roomLabel  = escHtml(r.room || 'Main');
    const chip       = fitterChipHtml(r, contact.id, isAdmin);
    return `
      <div class="project-room-row" data-contact-id="${escHtml(contact.id)}" data-room-idx="${r.roomIdx}">
        <span class="project-room-row-name">${roomLabel}</span>
        ${chip}
        <span class="stage-pill" style="background:${colour.light};color:${colour.text}">${stageLabel}</span>
      </div>`;
  }).join('');

  return `
    <div class="customer-project-card">
      <div class="customer-project-header">
        <div class="customer-project-name">${name}</div>
        <div class="customer-project-id">#${contactId}</div>
      </div>
      <div class="project-room-list">
        ${roomRows}
      </div>
    </div>`;
}

// ── Fitter Picker Modal ───────────────────────────────────────────────────────
let _fitterPickerContactId = null;
let _fitterPickerRoomIdx   = null;

function openFitterPicker(contactId, roomIdx) {
  _fitterPickerContactId = contactId;
  _fitterPickerRoomIdx   = roomIdx;

  const users   = state.platformUsers || [];
  const cached  = (state.contactStageCache[contactId] || [])[roomIdx];
  const current = cached?.assignedFitterId;

  const userItems = users.map(u => {
    const fullName  = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || 'Unknown';
    const initials  = fitterInitials(u);
    const selected  = u.id === current;
    const imgHtml   = u.profileImageUrl
      ? `<img src="${escHtml(u.profileImageUrl)}" alt="" class="fitter-picker-avatar">`
      : `<span class="fitter-picker-avatar fitter-picker-avatar-initials">${escHtml(initials)}</span>`;
    return `<button class="fitter-picker-item ${selected ? 'fitter-picker-item-selected' : ''}"
        data-user-id="${escHtml(u.id)}">
      ${imgHtml}
      <span class="fitter-picker-item-name">${escHtml(fullName)}</span>
      ${selected ? '<span class="fitter-picker-check">✓</span>' : ''}
    </button>`;
  }).join('');

  const unassignBtn = current
    ? `<button class="fitter-picker-unassign" data-user-id="">Remove assignment</button>`
    : '';

  let el = document.getElementById('fitter-picker-sheet');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fitter-picker-sheet';
    document.body.appendChild(el);
  }

  el.innerHTML = `
    <div class="fitter-picker-backdrop" id="fitter-picker-backdrop"></div>
    <div class="fitter-picker-panel" role="dialog" aria-modal="true" aria-label="Assign fitter">
      <div class="fitter-picker-header">
        <span class="fitter-picker-title">Assign fitter</span>
        <button class="fitter-picker-close" id="fitter-picker-close" aria-label="Close">✕</button>
      </div>
      <div class="fitter-picker-list">
        ${userItems || '<p class="picker-empty-msg">No team members found.</p>'}
      </div>
      ${unassignBtn}
    </div>
  `;

  el.classList.add('fitter-picker-open');

  el.querySelector('#fitter-picker-backdrop').addEventListener('click', closeFitterPicker);
  el.querySelector('#fitter-picker-close').addEventListener('click', closeFitterPicker);

  el.querySelectorAll('[data-user-id]').forEach(btn => {
    btn.addEventListener('click', () => assignFitter(btn.dataset.userId || null));
  });
}

function closeFitterPicker() {
  const el = document.getElementById('fitter-picker-sheet');
  if (el) {
    el.classList.remove('fitter-picker-open');
    setTimeout(() => { el.innerHTML = ''; }, 300);
  }
}

async function assignFitter(fitterId) {
  const contactId = _fitterPickerContactId;
  const roomIdx   = _fitterPickerRoomIdx;
  closeFitterPicker();

  if (contactId === null || roomIdx === null) return;

  try {
    await PATCH_REQ(`/api/contacts/${contactId}/rooms/${roomIdx}/fitter`, { fitterId: fitterId || null });

    // Update local cache immediately so the UI reflects the change
    const cached = state.contactStageCache[contactId];
    if (cached && cached[roomIdx] !== undefined) {
      cached[roomIdx] = { ...cached[roomIdx], assignedFitterId: fitterId || null };
    }

    renderProjectsView();
    showToast(fitterId ? 'Fitter assigned' : 'Assignment removed');
  } catch (e) {
    showToast('Failed to save assignment', true);
  }
}
