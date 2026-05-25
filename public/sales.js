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
// Board rendering is handled by the React SalesBoardPage component.
// These callbacks notify the React island that fresh data is available.
registerCustomerListRenderer(function salesBoardNotifyReact() {
  document.dispatchEvent(new CustomEvent('sales-board-data-ready'));
});
registerProjectsViewRenderer(function salesProjectsViewNotifyReact() {
  document.dispatchEvent(new CustomEvent('sales-board-data-ready'));
});

// ── Stage accent hex colours (kept for any consumers that reference them) ─────
const STAGE_ACCENT = {
  sales:       '#8B2BFF',
  designvisit: '#0d9488',
  survey:      '#d97706',
};

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
  const fromSub = substatusActionLabelLookup(leadStatusKey, hwSubstatusValue);
  if (fromSub) return fromSub;
  // Prefer lead-status over local workflow substageId — the admin Card Actions
  // tab is keyed by lead status, so a card with LS "ATTEMPTED_TO_CONTACT" and
  // local room substageId "attempted_contact" must resolve via the LS key.
  return stageOrLeadStatusActionLabel(stageKey, leadStatusKey, substageId);
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
  const _editable = canEditPrivilege();
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
  const handlerAttrs = cardActionHandlerAttrs(stageKey, contact.properties?.hs_lead_status, contact.properties?.hw_lead_substatus, {
    contactId:    contact.id,
    contactName:  contactName(contact),
    contactEmail: contact.properties?.email || '',
  });
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

// ── localdata-updated listener ────────────────────────────────────────────────
// When local workflow data changes (room saves, substage edits, etc.) reload
// all contacts and workflow stages then notify the React board to re-render.
document.addEventListener('localdata-updated', async () => {
  await Promise.all([loadAllContacts(), loadWorkflowStages()]);
  state.filteredContacts = [...state.contacts];
  document.dispatchEvent(new CustomEvent('sales-board-data-ready'));
});
