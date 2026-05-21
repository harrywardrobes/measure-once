// ── Sales Stage Keys ──────────────────────────────────────────────────────────
const SALES_TAB_STAGES = ['sales', 'designvisit', 'survey'];

// Terminal/cold substage ids — de-emphasised in the list
const TERMINAL_SUBSTAGES = new Set(['unqualified', 'not_suitable', 'bad_timing', 'no_response_x3']);

// Source sub-sub-stage short labels
const SOURCE_LABELS = {
  website:   'Web',
  whatsapp:  'WhatsApp',
  call:      'Call',
  instagram: 'IG',
  facebook:  'FB',
  email:     'Email',
};

// ── Data loading ──────────────────────────────────────────────────────────────
// Sales page needs ALL contacts (sales + design visit + survey), not just
// "open leads". Override the open-leads loader so bootstrap uses loadAllContacts.
registerOpenLeadsLoader(loadAllContacts);

// ── Renderer registration ─────────────────────────────────────────────────────
registerCustomerListRenderer(() => renderEnquiryList());
registerProjectsViewRenderer(() => renderEnquiryList());

// ── Stage filter ──────────────────────────────────────────────────────────────
function setSalesStageFilter(key) {
  state.salesStageFilter = key;
  renderEnquiryList();
}

// ── Priority sort ─────────────────────────────────────────────────────────────
// Returns a numeric band: 0 = most urgent, 3 = cold/archived.
// Within bands, callers sort by createdate descending (newest first).
function priorityScore(stageKey, substageId) {
  if (stageKey === 'designvisit' && substageId === 'open_deal') return 0;
  if (stageKey === 'survey'      && substageId === 'design_accepted') return 1;
  if (TERMINAL_SUBSTAGES.has(substageId)) return 3;
  return 2;
}

// ── Relative time ─────────────────────────────────────────────────────────────
function relativeTime(input) {
  if (!input) return '';
  const ts = typeof input === 'number' ? input : Number(input);
  if (!ts || isNaN(ts)) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins}m ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86400000);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// ── Sub-stage label lookup ────────────────────────────────────────────────────
function substageLabel(stageKey, substageId) {
  if (!substageId) return '';
  const stage = state.workflow?.stages?.[stageKey];
  if (!stage) return substageId;
  const status = (stage.statuses || []).find(s => s.id === substageId);
  return status ? status.label : substageId;
}

// ── Sub-stage pill colour ─────────────────────────────────────────────────────
function substagePillColour(stageKey, substageId) {
  if (TERMINAL_SUBSTAGES.has(substageId)) {
    return { bg: 'var(--stone-soft)', text: 'var(--ink-4)' };
  }
  if (stageKey === 'designvisit' && substageId === 'open_deal') {
    return { bg: '#dbeafe', text: '#1d4ed8' };
  }
  if (stageKey === 'survey' && substageId === 'design_accepted') {
    return { bg: '#d1fae5', text: '#047857' };
  }
  if (substageId === 'form_submission' || substageId === 'attempted_contact') {
    return { bg: '#fef3c7', text: '#b45309' };
  }
  return { bg: '#ccfbf1', text: '#0f766e' };
}

// ── One-time event delegation ─────────────────────────────────────────────────
let _salesListenersInited = false;
function _initSalesListeners() {
  if (_salesListenersInited) return;
  const panel = document.getElementById('list-panel');
  if (!panel) return;
  _salesListenersInited = true;

  panel.addEventListener('click', function(e) {
    const stageBtn = e.target.closest('[data-sales-stage]');
    if (stageBtn) { setSalesStageFilter(stageBtn.dataset.salesStage); return; }

    if (e.target.closest('#sales-new-btn')) { openNewCustomerModal(); return; }

    const row = e.target.closest('[data-contact-id]');
    if (row) {
      location.href = `/customers/${encodeURIComponent(row.dataset.contactId)}`;
    }
  });

  // Re-fetch both contacts and localdata then re-render when a detail save fires.
  document.addEventListener('localdata-updated', async () => {
    await Promise.all([loadAllContacts(), loadWorkflowStages()]);
    state.filteredContacts = [...state.contacts];
    renderEnquiryList();
  });
}

// ── Best room selector (one row per contact) ──────────────────────────────────
// From all active rooms for a contact in the target stages (filtered if needed),
// return the single room that represents the highest-priority action.
// Priority: lowest band first; within band, keep whichever appears first in the
// cache (data insertion order reflects original creation).
function _bestRoom(cached, filter) {
  if (!cached || cached.length === 0) return null;

  let best = null;
  let bestScore = Infinity;

  for (let idx = 0; idx < cached.length; idx++) {
    const r = cached[idx];
    if ((r.roomStatus || 'active') !== 'active') continue;
    if (!SALES_TAB_STAGES.includes(r.stageKey)) continue;
    if (filter && r.stageKey !== filter) continue;

    const score = priorityScore(r.stageKey, r.statusId || '');
    if (score < bestScore) {
      bestScore = score;
      best = { ...r, roomIdx: idx };
    }
  }
  return best;
}

// ── Main render ───────────────────────────────────────────────────────────────
async function renderEnquiryList() {
  const view = document.getElementById('sales-view');
  if (!view) return;

  _initSalesListeners();

  const filter = state.salesStageFilter || '';

  // ── Collect one entry per contact ─────────────────────────────────────────
  const entries = [];
  for (const contact of state.filteredContacts) {
    const cached = state.contactStageCache[contact.id];
    const createdate = parseInt(contact.properties?.createdate || '0', 10);

    if (!cached || cached.length === 0) {
      // No local data yet — treat as Sales stage, no substage known
      if (!filter || filter === 'sales') {
        entries.push({
          contact,
          stageKey: 'sales',
          substageId: '',
          sourceId: '',
          createdate,
          priority: 2,
        });
      }
      continue;
    }

    const best = _bestRoom(cached, filter);
    if (!best) continue;

    // Prefer the recorded date the contact entered their current substage;
    // fall back to the stage entry date, then to contact createdate.
    const statusId = best.statusId || '';
    const substageDate = statusId && best.substateDates?.[statusId]
      ? new Date(best.substateDates[statusId] + 'T00:00:00').getTime()
      : null;
    const stageEntryDate = best.stageDates?.[best.stageKey]
      ? new Date(best.stageDates[best.stageKey] + 'T00:00:00').getTime()
      : null;

    entries.push({
      contact,
      stageKey: best.stageKey,
      substageId: statusId,
      sourceId: best.sourceId || '',
      createdate,
      stageTime: substageDate || stageEntryDate || createdate,
      priority: priorityScore(best.stageKey, statusId),
      roomIdx: best.roomIdx,
    });
  }

  // ── Sort: priority band asc, then createdate desc (newest first) ──────────
  entries.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.createdate - a.createdate;
  });

  // ── Stage tab bar ─────────────────────────────────────────────────────────
  const tabs = [
    { key: '', label: 'All' },
    ...SALES_TAB_STAGES.map(k => ({
      key: k,
      label: state.workflow?.stages?.[k]?.label || k,
    })),
  ].map(({ key, label }) => {
    const active = filter === key;
    const colour = key ? stageColour(key) : null;
    const style = active && colour
      ? `background:${colour.bg};color:#fff;border-color:${colour.bg}`
      : active ? 'background:var(--plum);color:#fff;border-color:var(--plum)' : '';
    return `<button class="project-stage-tab${active ? ' project-stage-tab-active' : ''}"
      style="${style}" data-sales-stage="${escHtml(key)}">${escHtml(label)}</button>`;
  }).join('');

  // ── Rows ──────────────────────────────────────────────────────────────────
  const bodyHtml = entries.length
    ? entries.map(e => enquiryRowHtml(e)).join('')
    : `<p class="projects-empty-msg">No enquiries at this stage.</p>`;

  view.innerHTML = `
    <div class="project-stage-tabs-bar">
      ${tabs}
      <button class="sales-new-btn" id="sales-new-btn" title="New Enquiry">
        <svg width="11" height="11" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/>
        </svg>
        New
      </button>
    </div>
    <div class="enquiry-list">
      ${bodyHtml}
    </div>
  `;
}

// ── Row HTML ──────────────────────────────────────────────────────────────────
function enquiryRowHtml(entry) {
  const { contact, stageKey, substageId, sourceId, stageTime, priority } = entry;
  const isTerminal = priority === 3;

  const name        = escHtml(contactName(contact));
  const customerNum = contact.properties?.customer_number || '';
  const stageLabel  = escHtml(state.workflow?.stages?.[stageKey]?.label || stageKey);
  const subLabel    = escHtml(substageLabel(stageKey, substageId));
  const timeStr     = escHtml(relativeTime(stageTime));
  const pillColour  = substagePillColour(stageKey, substageId);

  const customerNumHtml = customerNum
    ? `<span class="enquiry-row-custnum">${escHtml(customerNum)}</span>`
    : '';

  const pillHtml = substageId
    ? `<span class="enquiry-row-pill${isTerminal ? ' enquiry-row-pill-terminal' : ''}"
         style="background:${pillColour.bg};color:${pillColour.text}">${subLabel}</span>`
    : `<span class="enquiry-row-pill enquiry-row-pill-terminal"
         style="background:var(--stone-soft);color:var(--ink-4)">${stageLabel}</span>`;

  const sourceHtml = sourceId && SOURCE_LABELS[sourceId]
    ? `<span class="enquiry-row-source">${escHtml(SOURCE_LABELS[sourceId])}</span>`
    : '';

  const stageTagHtml = `<span class="enquiry-row-stagelabel">${stageLabel}</span>`;

  return `
    <div class="enquiry-row${isTerminal ? ' enquiry-row-terminal' : ''}"
         data-contact-id="${escHtml(contact.id)}"
         role="button" tabindex="0">
      <div class="enquiry-row-main">
        <div class="enquiry-row-name-wrap">
          <span class="enquiry-row-name">${name}</span>
          ${customerNumHtml}
        </div>
        <div class="enquiry-row-meta">
          ${stageTagHtml}
          ${pillHtml}
          ${sourceHtml}
        </div>
      </div>
      <div class="enquiry-row-time">${timeStr}</div>
    </div>`;
}
