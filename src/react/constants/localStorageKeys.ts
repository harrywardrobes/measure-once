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
 *   Each has a corresponding `_LEGACY_KEY` for the one-off migration shim that
 *   clears the old unscoped entry on mount.
 */

// ── Admin UI state ─────────────────────────────────────────────────────────────

/** Prefix for the per-user active admin group: `${ADMIN_ACTIVE_GROUP_PREFIX}${userId}` */
export const ADMIN_ACTIVE_GROUP_PREFIX = 'mo:admin:active-group:';
/** @deprecated Unscoped key superseded by ADMIN_ACTIVE_GROUP_PREFIX; kept for migration shim only. */
export const ADMIN_ACTIVE_GROUP_LEGACY_KEY = 'adminActiveGroup'; // ls-key-ok: migration shim — clearing the old unscoped key

/** Prefix for the per-user active admin tab: `${ADMIN_ACTIVE_TAB_PREFIX}${userId}` */
export const ADMIN_ACTIVE_TAB_PREFIX = 'mo:admin:active-tab:';
/** @deprecated Unscoped key superseded by ADMIN_ACTIVE_TAB_PREFIX; kept for migration shim only. */
export const ADMIN_ACTIVE_TAB_LEGACY_KEY = 'adminActiveTab'; // ls-key-ok: migration shim — clearing the old unscoped key

/** Prefix for the per-user active admin Visits subtab: `${ADMIN_VISITS_SUBTAB_PREFIX}${userId}` */
export const ADMIN_VISITS_SUBTAB_PREFIX = 'mo:admin:visits-subtab:';
/** @deprecated Unscoped key superseded by ADMIN_VISITS_SUBTAB_PREFIX; kept for migration shim only. */
export const ADMIN_VISITS_SUBTAB_LEGACY_KEY = 'adminVisitsSubtab'; // ls-key-ok: migration shim — clearing the old unscoped key

// ── Recent customers cache ─────────────────────────────────────────────────────

/** Prefix for the per-user recent-customers list: `${CP_RECENT_CUSTOMERS_PREFIX}${userId}` */
export const CP_RECENT_CUSTOMERS_PREFIX = 'mo:cp:recent:';
/** @deprecated Unscoped key superseded by CP_RECENT_CUSTOMERS_PREFIX; kept for migration shim only. */
export const CP_RECENT_CUSTOMERS_LEGACY_KEY = 'cp_recent_customers'; // ls-key-ok: migration shim — clearing the old unscoped key

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
/** @deprecated Unscoped key superseded by PROJECTS_STALENESS_PREFIX; kept for migration shim only. */
export const PROJECTS_STALENESS_LEGACY_KEY = 'projectsStalenessActive'; // ls-key-ok: migration shim — clearing the old unscoped key

/** Prefix for the per-user hidden-substages map: `${PROJECTS_SUBSTAGE_PREFIX}${userId}` */
export const PROJECTS_SUBSTAGE_PREFIX = 'mo:projects:substage:';
/** @deprecated Unscoped key superseded by PROJECTS_SUBSTAGE_PREFIX; kept for migration shim only. */
export const PROJECTS_SUBSTAGE_LEGACY_KEY = 'projectsHiddenSubstages'; // ls-key-ok: migration shim — clearing the old unscoped key

// ── Invoices ──────────────────────────────────────────────────────────────────

/** Prefix for the per-user invoice list page number: `${INVOICE_PAGE_PREFIX}${userId}` */
export const INVOICE_PAGE_PREFIX  = 'mo:invoices:page:';
/** @deprecated Unscoped key superseded by INVOICE_PAGE_PREFIX; kept for migration shim only. */
export const INVOICE_PAGE_LEGACY_KEY = 'mo_invoice_page'; // ls-key-ok: migration shim — clearing the old unscoped key

/** Prefix for the per-user invoice draft map: `${INVOICE_DRAFT_PREFIX}${userId}` */
export const INVOICE_DRAFT_PREFIX = 'mo:invoices:draft:';
/** @deprecated Unscoped key superseded by INVOICE_DRAFT_PREFIX; kept for migration shim only. */
export const INVOICE_DRAFT_LEGACY_KEY = 'mo_invoice_draft'; // ls-key-ok: migration shim — clearing the old unscoped key

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
/** @deprecated Unscoped key superseded by TRADES_TYPE_FILTER_PREFIX; kept for migration shim only. */
export const TRADES_TYPE_FILTER_LEGACY_KEY = 'tradesTypeFilter'; // ls-key-ok: migration shim — clearing the old unscoped key

// ── Questionnaire builder ─────────────────────────────────────────────────────
/** Prefix for the per-user visit-type filter in the Questionnaire subtab: `${QUESTIONNAIRE_VISIT_TYPE_FILTER_PREFIX}${userId}` */
export const QUESTIONNAIRE_VISIT_TYPE_FILTER_PREFIX = 'mo:admin:questionnaire-visit-type:';
/** @deprecated Unscoped key superseded by QUESTIONNAIRE_VISIT_TYPE_FILTER_PREFIX; kept for migration shim only. */
export const QUESTIONNAIRE_VISIT_TYPE_FILTER_LEGACY_KEY = 'questionnaireVisitTypeFilter'; // ls-key-ok: migration shim — clearing the old unscoped key

// ── Action handlers page ──────────────────────────────────────────────────────

/** Prefix for the per-user orphaned-handlers dismissed count: `${CAH_ORPHANED_DISMISSED_PREFIX}${userId}` */
export const CAH_ORPHANED_DISMISSED_PREFIX = 'mo:cah:orphaned-dismissed:';
/** @deprecated Unscoped key superseded by CAH_ORPHANED_DISMISSED_PREFIX; kept for migration shim only. */
export const CAH_ORPHANED_DISMISSED_LEGACY_KEY = 'cah_orphaned_dismissed_count'; // ls-key-ok: migration shim — clearing the old unscoped key

/** Prefix for the per-user conflict-dismissed key: `${CAH_CONFLICT_DISMISSED_PREFIX}${userId}` */
export const CAH_CONFLICT_DISMISSED_PREFIX = 'mo:cah:conflict-dismissed:';
/** @deprecated Unscoped key superseded by CAH_CONFLICT_DISMISSED_PREFIX; kept for migration shim only. */
export const CAH_CONFLICT_DISMISSED_LEGACY_KEY = 'cah_conflict_dismissed_key'; // ls-key-ok: migration shim — clearing the old unscoped key

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

/** @deprecated Unscoped keys superseded by the per-user prefixes above; kept for the one-off migration shim only. */
export const HOME_TASK_ASSIGNEE_FILTER_LEGACY_KEY = 'mo:home:task-assignee-filter'; // ls-key-ok: migration shim — clearing the old unscoped key
/** @deprecated Unscoped keys superseded by the per-user prefixes above; kept for the one-off migration shim only. */
export const HOME_TASK_CONTACT_SEARCH_LEGACY_KEY  = 'mo:home:task-contact-search';  // ls-key-ok: migration shim — clearing the old unscoped key

// ── Connect-services modal ─────────────────────────────────────────────────────
/**
 * sessionStorage — set once per browser session when the "Connect your services"
 * modal auto-opens due to an error state.  Prevents the modal from re-opening
 * automatically on subsequent status updates within the same session.
 * The user can still open the modal manually via the navbar icons at any time.
 */
export const CONNECT_MODAL_SHOWN_KEY = 'mo:connectModalShownThisSession';
