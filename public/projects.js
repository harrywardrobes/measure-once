// ── Projects View ─────────────────────────────────────────────────────────────
function setProjectStageFilter(key) {
  state.projectStageFilter = key;
  renderProjectsView();
}

function renderProjectsView() {
  const view = document.getElementById('projects-view');
  if (!view) return;

  const filter = state.projectStageFilter;

  // Collect contacts that have at least one active room with saved data
  const rows = [];
  for (const contact of state.contacts) {
    const cached = state.contactStageCache[contact.id];
    if (!cached || cached.length === 0) continue;
    const activeRooms = cached
      .map((r, idx) => ({ ...r, roomIdx: idx }))
      .filter(r => (r.roomStatus || 'active') === 'active')
      .filter(r => !filter || r.stageKey === filter);
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
    ...STAGE_KEYS.map(k => ({ key: k, label: state.workflow?.stages?.[k]?.label || k }))
  ].map(({ key, label }) => {
    const colour  = key ? stageColour(key) : null;
    const active  = filter === key;
    const style   = active && colour
      ? `background:${colour.bg};color:#fff;border-color:${colour.bg}`
      : active
        ? 'background:var(--plum);color:#fff;border-color:var(--plum)'
        : '';
    return `<button class="project-stage-tab ${active ? 'project-stage-tab-active' : ''}"
      style="${style}" data-stage-filter="${escHtml(key)}">${escHtml(label)}</button>`;
  }).join('');

  const bodyHtml = !rows.length
    ? `<p style="color:var(--stone-deep);font-size:0.875rem;padding:8px 0;">No projects at this stage.</p>`
    : rows.map(({ contact, rooms }) => customerCardHtml(contact, rooms)).join('');

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
}

function customerCardHtml(contact, rooms) {
  const name = escHtml(contactName(contact));
  const contactId = escHtml(contact.id || '');

  const roomRows = rooms.map(r => {
    const colour     = stageColour(r.stageKey);
    const stageLabel = escHtml(state.workflow?.stages?.[r.stageKey]?.label || r.stageKey);
    const roomLabel  = escHtml(r.room || 'Main');
    return `
      <div class="project-room-row" onclick="openProject('${contact.id}', ${r.roomIdx})">
        <span class="project-room-row-name">${roomLabel}</span>
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
