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
  try { localStorage.setItem('salesStageFilter', key); } catch (_) {}
  renderEnquiryList();
}

// ── Priority sort ─────────────────────────────────────────────────────────────
// Returns a numeric band: 0 = most urgent, 3 = cold/archived.
// Within bands, callers sort by createdate descending (newest first).
// stageKey is always 'sales' or 'designvisit' at call sites — survey rooms are
// excluded by _bestRoom's SALES_TAB_STAGES guard and survey lead-status
// entries are terminal (parked in designvisit column), so that band is unused.
function priorityScore(stageKey, substageId) {
  if (stageKey === 'designvisit' && substageId === 'open_deal') return 0;
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
  if (substageId === 'form_submission' || substageId === 'attempted_contact') {
    return { bg: '#fef3c7', text: '#b45309' };
  }
  return { bg: '#ccfbf1', text: '#0f766e' };
}

// ── Lead-status filter (Enquiries) ────────────────────────────────────────────
function setEnquiryLeadStatusFilter(value) {
  state.enquiryLeadStatusFilter = value;
  renderEnquiryList();
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

    const lsPill = e.target.closest('.eq-ls-pill');
    if (lsPill && !lsPill.disabled) { setEnquiryLeadStatusFilter(lsPill.dataset.lsValue); return; }

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
// The sales board is a 2-column view: 'sales' and 'designvisit'.
// 'survey' rooms are intentionally excluded here. Returning null (empty cache OR
// all rooms outside SALES_TAB_STAGES) signals renderEnquiryList to use the
// lead-status fallback instead — which maps survey → designvisit (terminal) via
// STAGE_COLUMN_INFO. Contacts with only survey-stage rooms therefore still appear
// on the board; they are never silently dropped.
// From all active rooms for a contact in the target stages,
// return the single room that represents the highest-priority action.
// Priority: lowest band first; within band, keep whichever appears first in the
// cache (data insertion order reflects original creation).
function _bestRoom(cached) {
  if (!cached || cached.length === 0) return null;

  let best = null;
  let bestScore = Infinity;

  for (let idx = 0; idx < cached.length; idx++) {
    const r = cached[idx];
    if ((r.roomStatus || 'active') !== 'active') continue;
    if (!SALES_TAB_STAGES.includes(r.stageKey)) continue;

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

  // No "All" tab — default to the first stage, restoring last-used from localStorage
  if (!state.salesStageFilter || !SALES_TAB_STAGES.includes(state.salesStageFilter)) {
    let saved;
    try { saved = localStorage.getItem('salesStageFilter'); } catch (_) {}
    state.salesStageFilter = (saved && SALES_TAB_STAGES.includes(saved)) ? saved : SALES_TAB_STAGES[0];
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

    const best = (!cached || cached.length === 0) ? null : _bestRoom(cached);

    if (!best) {
      // Lead-status fallback: covers contacts with no local rooms AND contacts
      // whose rooms are all in non-sales-board stages (e.g. survey-only rooms).
      // STAGE_COLUMN_INFO maps survey → { column: 'designvisit', terminal: true }
      // so survey-only contacts land in the Design Visit column and are not dropped.
      const lsInfo   = _columnForLeadStatus(ls);
      const lsColumn = lsInfo.column || 'sales';
      const lsOpt    = ls ? LEAD_STATUS_OPTIONS.find(o => o.value === ls) : null;
      allEntries.push({
        contact,
        stageKey:   lsColumn,
        substageId: ls || '',
        badgeLabel: lsOpt ? lsOpt.label : '',
        sourceId:   '',
        createdate, stageTime: createdate,
        priority: lsInfo.terminal ? 3 : 2,
      });
      continue;
    }

    const statusId      = best.statusId || '';
    const substageDate  = statusId && best.substateDates?.[statusId]
      ? new Date(best.substateDates[statusId] + 'T00:00:00').getTime() : null;
    const stageEntryDate = best.stageDates?.[best.stageKey]
      ? new Date(best.stageDates[best.stageKey] + 'T00:00:00').getTime() : null;

    // Override the room's column with the HubSpot lead status if it maps to
    // a different column — local room substage/badge is still preserved.
    const lsInfo     = _columnForLeadStatus(ls);
    const lsColumn   = lsInfo.column;
    const finalStage = lsColumn || best.stageKey;

    // When the room has no substage but the column is driven by lead status,
    // surface the lead status as the badge label.
    const lsOpt2    = (!statusId && lsColumn) ? LEAD_STATUS_OPTIONS.find(o => o.value === ls) : null;
    const roomBadge = lsOpt2 ? lsOpt2.label : '';

    const basePriority = priorityScore(finalStage, statusId);
    allEntries.push({
      contact,
      stageKey:   finalStage,
      substageId: statusId,
      badgeLabel: roomBadge,
      sourceId:   best.sourceId || '',
      createdate,
      stageTime:  substageDate || stageEntryDate || createdate,
      priority:   lsInfo.terminal ? 3 : basePriority,
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
  // finalStage on every entry resolves to 'sales' or 'designvisit' (see
  // STAGE_COLUMN_INFO and _columnForLeadStatus), so all entries land in a bucket.
  const byStage = Object.fromEntries(SALES_TAB_STAGES.map(k => [k, []]));
  for (const e of visibleEntries) {
    if (byStage[e.stageKey]) byStage[e.stageKey].push(e);
  }

  // ── Build columns (sales + designvisit) ──────────────────────────────────
  // 'survey' appears only in the stage trail on each card, not as a board column.
  const colsHtml = SALES_TAB_STAGES.map(sk => {
    const label    = escHtml(state.workflow?.stages?.[sk]?.label ||
      (sk === 'designvisit' ? 'Design Visit' : 'Sales'));
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
    <div class="sales-board">
      ${colsHtml}
    </div>
  `;
}

// ── Lead-status → column map ──────────────────────────────────────────────────
// Statuses not listed here (NOT_SUITABLE, UNQUALIFIED) are excluded upstream.
// Legacy hardcoded fallback used only when the admin-configured stage is missing.
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

// Map an admin-configured stage to a Sales-board column. Anything beyond
// Design Visit (Survey, Order, Workshop, …) is treated as terminal and parked
// in the Design Visit column so the customer is not silently dropped.
const STAGE_COLUMN_INFO = {
  SALES:            { column: 'sales',       terminal: false },
  DESIGN_VISIT:     { column: 'designvisit', terminal: false },
  SURVEY:           { column: 'designvisit', terminal: true  },
  ORDER:            { column: 'designvisit', terminal: true  },
  WORKSHOP:         { column: 'designvisit', terminal: true  },
  PACKING:          { column: 'designvisit', terminal: true  },
  DELIVERY:         { column: 'designvisit', terminal: true  },
  INSTALLATION:     { column: 'designvisit', terminal: true  },
  AFTERCARE:        { column: 'designvisit', terminal: true  },
  CUSTOMER_SERVICE: { column: 'designvisit', terminal: true  },
};

// Resolve a hs_lead_status value to its Sales-board column + terminal flag.
// Prefers the admin-configured stage on LEAD_STATUS_OPTIONS, falls back to
// the legacy hardcoded HS_STATUS_COLUMN map for backwards compat.
function _columnForLeadStatus(ls) {
  if (!ls) return { column: null, terminal: false };
  const opt = (typeof LEAD_STATUS_OPTIONS !== 'undefined')
    ? LEAD_STATUS_OPTIONS.find(o => o.value === ls) : null;
  const stage = opt?.stage;
  if (stage && STAGE_COLUMN_INFO[stage]) return STAGE_COLUMN_INFO[stage];
  return { column: HS_STATUS_COLUMN[ls] || null, terminal: false };
}

// ── Stage accent hex colours ──────────────────────────────────────────────────
const STAGE_ACCENT = {
  sales:       '#8B2BFF',
  designvisit: '#0d9488',
  survey:      '#d97706',
};
// Tint background and text colour for action strip (matches accent per stage)
const STAGE_TINT = {
  sales:       '#F3EAFF',
  designvisit: '#CCFBF1',
  survey:      '#FEF3C7',
};
const STAGE_ACTION_TEXT = {
  sales:       '#6A12D9',
  designvisit: '#0f766e',
  survey:      '#b45309',
};
const STAGE_LABEL_FALLBACK = {
  sales: 'Sales', designvisit: 'Design Visit', survey: 'Survey',
};
function _stageLabel(stageKey) {
  return state.workflow?.stages?.[stageKey]?.label ||
    STAGE_LABEL_FALLBACK[stageKey] || stageKey;
}
function _eqRgb(hex) {
  return `${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)}`;
}

// ── Next action label ─────────────────────────────────────────────────────────
// Fully admin-configurable via the admin Card actions tab.
//   1. If the contact has a HubSpot `hw_lead_substatus` set that matches a
//      sub-status configured under its current lead status → use that
//      sub-status's action label.
//   2. Otherwise fall back to the (stage, substage) default mapping.
//   3. Otherwise '' → no strip is rendered.
function nextActionLabel(stageKey, substageId, leadStatusKey, hwSubstatusValue) {
  if (typeof substatusActionLabelLookup === 'function') {
    const fromSub = substatusActionLabelLookup(leadStatusKey, hwSubstatusValue);
    if (fromSub) return fromSub;
  }
  // Prefer lead-status over local workflow substageId — the admin Card Actions
  // tab is keyed by lead status, so a card with LS "ATTEMPTED_TO_CONTACT" and
  // local room substageId "attempted_contact" must resolve via the LS key.
  if (typeof stageOrLeadStatusActionLabel === 'function') {
    return stageOrLeadStatusActionLabel(stageKey, leadStatusKey, substageId);
  }
  if (typeof stageActionLabelLookup === 'function') {
    return stageActionLabelLookup(stageKey, substageId) || '';
  }
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
  const postcode    = escHtml((contact.properties?.zip || '').trim().toUpperCase().split(/\s+/)[0]);
  const subLabel    = escHtml(badgeLabel || substageLabel(stageKey, substageId));
  const lmdRaw      = contact.properties?.lastmodifieddate;
  const lmdMs       = lmdRaw ? new Date(lmdRaw).getTime() : NaN;
  const displayTime = !isNaN(lmdMs) ? lmdMs : stageTime;
  const timeStr     = escHtml(relativeTime(displayTime));

  const numHtml = customerNum
    ? `<span class="eq-card-num">${escHtml(customerNum)}</span>` : '';

  const postcodeHtml = postcode
    ? `<span class="eq-card-postcode">${postcode}</span>` : '';

  const accent = isTerminal ? '#B8AE99' : (STAGE_ACCENT[stageKey] || 'var(--orchid)');

  // Filled stage-name pill (clickable for managers when the contact has a real
  // room — roomIdx is undefined for lead-status-only fallback entries).
  const _editable = canEditPipeline();
  const hasRoom   = Number.isInteger(entry.roomIdx);
  // Stage pill is non-interactive — stage is derived from lead status /
  // sub-status, never set manually.
  const stagePillHtml = isTerminal ? '' :
    `<span class="eq-card-stage-pill" style="background:${accent};color:#fff">${escHtml(_stageLabel(stageKey))}</span>`;

  // Substage pill
  let subPillHtml = '';
  if (substageId || badgeLabel) {
    if (isTerminal) {
      subPillHtml = `<span class="eq-card-substage eq-card-substage-terminal">${subLabel}</span>`;
    } else {
      const pc = substagePillColour(stageKey, substageId);
      const subEditAttrs = (_editable && hasRoom)
        ? `data-card-edit="substage" data-contact-id="${escHtml(contact.id)}" data-room-idx="${entry.roomIdx}" role="button" tabindex="-1" title="Change substage" style="background:${pc.bg};color:${pc.text};border:1px solid ${pc.bg};cursor:pointer"`
        : `style="background:${pc.bg};color:${pc.text};border:1px solid ${pc.bg}"`;
      subPillHtml = `<span class="eq-card-substage" ${subEditAttrs}>${subLabel}</span>`;
    }
  }

  // Source pill (outlined, no dot)
  const sourceHtml = sourceId && SOURCE_LABELS[sourceId]
    ? `<span class="eq-card-source-pill">${escHtml(SOURCE_LABELS[sourceId])}</span>` : '';

  const next = isTerminal ? '' : nextActionLabel(
    stageKey, substageId,
    contact.properties?.hs_lead_status,
    contact.properties?.hw_lead_substatus,
  );
  const actionTint = STAGE_TINT[stageKey] || '#f3f4f6';
  const actionText = STAGE_ACTION_TEXT[stageKey] || '#374151';
  const handlerAttrs = (typeof cardActionHandlerAttrs === 'function')
    ? cardActionHandlerAttrs(stageKey, contact.properties?.hs_lead_status, contact.properties?.hw_lead_substatus, {
        contactId:    contact.id,
        contactName:  contactName(contact),
        contactEmail: contact.properties?.email || '',
      })
    : '';
  const hasHandler = !!handlerAttrs;
  const _cahNameMatch = hasHandler && handlerAttrs.match(/data-card-action-name="([^"]*)"/);
  const _cahName = _cahNameMatch ? _cahNameMatch[1].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '';
  const actionEditAttrs = hasHandler
    ? `${handlerAttrs} role="button" tabindex="-1" title="Run action" style="background:${actionTint};cursor:pointer"`
    : (_editable
        ? `data-card-edit="leadstatus" data-contact-id="${escHtml(contact.id)}" role="button" tabindex="-1" title="Change lead status" style="background:${actionTint};cursor:pointer"`
        : `style="background:${actionTint}"`);
  const _stripLabel = _cahName || next;
  const actionHtml = _stripLabel ? `
    <div class="eq-card-action" ${actionEditAttrs}>
      <span class="eq-card-action-label" style="color:${actionText}">${escHtml(_stripLabel)}</span>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${actionText}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
    </div>` : '';

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
