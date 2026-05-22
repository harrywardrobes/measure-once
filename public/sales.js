// ── Sales Stage Keys ──────────────────────────────────────────────────────────
const SALES_TAB_STAGES = ['sales', 'designvisit'];

// Full 3-stage pipeline used for the stage trail on cards (survey is a separate page).
const PIPELINE_ALL_STAGES = ['sales', 'designvisit', 'survey'];

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
  if (substageId === 'OPEN_DEAL' || substageId === 'VISIT_SCHEDULED') {
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

  // No "All" tab — default to the first stage
  if (!state.salesStageFilter || !SALES_TAB_STAGES.includes(state.salesStageFilter)) {
    state.salesStageFilter = SALES_TAB_STAGES[0];
  }
  const filter = state.salesStageFilter;

  // ── Collect ALL entries across every stage ────────────────────────────────
  const EXCLUDED_LEAD_STATUSES = new Set(LEAD_STATUS_OPTIONS.filter(o => o.excluded_from_sales).map(o => o.value));
  const allEntries = [];
  for (const contact of state.filteredContacts) {
    const ls = (contact.properties?.hs_lead_status || '').toUpperCase();
    if (EXCLUDED_LEAD_STATUSES.has(ls)) continue;
    const cached    = state.contactStageCache[contact.id];
    const createdate = parseInt(contact.properties?.createdate || '0', 10);

    if (!cached || cached.length === 0) {
      const lsColumn = HS_STATUS_COLUMN[ls] || 'sales';
      const lsOpt    = ls ? LEAD_STATUS_OPTIONS.find(o => o.value === ls) : null;
      allEntries.push({
        contact,
        stageKey:   lsColumn,
        substageId: ls || '',
        badgeLabel: lsOpt ? lsOpt.label : '',
        sourceId:   '',
        createdate, stageTime: createdate, priority: 2,
      });
      continue;
    }

    const best = _bestRoom(cached, ''); // '' = no stage filter
    if (!best) continue;

    const statusId      = best.statusId || '';
    const substageDate  = statusId && best.substateDates?.[statusId]
      ? new Date(best.substateDates[statusId] + 'T00:00:00').getTime() : null;
    const stageEntryDate = best.stageDates?.[best.stageKey]
      ? new Date(best.stageDates[best.stageKey] + 'T00:00:00').getTime() : null;

    // Override the room's column with the HubSpot lead status if it maps to
    // a different column — local room substage/badge is still preserved.
    const lsColumn   = HS_STATUS_COLUMN[ls];
    const finalStage = lsColumn || best.stageKey;

    // When the room has no substage but the column is driven by lead status,
    // surface the lead status as the badge label.
    const lsOpt2    = (!statusId && lsColumn) ? LEAD_STATUS_OPTIONS.find(o => o.value === ls) : null;
    const roomBadge = lsOpt2 ? lsOpt2.label : '';

    allEntries.push({
      contact,
      stageKey:   finalStage,
      substageId: statusId,
      badgeLabel: roomBadge,
      sourceId:   best.sourceId || '',
      createdate,
      stageTime:  substageDate || stageEntryDate || createdate,
      priority:   priorityScore(finalStage, statusId),
      roomIdx:    best.roomIdx,
    });
  }

  // ── Drop stale Sales-column entries (last modified > 4 weeks ago) ─────────
  const FOUR_WEEKS_MS = 4 * 7 * 24 * 60 * 60 * 1000;
  const staleCutoff   = Date.now() - FOUR_WEEKS_MS;
  const visibleEntries = allEntries.filter(e => {
    if (e.stageKey !== 'sales') return true;
    const raw = e.contact.properties?.lastmodifieddate;
    if (!raw) return true;
    const lmd = new Date(raw).getTime();
    return !isNaN(lmd) && lmd >= staleCutoff;
  });

  // ── Sort: priority band asc, then newest first ────────────────────────────
  visibleEntries.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.createdate - a.createdate;
  });

  // ── Group by stage ────────────────────────────────────────────────────────
  const byStage = Object.fromEntries(SALES_TAB_STAGES.map(k => [k, []]));
  for (const e of visibleEntries) {
    if (byStage[e.stageKey]) byStage[e.stageKey].push(e);
  }

  // ── Mobile tab pills ──────────────────────────────────────────────────────
  const tabs = SALES_TAB_STAGES.map(k => {
    const label  = escHtml(state.workflow?.stages?.[k]?.label ||
      (k === 'designvisit' ? 'Design Visit' : k === 'survey' ? 'Survey' : 'Sales'));
    const active = filter === k;
    const hex    = STAGE_ACCENT[k] || '#8B2BFF';
    const style  = active ? `background:${hex};color:#fff;border-color:${hex}` : '';
    return `<button class="project-stage-tab${active ? ' project-stage-tab-active' : ''}"
      style="${style}" data-sales-stage="${k}">${label}</button>`;
  }).join('');

  // ── Build 3 columns ───────────────────────────────────────────────────────
  const colsHtml = SALES_TAB_STAGES.map(sk => {
    const label    = escHtml(state.workflow?.stages?.[sk]?.label ||
      (sk === 'designvisit' ? 'Design Visit' : sk === 'survey' ? 'Survey' : 'Sales'));
    const entries  = byStage[sk];
    const count    = entries.length;
    const hex      = STAGE_ACCENT[sk] || '#8B2BFF';
    const rgb      = _eqRgb(hex);
    const isActive = filter === sk;
    const cardsHtml = entries.length
      ? entries.map(e => enquiryRowHtml(e)).join('')
      : `<p class="projects-empty-msg">Nothing here yet.</p>`;
    const badge = count
      ? `<span class="eq-col-header-count" style="background:rgba(${rgb},0.1);color:${hex}">${count}</span>` : '';
    return `
      <div class="eq-col${isActive ? ' eq-col-active' : ''}" data-col="${sk}">
        <div class="eq-col-header" style="border-top:3px solid ${hex}">
          <span class="eq-col-header-label">${label}</span>
          ${badge}
        </div>
        <div class="enquiry-list">${cardsHtml}</div>
      </div>`;
  }).join('');

  view.innerHTML = `
    <div class="sales-stage-bar">
      ${tabs}
      <button class="sales-new-btn" id="sales-new-btn" title="New Enquiry">
        <svg width="11" height="11" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"/>
        </svg>
        New
      </button>
    </div>
    <div class="sales-board">
      ${colsHtml}
    </div>
  `;
}

// ── Lead-status → column map ──────────────────────────────────────────────────
// Statuses not listed here (NOT_SUITABLE, UNQUALIFIED) are excluded upstream.
const HS_STATUS_COLUMN = {
  OPEN_DEAL:            'designvisit',
  VISIT_SCHEDULED:      'designvisit',
  NEW:                  'sales',
  OPEN:                 'sales',
  IN_PROGRESS:          'sales',
  CONNECTED:            'sales',
  ATTEMPTED_TO_CONTACT: 'sales',
  BAD_TIMING:           'sales',
};

// ── Stage accent hex colours (B1 card design) ────────────────────────────────
const STAGE_ACCENT = {
  sales:       '#8B2BFF',
  designvisit: '#2563EB',
  survey:      '#059669',
};
function _eqRgb(hex) {
  return `${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)}`;
}

// ── Next action label ─────────────────────────────────────────────────────────
function nextActionLabel(stageKey, substageId) {
  if (stageKey === 'sales') {
    if (substageId === 'form_submission')   return 'Attempt contact';
    if (substageId === 'attempted_contact') return 'Follow up call';
    if (substageId === 'open_deal')         return 'Schedule design visit';
  }
  if (stageKey === 'designvisit') return 'Confirm design visit date';
  if (stageKey === 'survey')      return 'Await survey confirmation';
  return '';
}

// ── Stage trail HTML ──────────────────────────────────────────────────────────
function stageTrailHtml(activeKey, isTerminal) {
  const idx = PIPELINE_ALL_STAGES.indexOf(activeKey);
  const segs = PIPELINE_ALL_STAGES.map((sk, i) => {
    const done   = i < idx;
    const active = i === idx;
    const label  = escHtml(
      state.workflow?.stages?.[sk]?.label ||
      (sk === 'designvisit' ? 'Design Visit' : sk === 'survey' ? 'Survey' : 'Sales')
    );
    const hex       = isTerminal ? '#B8AE99' : (STAGE_ACCENT[sk] || '#8B2BFF');
    const dotColor  = (done || active) ? hex : '#D9D2C2';
    const lineColor = done ? hex : '#D9D2C2';
    const labelColor = (done || active) ? hex : '#97927F';
    const dotStyle  = `background:${dotColor}${active ? `;outline:3px solid rgba(${_eqRgb(hex)},0.16);outline-offset:1px` : ''}`;
    const dotCls    = `eq-trail-dot${active ? ' eq-trail-dot-active' : ''}`;
    const labelStyle = `color:${labelColor};font-weight:${active ? 700 : 400};opacity:${done ? 0.65 : 1}`;
    const isLast    = i === PIPELINE_ALL_STAGES.length - 1;
    return (
      `<div class="eq-trail-seg"><div class="${dotCls}" style="${dotStyle}"></div><span class="eq-trail-label" style="${labelStyle}">${label}</span></div>` +
      (!isLast ? `<div class="eq-trail-rail" style="background:${lineColor};opacity:${done ? 0.7 : 0.4}"></div>` : '')
    );
  });
  return `<div class="eq-trail">${segs.join('')}</div>`;
}

// ── Row HTML ──────────────────────────────────────────────────────────────────
function enquiryRowHtml(entry) {
  const { contact, stageKey, substageId, sourceId, stageTime, priority, badgeLabel } = entry;
  const isTerminal = priority === 3;

  const name        = escHtml(contactName(contact));
  const customerNum = contact.properties?.customer_number || '';
  const subLabel    = escHtml(badgeLabel || substageLabel(stageKey, substageId));
  const timeStr     = escHtml(relativeTime(stageTime));

  const numHtml = customerNum
    ? `<span class="eq-card-num">${escHtml(customerNum)}</span>` : '';

  let pillHtml = '';
  if (substageId || badgeLabel) {
    if (isTerminal) {
      pillHtml = `<span class="eq-card-substage eq-card-substage-terminal">${subLabel}</span>`;
    } else {
      const pc = substagePillColour(stageKey, substageId);
      pillHtml = `<span class="eq-card-substage" style="background:${pc.bg};color:${pc.text};border:1px solid ${pc.bg}">${subLabel}</span>`;
    }
  }

  const sourceHtml = sourceId && SOURCE_LABELS[sourceId]
    ? `<span class="eq-card-source"><span class="eq-card-source-dot"></span>${escHtml(SOURCE_LABELS[sourceId])}</span>`
    : '';

  const accentColor = isTerminal ? '#B8AE99' : (STAGE_ACCENT[stageKey] || 'var(--orchid)');
  const next        = isTerminal ? '' : nextActionLabel(stageKey, substageId);
  const actionHtml  = next ? `
    <div class="eq-card-action">
      <span class="eq-card-action-label">${escHtml(next)}</span>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
    </div>` : '';

  return `
    <div class="eq-card${isTerminal ? ' eq-card-terminal' : ''}"
         data-contact-id="${escHtml(contact.id)}"
         role="button" tabindex="0">
      <div class="eq-card-stripe" style="background:${accentColor}"></div>
      <div class="eq-card-body">
        <div class="eq-card-name-row">
          <div class="eq-card-name-wrap">
            <span class="eq-card-name">${name}</span>
            ${numHtml}
          </div>
          <span class="eq-card-time">${timeStr}</span>
        </div>
        <div class="eq-card-meta">
          ${pillHtml}
          ${sourceHtml}
        </div>
        ${stageTrailHtml(stageKey, isTerminal)}
      </div>
      ${actionHtml}
    </div>`;
}
