// ── Sales Stage Keys (the three early-pipeline stages shown on this tab) ────────
const SALES_TAB_STAGES = ['sales', 'designvisit', 'survey'];

// ── Sales Card List View ──────────────────────────────────────────────────────
// On the sales page both renderCustomerList() and renderProjectsView() should
// update the sales grid.  Register explicitly so the wiring is clear and safe
// regardless of script load order (workflow.js and projects.js register their
// own impls first; these calls replace those registrations for this page).
registerCustomerListRenderer(() => renderSalesView());
registerProjectsViewRenderer(() => renderSalesView());

function setSalesStageFilter(key) {
  state.salesStageFilter = key;
  renderSalesView();
}

// One-time event delegation on the stable #list-panel — avoids listener
// accumulation across repeated renderSalesView() calls.
let _salesListenersInited = false;
function _initSalesListeners() {
  if (_salesListenersInited) return;
  const panel = document.getElementById('list-panel');
  if (!panel) return;
  _salesListenersInited = true;

  panel.addEventListener('click', function(e) {
    // Stage tab button
    const stageBtn = e.target.closest('[data-sales-stage]');
    if (stageBtn) { setSalesStageFilter(stageBtn.dataset.salesStage); return; }

    // New customer button
    if (e.target.closest('#sales-new-btn')) { openNewCustomerModal(); return; }

    // Fitter chip — open assignment picker (admin/manager only)
    const chip = e.target.closest('[data-fitter-contact-id]');
    if (chip) {
      e.stopPropagation();
      openFitterPicker(chip.dataset.fitterContactId, parseInt(chip.dataset.fitterRoomIdx, 10));
      return;
    }

    // Room row — open standalone customer detail page
    const row = e.target.closest('[data-contact-id]');
    if (row) {
      const contactId = row.dataset.contactId;
      const roomIdx = parseInt(row.dataset.roomIdx, 10) || 0;
      location.href = roomIdx ? `/customers/${contactId}?room=${roomIdx}` : `/customers/${contactId}`;
    }
  });
}

async function renderSalesView() {
  const view = document.getElementById('sales-view');
  if (!view) return;

  _initSalesListeners();

  await ensureProjectPlatformUsers();

  const filter    = state.salesStageFilter || '';
  const privLevel = state.user?.privilege_level || 'member';
  const canAssign = !!state.user?.isAdmin || privLevel === 'manager' || privLevel === 'admin';

  // Build stage tabs: All + 3 target stages
  const stageTabs = [
    { key: '', label: 'All' },
    ...SALES_TAB_STAGES.map(k => ({ key: k, label: state.workflow?.stages?.[k]?.label || k }))
  ].map(({ key, label }) => {
    const colour = key ? stageColour(key) : null;
    const active  = filter === key;
    const style   = active && colour
      ? `background:${colour.bg};color:#fff;border-color:${colour.bg}`
      : active
        ? 'background:var(--plum);color:#fff;border-color:var(--plum)'
        : '';
    return `<button class="project-stage-tab ${active ? 'project-stage-tab-active' : ''}"
      style="${style}" data-sales-stage="${escHtml(key)}">${escHtml(label)}</button>`;
  }).join('');

  // Collect contacts with rooms in the target stages
  const rows = [];
  for (const contact of state.filteredContacts) {
    const cached = state.contactStageCache[contact.id];
    if (!cached || cached.length === 0) {
      // No local data yet — contact is implicitly at Sales stage
      if (!filter || filter === 'sales') {
        rows.push({ contact, rooms: [{ room: 'Main', stageKey: 'sales', roomStatus: 'active', roomIdx: 0, assignedFitterId: null }] });
      }
      continue;
    }
    const qualifying = cached
      .map((r, idx) => ({ ...r, roomIdx: idx }))
      .filter(r => (r.roomStatus || 'active') === 'active')
      .filter(r => SALES_TAB_STAGES.includes(r.stageKey))
      .filter(r => !filter || r.stageKey === filter);
    if (!qualifying.length) continue;
    rows.push({ contact, rooms: qualifying });
  }

  // Sort alphabetically by customer name
  rows.sort((a, b) => contactName(a.contact).localeCompare(contactName(b.contact)));

  const bodyHtml = !rows.length
    ? `<p class="projects-empty-msg">No customers at this stage.</p>`
    : rows.map(({ contact, rooms }) => salesCustomerCardHtml(contact, rooms, canAssign)).join('');

  view.innerHTML = `
    <div class="project-stage-tabs-bar">
      ${stageTabs}
      <button class="sales-new-btn" id="sales-new-btn" title="New Customer">
        <svg width="11" height="11" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/>
        </svg>
        New
      </button>
    </div>
    <div class="projects-inner">
      ${bodyHtml}
    </div>
  `;
}

function salesCustomerCardHtml(contact, rooms, canAssign) {
  const name        = escHtml(contactName(contact));
  const customerNum = contact.properties?.customer_number || '';

  const roomRows = rooms.map(r => {
    const colour     = stageColour(r.stageKey);
    const stageLabel = escHtml(state.workflow?.stages?.[r.stageKey]?.label || r.stageKey);
    const roomLabel  = escHtml(r.room || 'Main');
    const chip       = fitterChipHtml(r, contact.id, canAssign);
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
        ${customerNum ? `<div class="customer-project-id">${escHtml(customerNum)}</div>` : ''}
      </div>
      <div class="project-room-list">
        ${roomRows}
      </div>
    </div>`;
}

