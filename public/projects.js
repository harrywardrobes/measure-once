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
    : rows.map(({ contact, rooms }) => `
        <div class="project-row">
          <div class="project-row-name">${escHtml(contactName(contact))}</div>
          <div class="project-cards-scroll">
            ${rooms.map(r => projectCardHtml(contact.id, r)).join('')}
          </div>
        </div>
      `).join('');

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

function projectCardHtml(contactId, room) {
  const colour     = stageColour(room.stageKey);
  const stageLabel = state.workflow?.stages?.[room.stageKey]?.label || room.stageKey;
  const stageIdx   = STAGE_KEYS.indexOf(room.stageKey);
  const progress   = Math.round((stageIdx + 1) / STAGE_KEYS.length * 100);
  return `
    <div class="project-card" onclick="openProject('${contactId}', ${room.roomIdx})">
      <div class="project-card-room">${escHtml(room.room || 'Main')}</div>
      <span class="stage-pill" style="background:${colour.light};color:${colour.text}">${escHtml(stageLabel)}</span>
      <div class="project-progress-bar">
        <div class="project-progress-fill" style="width:${progress}%;background:${colour.bg}"></div>
      </div>
      <div class="project-progress-label">${stageIdx + 1} of ${STAGE_KEYS.length} stages</div>
    </div>
  `;
}

