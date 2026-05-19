// ── Projects View ─────────────────────────────────────────────────────────────

async function loadProjectPrefs() {
  const prefs = await ensurePrefs();
  state.projectSort         = prefs.projectSort         ?? 'stage';
  state.projectGroupByStage = prefs.projectGroupByStage ?? false;
}

function setProjectSort(val) {
  state.projectSort = val;
  patchPref('projectSort', val);
  renderProjectsView();
}

function toggleProjectGroupByStage() {
  state.projectGroupByStage = !state.projectGroupByStage;
  patchPref('projectGroupByStage', state.projectGroupByStage);
  renderProjectsView();
}

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

  await loadProjectPrefs();
  await ensureProjectPlatformUsers();

  const filter    = state.projectStageFilter;
  const myRooms   = filter === '__mine__';
  const stageKey  = myRooms ? '' : filter;
  const currentId = state.user?.id;
  const privLevel = state.user?.privilege_level || 'member';
  const canAssign = !!state.user?.isAdmin || privLevel === 'manager' || privLevel === 'admin';
  const sortBy    = state.projectSort || 'stage';
  const groupBy   = !!state.projectGroupByStage && !stageKey && !myRooms;

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

  // Sort rows
  const maxStageIdx = row => Math.max(...row.rooms.map(r => STAGE_KEYS.indexOf(r.stageKey)));
  if (sortBy === 'name') {
    rows.sort((a, b) => contactName(a.contact).localeCompare(contactName(b.contact)));
  } else if (sortBy === 'date') {
    rows.sort((a, b) => {
      const da = parseInt(a.contact.properties?.closedate || '0', 10);
      const db = parseInt(b.contact.properties?.closedate || '0', 10);
      if (!da && !db) return contactName(a.contact).localeCompare(contactName(b.contact));
      if (!da) return 1;
      if (!db) return -1;
      return da - db;
    });
  } else if (sortBy === 'install') {
    const earliestInstall = row => {
      const dates = row.rooms
        .map(r => r.installStart)
        .filter(Boolean)
        .sort();
      return dates[0] || null;
    };
    rows.sort((a, b) => {
      const da = earliestInstall(a);
      const db = earliestInstall(b);
      if (!da && !db) return contactName(a.contact).localeCompare(contactName(b.contact));
      if (!da) return 1;
      if (!db) return -1;
      return da.localeCompare(db);
    });
  } else {
    // Default: stage — most advanced room first
    rows.sort((a, b) => maxStageIdx(b) - maxStageIdx(a));
  }

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

  // ── Sort / group bar ──────────────────────────────────────────────────────
  const sortLabels = { stage: 'Stage', name: 'Name', date: 'Close date', install: 'Install date' };
  const sortOptions = Object.entries(sortLabels)
    .map(([val, lbl]) => `<option value="${val}"${sortBy === val ? ' selected' : ''}>${escHtml(lbl)}</option>`)
    .join('');
  const groupActive = groupBy ? ' project-group-btn-active' : '';
  const groupDisabled = (stageKey || myRooms) ? ' disabled title="Clear the stage filter to enable grouping"' : '';
  const sortBar = `
    <div class="project-sort-bar">
      <label class="project-sort-label" for="project-sort-select">Sort by</label>
      <select id="project-sort-select" class="project-sort-select">
        ${sortOptions}
      </select>
      <button id="project-group-btn" class="project-group-btn${groupActive}"${groupDisabled}
        title="${groupBy ? 'Ungroup stages' : 'Group by stage'}">
        Group by stage
      </button>
    </div>`;

  // ── Body HTML ──────────────────────────────────────────────────────────────
  const emptyMsg = myRooms
    ? 'No rooms are currently assigned to you.'
    : 'No projects at this stage.';

  let bodyHtml;
  if (!rows.length) {
    bodyHtml = `<p class="projects-empty-msg">${emptyMsg}</p>`;
  } else if (groupBy) {
    // Group cards by the contact's most-advanced stage
    const groups = new Map();
    for (const row of rows) {
      const idx = Math.max(...row.rooms.map(r => STAGE_KEYS.indexOf(r.stageKey)));
      const key = idx >= 0 ? STAGE_KEYS[idx] : (row.rooms[0]?.stageKey || '');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    // Render groups in stage order (most advanced first for stage sort, else natural order)
    const orderedKeys = sortBy === 'stage'
      ? [...groups.keys()].sort((a, b) => STAGE_KEYS.indexOf(b) - STAGE_KEYS.indexOf(a))
      : [...groups.keys()];
    bodyHtml = orderedKeys.map(key => {
      const label   = escHtml(state.workflow?.stages?.[key]?.label || key);
      const colour  = stageColour(key);
      const heading = `<div class="project-group-heading" style="border-left-color:${colour.bg}">
        <span class="project-group-heading-pill" style="background:${colour.light};color:${colour.text}">${label}</span>
        <span class="project-group-count">${groups.get(key).length}</span>
      </div>`;
      const cards = groups.get(key).map(({ contact, rooms }) => customerCardHtml(contact, rooms, canAssign)).join('');
      return heading + cards;
    }).join('');
  } else {
    bodyHtml = rows.map(({ contact, rooms }) => customerCardHtml(contact, rooms, canAssign)).join('');
  }

  view.innerHTML = `
    <div class="project-stage-tabs-bar">
      ${stageTabs}
    </div>
    ${sortBar}
    <div class="projects-inner">
      ${bodyHtml}
    </div>
  `;

  view.querySelector('.project-stage-tabs-bar').addEventListener('click', function(e) {
    const btn = e.target.closest('[data-stage-filter]');
    if (!btn) return;
    setProjectStageFilter(btn.dataset.stageFilter);
  });

  const sortSelect = view.querySelector('#project-sort-select');
  if (sortSelect) sortSelect.addEventListener('change', () => setProjectSort(sortSelect.value));

  const groupBtn = view.querySelector('#project-group-btn');
  if (groupBtn) groupBtn.addEventListener('click', toggleProjectGroupByStage);

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

function fmtInstallDate(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d)) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function customerCardHtml(contact, rooms, isAdmin) {
  const name      = escHtml(contactName(contact));
  const contactId = escHtml(contact.id || '');

  const earliestInstall = rooms
    .map(r => r.installStart)
    .filter(Boolean)
    .sort()[0] || null;
  const installLabel = earliestInstall ? fmtInstallDate(earliestInstall) : null;

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

  let invoiceSection = '';
  if (!state.qb.statusKnown || state.qb.loading || (state.qb.connected && !state.qb.loaded)) {
    invoiceSection = `
      <div class="project-card-invoices" style="pointer-events:none">
        <div class="skeleton-line" style="height:10px;width:72px"></div>
        <div class="skeleton-line" style="height:10px;width:48px;margin-top:4px"></div>
      </div>`;
  } else if (state.qb.connected) {
    const invs  = matchInvoicesForContact(contact);
    if (invs.length) {
      const total = invs.reduce((s, inv) => s + inv.balance, 0);
      const count = invs.length;
      const invIdsAttr = escHtml(JSON.stringify(invs.map(i => i.id)));
      invoiceSection = `
        <div class="project-card-invoices">
          <button class="qb-badge" title="${count} outstanding invoice${count !== 1 ? 's' : ''}" data-inv-ids="${invIdsAttr}" onclick="openInvoicePanelFromBadge(this)">${fmtGBP(total)}</button>
        </div>`;
    }
  }

  const installHtml = installLabel
    ? `<span class="project-card-install-date">Install: ${escHtml(installLabel)}</span>`
    : '';

  return `
    <div class="customer-project-card">
      <div class="customer-project-header">
        <div class="customer-project-name-row">
          <div class="customer-project-name">${name}</div>
          ${installHtml}
        </div>
        <div class="customer-project-id">#${contactId}</div>
      </div>
      <div class="project-room-list">
        ${roomRows}
      </div>
      ${invoiceSection}
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
    if (e.code === 'HUBSPOT_AUTH') {
      showToast('Could not save assignment — HubSpot token is invalid or expired. Ask an admin to update the token.', true);
    } else if (e.code === 'HUBSPOT_RATE_LIMIT') {
      showToast('Could not save assignment — HubSpot rate limit reached. Please try again in a moment.', true);
    } else {
      showToast('Failed to save assignment', true);
    }
  }
}
