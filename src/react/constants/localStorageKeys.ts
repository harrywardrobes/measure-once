/**
 * Central registry of every localStorage (and sessionStorage) key used by the
 * React application.  Import from here instead of hardcoding string literals so
 * that keys are discoverable, reusable, and rename-safe.
 *
 * Naming convention:
 *   - Static keys:  ALL_CAPS constant whose value is the literal key string.
 *   - Dynamic keys: ALL_CAPS _PREFIX constant; caller appends a dynamic segment
 *     (e.g. contact ID or user ID) to build the full key.
 *
 * Per-user scoping:
 *   Keys that represent per-user preferences (filters, UI state, drafts) use a
 *   `_PREFIX` constant and are scoped to the logged-in user ID so they do not
 *   bleed between accounts on shared devices.  Pattern:
 *     `${SOME_PREFIX}${userId}`
 */

// ── Admin UI state ─────────────────────────────────────────────────────────────

/** Prefix for the per-user active admin group: `${ADMIN_ACTIVE_GROUP_PREFIX}${userId}` */
export const ADMIN_ACTIVE_GROUP_PREFIX = 'mo:admin:active-group:';

/** Prefix for the per-user active admin tab: `${ADMIN_ACTIVE_TAB_PREFIX}${userId}` */
export const ADMIN_ACTIVE_TAB_PREFIX = 'mo:admin:active-tab:';

/** Prefix for the per-user active admin Visits subtab: `${ADMIN_VISITS_SUBTAB_PREFIX}${userId}` */
export const ADMIN_VISITS_SUBTAB_PREFIX = 'mo:admin:visits-subtab:';

// ── Recent customers cache ─────────────────────────────────────────────────────

/** Prefix for the per-user recent-customers list: `${CP_RECENT_CUSTOMERS_PREFIX}${userId}` */
export const CP_RECENT_CUSTOMERS_PREFIX = 'mo:cp:recent:';

// ── Customer detail ───────────────────────────────────────────────────────────
/** Prefix for per-contact room-tab index: `${CUSTOMER_ROOM_IDX_PREFIX}${contactId}` */
export const CUSTOMER_ROOM_IDX_PREFIX = 'customerRoomIdx_';

// ── Customers page ────────────────────────────────────────────────────────────
/** sessionStorage – scroll restoration for the customers list. */
export const CUSTOMERS_SCROLL_KEY = 'customers_scroll';

/** sessionStorage – search query draft for the customers list. */
export const CUSTOMERS_SEARCH_KEY = 'customers_search';

/** sessionStorage – active lead-status filter on the customers list. */
export const CUSTOMERS_LEAD_STATUS_KEY = 'customers_lead_status';

/** sessionStorage – active stage tab on the customers list. */
export const CUSTOMERS_STAGE_KEY = 'customers_stage';

/** sessionStorage – sort-by selection on the customers list (omitted when default 'priority'). */
export const CUSTOMERS_SORT_KEY = 'customers_sort';

/** sessionStorage – viewer-privilege banner dismissed for this session. */
export const VIEWER_BANNER_DISMISSED_KEY = 'viewerBannerDismissed';

// ── Projects page ─────────────────────────────────────────────────────────────

/** Prefix for the per-user staleness filter: `${PROJECTS_STALENESS_PREFIX}${userId}` */
export const PROJECTS_STALENESS_PREFIX = 'mo:projects:staleness:';

/** Prefix for the per-user hidden-substages map: `${PROJECTS_SUBSTAGE_PREFIX}${userId}` */
export const PROJECTS_SUBSTAGE_PREFIX = 'mo:projects:substage:';

// ── Invoices ──────────────────────────────────────────────────────────────────

/** Prefix for the per-user invoice draft map: `${INVOICE_DRAFT_PREFIX}${userId}` */
export const INVOICE_DRAFT_PREFIX = 'mo:invoices:draft:';

// ── Onboarding ────────────────────────────────────────────────────────────────
export const ONBOARDING_DRAFT_KEY = 'mo:onboarding:draft';

// ── Sync meta ─────────────────────────────────────────────────────────────────
export const LAST_SYNC_META_KEY          = 'lastSuccessfulSyncAt';
export const CONTACTS_LAST_SYNC_META_KEY = 'customersLastSyncAt';

/** IndexedDB meta — last-known admin-configured priority-active-window (days). */
export const PRIORITY_ACTIVE_DAYS_META_KEY = 'priorityActiveDays';

// ── Trades page ───────────────────────────────────────────────────────────────

/** Prefix for the per-user trades type filter: `${TRADES_TYPE_FILTER_PREFIX}${userId}` */
export const TRADES_TYPE_FILTER_PREFIX = 'mo:trades:type-filter:';

// ── Questionnaire builder ─────────────────────────────────────────────────────
/** Prefix for the per-user visit-type filter in the Questionnaire subtab: `${QUESTIONNAIRE_VISIT_TYPE_FILTER_PREFIX}${userId}` */
export const QUESTIONNAIRE_VISIT_TYPE_FILTER_PREFIX = 'mo:admin:questionnaire-visit-type:';

// ── Action handlers page ──────────────────────────────────────────────────────

/** Prefix for the per-user orphaned-handlers dismissed count: `${CAH_ORPHANED_DISMISSED_PREFIX}${userId}` */
export const CAH_ORPHANED_DISMISSED_PREFIX = 'mo:cah:orphaned-dismissed:';

/** Prefix for the per-user conflict-dismissed key: `${CAH_CONFLICT_DISMISSED_PREFIX}${userId}` */
export const CAH_CONFLICT_DISMISSED_PREFIX = 'mo:cah:conflict-dismissed:';

// ── Admin deep-link ────────────────────────────────────────────────────────────
/** Written by WorkflowPage before tab-switching; consumed + cleared by the target tab on mount. */
export const ADMIN_DEEP_LINK_KEY = 'adminDeepLink';

// ── Draft form prefixes (append a dynamic ID to get the full key) ─────────────

/** Email template drafts: `${EMAIL_TEMPLATE_DRAFT_PREFIX}${templateKey}` */
export const EMAIL_TEMPLATE_DRAFT_PREFIX = 'emailTemplateDraft:';

/** Customer-info form drafts: `${CUSTOMER_INFO_DRAFT_PREFIX}${token}` */
export const CUSTOMER_INFO_DRAFT_PREFIX = 'ci_draft_';

/** Generic (token-less) customer-info draft token: persisted on mount, cleared after submit */
export const GENERIC_CI_DRAFT_TOKEN_KEY = 'ci_generic_draft_token';

/** Contact edit modal drafts: `${CONTACT_EDIT_DRAFT_PREFIX}${contactId}` */
export const CONTACT_EDIT_DRAFT_PREFIX = 'mo-contact-edit-';

/** Arrange-visit modal drafts: `${ARRANGE_VISIT_DRAFT_PREFIX}${contactId}` */
export const ARRANGE_VISIT_DRAFT_PREFIX = 'mo-arrange-visit-draft-';

/** Design-visit wizard new-visit drafts: `${DV_WIZARD_DRAFT_PREFIX}${contactId}` */
export const DV_WIZARD_DRAFT_PREFIX = 'dv-wizard-draft-';

/** Design-visit wizard edit drafts: `${DV_WIZARD_DRAFT_EDIT_PREFIX}${visitId}` */
export const DV_WIZARD_DRAFT_EDIT_PREFIX = 'dv-wizard-draft-edit-';

/**
 * Standalone /design-visit page — the in-progress customer selection (existing
 * contact or brand-new customer + its clientSubmissionId). Persisted so a
 * refresh / app restart mid-visit re-opens the wizard against the same draft
 * key instead of stranding it; cleared when the wizard closes.
 */
export const DV_STANDALONE_SELECTION_KEY = 'dv-standalone-selection';

/** Survey-visit wizard new-visit drafts: `${SV_WIZARD_DRAFT_PREFIX}${contactId}` */
export const SV_WIZARD_DRAFT_PREFIX = 'sv-wizard-draft-';

/** Survey-visit wizard edit drafts: `${SV_WIZARD_DRAFT_EDIT_PREFIX}${visitId}` */
export const SV_WIZARD_DRAFT_EDIT_PREFIX = 'sv-wizard-draft-edit-';

/** Schedule visit modal drafts: `${SCHEDULE_VISIT_DRAFT_PREFIX}${contactId}` */
export const SCHEDULE_VISIT_DRAFT_PREFIX = 'mo-schedule-visit-draft-';

/** Design-visit follow-up modal drafts: `${DVF_DRAFT_PREFIX}${contactId}` */
export const DVF_DRAFT_PREFIX = 'dvf-draft-';

/** Open-deal action modal drafts: `${OPEN_DEAL_DRAFT_PREFIX}${contactId}` */
export const OPEN_DEAL_DRAFT_PREFIX = 'mo-open-deal-draft-';

/** Deposit-invoice followup modal drafts: `${DEPOSIT_INVOICE_DRAFT_PREFIX}${contactId}` */
export const DEPOSIT_INVOICE_DRAFT_PREFIX = 'mo-deposit-invoice-draft-';

/** Task modal drafts: `${TASK_MODAL_DRAFT_PREFIX}${contactId}` */
export const TASK_MODAL_DRAFT_PREFIX = 'mo-task-modal-draft-';

// ── Home page task filters ─────────────────────────────────────────────────────
/**
 * Prefix for the per-user assignee filter: `${HOME_TASK_ASSIGNEE_FILTER_PREFIX}${userId}`
 * "all" | "mine" — remembered across page visits, scoped to the logged-in user.
 */
export const HOME_TASK_ASSIGNEE_FILTER_PREFIX = 'mo:home:task-assignee-filter:';
/**
 * Prefix for the per-user contact search: `${HOME_TASK_CONTACT_SEARCH_PREFIX}${userId}`
 * Contact name search string — remembered across page visits, scoped to the logged-in user.
 */
export const HOME_TASK_CONTACT_SEARCH_PREFIX  = 'mo:home:task-contact-search:';


// ── Connect-services modal ─────────────────────────────────────────────────────
/**
 * sessionStorage — set once per browser session when the "Connect your services"
 * modal auto-opens due to an error state.  Prevents the modal from re-opening
 * automatically on subsequent status updates within the same session.
 * The user can still open the modal manually via the navbar icons at any time.
 */
export const CONNECT_MODAL_SHOWN_KEY = 'mo:connectModalShownThisSession';

// ── User profile ──────────────────────────────────────────────────────────────

/** Per-user phone number draft for the email signature card: `${USER_PHONE_DRAFT_PREFIX}${userId}` */
export const USER_PHONE_DRAFT_PREFIX = 'mo:profile:phone-draft:';

// ── Auth (offline cold-start) ───────────────────────────────────────────────────
/**
 * Last successfully-fetched `/api/auth/user` payload, cached so an installed PWA
 * that cold-launches with no connection stays signed in instead of bouncing to
 * `/login`. Written by AuthContext on every successful fetch, read as the offline
 * fallback, and cleared on a genuine 401 and on logout (`clearOfflineData`).
 */
export const LAST_KNOWN_USER_KEY = 'mo:auth:last-known-user';

// ── Legacy-key global sweep ────────────────────────────────────────────────────
/**
 * Written to localStorage once the one-time global sweep that removes all
 * old unscoped (pre-user-scoping) keys has run.  Plain unversioned key — the
 * flag carries no sensitive data so it does not need per-user scoping.
 */
export const LEGACY_SWEEP_DONE_KEY = 'mo:legacy-sweep-v1'; // ls-key-ok: one-time boot flag, no sensitive data
