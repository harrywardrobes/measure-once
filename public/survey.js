// ── Survey page ───────────────────────────────────────────────────────────────
const SURVEY_STAGE_KEY    = 'survey';
const SURVEY_ALL_STAGES   = ['sales', 'designvisit', 'survey']; // full pipeline for trail

const SURVEY_TERMINAL_SUBSTAGES = new Set(['unqualified', 'not_suitable', 'bad_timing', 'no_response_x3']);

const SURVEY_SUBSTAGE_FILTER_OPTIONS = [
  { id: 'unqualified',    label: 'Unqualified' },
  { id: 'not_suitable',   label: 'Not Suitable' },
  { id: 'bad_timing',     label: 'Bad Timing' },
  { id: 'no_response_x3', label: 'No Response \u00d73' },
];

const SURVEY_HIDDEN_KEY = 'surveyHiddenSubstages';

const SURVEY_SOURCE_LABELS = {
  website:   'Web',
  whatsapp:  'WhatsApp',
  call:      'Call',
  instagram: 'IG',
  facebook:  'FB',
  email:     'Email',
};

const SURVEY_ACCENT = {
  sales:       '#8B2BFF',
  designvisit: '#2563EB',
  survey:      '#059669',
};
const SURVEY_ACTION_TINT = '#D1FAE5';
const SURVEY_ACTION_TEXT = '#047857';

function _svRgb(hex) {
  return `${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)}`;
}

// ── Substage filter state ─────────────────────────────────────────────────────
function _initSurveyHiddenSubstages() {
  if (state.surveyHiddenSubstages) return;
  try {
    const saved = localStorage.getItem(SURVEY_HIDDEN_KEY);
    state.surveyHiddenSubstages = saved !== null
      ? new Set(JSON.parse(saved))
      : new Set(['unqualified', 'not_suitable']);
  } catch (_) {
    state.surveyHiddenSubstages = new Set(['unqualified', 'not_suitable']);
  }
  if (state.surveySubstageFilterOpen === undefined) state.surveySubstageFilterOpen = false;
}

function _saveSurveyHiddenSubstages() {
  try {
    localStorage.setItem(SURVEY_HIDDEN_KEY, JSON.stringify([...state.surveyHiddenSubstages]));
  } catch (_) {}
}

// ── Bootstrap hooks ───────────────────────────────────────────────────────────
// Load ALL contacts so that contacts that progressed through sales/designvisit
// and are now in survey are available.
registerOpenLeadsLoader(loadAllContacts);
// Re-render on search/filter changes driven by core.js.
registerCustomerListRenderer(() => renderSurveyList());

// ── Helpers ───────────────────────────────────────────────────────────────────
function _svPriorityScore(substageId) {
  if (substageId === 'design_accepted')           return 1;
  if (SURVEY_TERMINAL_SUBSTAGES.has(substageId))  return 3;
  return 2;
}

function _svRelativeTime(input) {
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
  return `${Math.floor(days / 30)}mo ago`;
}

function _svSubstageLabel(substageId) {
  if (!substageId) return '';
  const stage = state.workflow?.stages?.[SURVEY_STAGE_KEY];
  if (!stage) return substageId;
  const status = (stage.statuses || []).find(s => s.id === substageId);
  return status ? status.label : substageId;
}

// Pick the best active survey-stage room for a contact.
function _svBestRoom(cached) {
  if (!cached || cached.length === 0) return null;
  let best = null, bestScore = Infinity;
  for (let idx = 0; idx < cached.length; idx++) {
    const r = cached[idx];
    if ((r.roomStatus || 'active') !== 'active') continue;
    if (r.stageKey !== SURVEY_STAGE_KEY) continue;
    const score = _svPriorityScore(r.statusId || '');
    if (score < bestScore) { bestScore = score; best = { ...r, roomIdx: idx }; }
  }
  return best;
}

// ── Stage trail (full 3-stage pipeline, survey always active) ─────────────────
function _svTrailHtml(isTerminal) {
  const stages = SURVEY_ALL_STAGES;
  const idx    = stages.indexOf(SURVEY_STAGE_KEY); // 2
  const segs   = stages.map((sk, i) => {
    const done   = i < idx;
    const active = i === idx;
    const label  = escHtml(
      state.workflow?.stages?.[sk]?.label ||
      (sk === 'designvisit' ? 'Design Visit' : sk === 'survey' ? 'Survey' : 'Sales')
    );
    const hex        = isTerminal ? '#B8AE99' : (SURVEY_ACCENT[sk] || '#8B2BFF');
    const dotColor   = (done || active) ? hex : '#D9D2C2';
    const lineColor  = done ? hex : '#D9D2C2';
    const labelColor = (done || active) ? hex : '#97927F';
    const dotStyle   = `background:${dotColor}${active ? `;outline:3px solid rgba(${_svRgb(hex)},0.16);outline-offset:1px` : ''}`;
    const dotCls     = `eq-trail-dot${active ? ' eq-trail-dot-active' : ''}`;
    const labelStyle = `color:${labelColor};font-weight:${active ? 700 : 400};opacity:${done ? 0.65 : 1}`;
    const isLast     = i === stages.length - 1;
    return (
      `<div class="eq-trail-seg"><div class="${dotCls}" style="${dotStyle}"></div><span class="eq-trail-label" style="${labelStyle}">${label}</span></div>` +
      (!isLast ? `<div class="eq-trail-rail" style="background:${lineColor};opacity:${done ? 0.7 : 0.4}"></div>` : '')
    );
  });
  return `<div class="eq-trail">${segs.join('')}</div>`;
}

// ── Card HTML ─────────────────────────────────────────────────────────────────
function _svCardHtml(entry) {
  const { contact, substageId, sourceId, stageTime, priority } = entry;
  const isTerminal = priority === 3;
  const hex = SURVEY_ACCENT[SURVEY_STAGE_KEY];
  const rgb = _svRgb(hex);

  const name        = escHtml(contactName(contact));
  const customerNum = contact.properties?.customer_number || '';
  const postcode    = escHtml((contact.properties?.zip || '').trim().toUpperCase().split(/\s+/)[0]);
  const subLabel    = escHtml(_svSubstageLabel(substageId));
  const lmdRaw      = contact.properties?.lastmodifieddate;
  const lmdMs       = lmdRaw ? new Date(lmdRaw).getTime() : NaN;
  const displayTime = !isNaN(lmdMs) ? lmdMs : stageTime;
  const timeStr     = escHtml(_svRelativeTime(displayTime));

  const numHtml = customerNum
    ? `<span class="eq-card-num">${escHtml(customerNum)}</span>` : '';

  const postcodeHtml = postcode
    ? `<span class="eq-card-postcode">${postcode}</span>` : '';

  // Filled stage pill (clickable for managers when there's a real room)
  const _editable = canEditPrivilege();
  const hasRoom   = Number.isInteger(entry.roomIdx);
  // Stage pill is non-interactive — stage is derived from lead status /
  // sub-status, never set manually.
  const stagePillHtml = isTerminal ? '' :
    `<span class="eq-card-stage-pill" style="background:${hex};color:#fff">Survey</span>`;

  // Substage pill
  let subPillHtml = '';
  if (substageId) {
    if (isTerminal) {
      subPillHtml = `<span class="eq-card-substage eq-card-substage-terminal">${subLabel}</span>`;
    } else {
      const subEditAttrs = (_editable && hasRoom)
        ? `data-card-edit="substage" data-contact-id="${escHtml(contact.id)}" data-room-idx="${entry.roomIdx}" role="button" tabindex="-1" title="Change substage" style="background:rgba(${rgb},0.09);color:${hex};border:1px solid rgba(${rgb},0.22);cursor:pointer"`
        : `style="background:rgba(${rgb},0.09);color:${hex};border:1px solid rgba(${rgb},0.22)"`;
      subPillHtml = `<span class="eq-card-substage" ${subEditAttrs}>${subLabel}</span>`;
    }
  }

  // Source pill (outlined, no dot)
  const sourceHtml = sourceId && SURVEY_SOURCE_LABELS[sourceId]
    ? `<span class="eq-card-source-pill">${escHtml(SURVEY_SOURCE_LABELS[sourceId])}</span>` : '';

  // Fully admin-configurable via the admin Card actions tab.
  //   1. HubSpot hw_lead_substatus → matching sub-status action label.
  //   2. Stage/substage default mapping.
  //   3. '' → action strip omitted entirely.
  let actionLabel = substatusActionLabelLookup(
    contact.properties?.hs_lead_status,
    contact.properties?.hw_lead_substatus,
  );
  if (!actionLabel) {
    // Prefer lead-status over local workflow substageId for the same reason as
    // the Sales board — stage_action_labels is keyed by LS, not by local
    // workflow IDs.
    actionLabel = stageOrLeadStatusActionLabel(
      SURVEY_STAGE_KEY,
      contact.properties?.hs_lead_status,
      substageId,
    );
  }
  const handlerAttrs = cardActionHandlerAttrs(SURVEY_STAGE_KEY, contact.properties?.hs_lead_status, contact.properties?.hw_lead_substatus, {
    contactId:    contact.id,
    contactName:  contactName(contact),
    contactEmail: contact.properties?.email || '',
  });
  const hasHandler = !!handlerAttrs;
  const _cahNameMatch = hasHandler && handlerAttrs.match(/data-card-action-name="([^"]*)"/);
  const _cahName = _cahNameMatch ? _cahNameMatch[1].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '';
  const _stripLabel = _cahName || actionLabel;
  const actionEditAttrs = hasHandler
    ? `${handlerAttrs} role="button" tabindex="-1" title="Run action" style="background:${SURVEY_ACTION_TINT};cursor:pointer"`
    : (_editable
        ? `data-card-edit="leadstatus" data-contact-id="${escHtml(contact.id)}" role="button" tabindex="-1" title="Change lead status" style="background:${SURVEY_ACTION_TINT};cursor:pointer"`
        : `style="background:${SURVEY_ACTION_TINT}"`);
  const actionHtml = (isTerminal || !_stripLabel) ? '' : `
    <div class="eq-card-action" ${actionEditAttrs}>
      <span class="eq-card-action-label" style="color:${SURVEY_ACTION_TEXT}">${escHtml(_stripLabel)}</span>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${SURVEY_ACTION_TEXT}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
    </div>`;

  // Only the body carries data-contact-id / role=button: clicking the bottom
  // action strip must NOT navigate to the customer page.
  return `
    <div class="eq-card${isTerminal ? ' eq-card-terminal' : ''}">
      <div class="eq-card-body"
           data-contact-id="${escHtml(contact.id)}"
           role="button" tabindex="0">
        <div class="eq-card-name-row">
          <div class="eq-card-name-wrap">
            <span class="eq-card-name">${name}</span>
            ${numHtml}
          </div>
          ${postcodeHtml}
        </div>
        <div class="eq-card-meta">
          ${stagePillHtml}
          ${subPillHtml}
          ${sourceHtml}
        </div>
        <div class="eq-card-footer">
          <span class="eq-card-time">Updated ${timeStr}</span>
        </div>
      </div>
      ${actionHtml}
    </div>`;
}

// ── Event delegation ──────────────────────────────────────────────────────────
let _svListenersInited = false;
function _initSurveyListeners() {
  if (_svListenersInited) return;
  const panel = document.getElementById('list-panel');
  if (!panel) return;
  _svListenersInited = true;

  panel.addEventListener('click', function(e) {
    if (e.target.closest('#sv-filter-btn')) {
      state.surveySubstageFilterOpen = !state.surveySubstageFilterOpen;
      renderSurveyList();
      return;
    }
    if (e.target.closest('#sv-new-btn')) { openNewCustomerModal(); return; }

    // Inline manager+ card editing — must run before the row-navigation
    // fallback so clicking a pill never navigates to the customer page.
    const cardEdit = e.target.closest('[data-card-edit]');
    if (cardEdit) {
      e.stopPropagation();
      const cid  = cardEdit.dataset.contactId;
      const kind = cardEdit.dataset.cardEdit;
      const idx  = parseInt(cardEdit.dataset.roomIdx, 10);
      // 'stage' is intentionally NOT handled — workflow stage is derived
      // from lead status and sub-status, never set manually.
      if (kind === 'substage') openCardSubstagePicker({ stopPropagation(){}, currentTarget: cardEdit }, cid, idx);
      else if (kind === 'leadstatus') openLeadStatusPicker({ stopPropagation(){}, currentTarget: cardEdit }, cid);
      return;
    }

    const row = e.target.closest('[data-contact-id]');
    if (row) location.href = `/customers/${encodeURIComponent(row.dataset.contactId)}`;
  });

  panel.addEventListener('change', function(e) {
    const cb = e.target.closest('[data-substage-toggle]');
    if (!cb) return;
    const id = cb.dataset.substageToggle;
    if (state.surveyHiddenSubstages.has(id)) {
      state.surveyHiddenSubstages.delete(id);
    } else {
      state.surveyHiddenSubstages.add(id);
    }
    _saveSurveyHiddenSubstages();
    state.surveySubstageFilterOpen = true;
    renderSurveyList();
  });

  document.addEventListener('click', function(e) {
    if (!state.surveySubstageFilterOpen) return;
    if (!e.target.closest('#sv-filter-wrap')) {
      state.surveySubstageFilterOpen = false;
      document.getElementById('sv-filter-popover')?.classList.remove('substage-filter-popover-open');
    }
  });

  document.addEventListener('localdata-updated', async () => {
    await Promise.all([loadAllContacts(), loadWorkflowStages()]);
    state.filteredContacts = [...state.contacts];
    renderSurveyList();
  });
}

// ── Main render ───────────────────────────────────────────────────────────────
async function renderSurveyList() {
  const view = document.getElementById('survey-view');
  if (!view) return;

  _initSurveyListeners();
  _initSurveyHiddenSubstages();

  // Collect contacts with an active survey-stage room
  const allEntries = [];
  for (const contact of state.filteredContacts) {
    // HubSpot lead status is the source of truth for which board a contact
    // belongs on — locally-cached room.stageKey can be stale after a status
    // change (e.g. moved back from Survey to Design Visit). If the contact
    // has a lead status that the admin has mapped to a non-SURVEY stage,
    // exclude them here even when an old survey-stage room is cached.
    const ls = (contact.properties?.hs_lead_status || '').toUpperCase();
    if (ls) {
      const lsOpt = (typeof LEAD_STATUS_OPTIONS !== 'undefined')
        ? LEAD_STATUS_OPTIONS.find(o => o.value === ls) : null;
      const lsStage = lsOpt?.stage;
      if (lsStage && lsStage !== 'SURVEY') continue;
    }

    const cached     = state.contactStageCache[contact.id];
    const createdate = parseInt(contact.properties?.createdate || '0', 10);
    if (!cached || cached.length === 0) continue;
    const best = _svBestRoom(cached);
    if (!best) continue;

    const statusId       = best.statusId || '';
    const substageDate   = statusId && best.substateDates?.[statusId]
      ? new Date(best.substateDates[statusId] + 'T00:00:00').getTime() : null;
    const stageEntryDate = best.stageDates?.[SURVEY_STAGE_KEY]
      ? new Date(best.stageDates[SURVEY_STAGE_KEY] + 'T00:00:00').getTime() : null;

    allEntries.push({
      contact,
      substageId: statusId,
      sourceId:   best.sourceId || '',
      createdate,
      stageTime:  substageDate || stageEntryDate || createdate,
      priority:   _svPriorityScore(statusId),
      roomIdx:    best.roomIdx,
    });
  }

  allEntries.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.createdate - a.createdate;
  });

  const visibleEntries = allEntries.filter(e =>
    !state.surveyHiddenSubstages.has(e.substageId)
  );

  const hex   = SURVEY_ACCENT[SURVEY_STAGE_KEY];
  const rgb   = _svRgb(hex);
  const label = escHtml(state.workflow?.stages?.[SURVEY_STAGE_KEY]?.label || 'Survey');
  const count = visibleEntries.length;

  const cardsHtml = visibleEntries.length
    ? visibleEntries.map(e => _svCardHtml(e)).join('')
    : UI.renderEmptyState('No surveys yet.', true);

  const badge = count
    ? `<span class="eq-col-header-count" style="background:rgba(${rgb},0.1);color:${hex}">${count}</span>` : '';

  // Substage filter UI
  const hiddenCount = state.surveyHiddenSubstages.size;
  const isOpen      = state.surveySubstageFilterOpen;
  const filterItemsHtml = SURVEY_SUBSTAGE_FILTER_OPTIONS.map(opt => {
    const visible = !state.surveyHiddenSubstages.has(opt.id);
    return `
      <label class="substage-filter-item">
        <input type="checkbox" data-substage-toggle="${escHtml(opt.id)}"${visible ? ' checked' : ''}>
        <span>${escHtml(opt.label)}</span>
      </label>`;
  }).join('');

  const filterHtml = `
    <div class="substage-filter-wrap" id="sv-filter-wrap">
      <button class="substage-filter-btn${isOpen ? ' substage-filter-btn-active' : ''}" id="sv-filter-btn" title="Filter by substage">
        <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h18M7 12h10M11 20h2"/>
        </svg>
        <span>Filter</span>
        ${hiddenCount > 0 ? `<span class="substage-filter-badge">${hiddenCount} hidden</span>` : ''}
      </button>
      <div class="substage-filter-popover${isOpen ? ' substage-filter-popover-open' : ''}" id="sv-filter-popover">
        <p class="substage-filter-heading">Show substages</p>
        ${filterItemsHtml}
      </div>
    </div>`;

  view.innerHTML = `
    <div class="sales-board">
      <div class="eq-col eq-col-active" data-col="survey">
        <div class="eq-col-header" style="border-top:3px solid ${hex}">
          <span class="eq-col-header-label">${label}</span>
          ${badge}
        </div>
        <div class="enquiry-list">${cardsHtml}</div>
      </div>
    </div>
  `;
}
