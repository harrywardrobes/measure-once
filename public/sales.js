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

// ── localdata-updated listener ────────────────────────────────────────────────
// When local workflow data changes (room saves, substage edits, etc.) reload
// all contacts and workflow stages then notify the React board to re-render.
document.addEventListener('localdata-updated', async () => {
  await Promise.all([loadAllContacts(), loadWorkflowStages()]);
  state.filteredContacts = [...state.contacts];
  document.dispatchEvent(new CustomEvent('sales-board-data-ready'));
});
