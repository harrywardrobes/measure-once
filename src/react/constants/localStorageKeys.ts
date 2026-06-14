/**
 * Central registry of every localStorage (and sessionStorage) key used by the
 * React application.  Import from here instead of hardcoding string literals so
 * that keys are discoverable, reusable, and rename-safe.
 *
 * Naming convention:
 *   - Static keys:  ALL_CAPS constant whose value is the literal key string.
 *   - Dynamic keys: ALL_CAPS _PREFIX constant; caller appends a dynamic segment
 *     (e.g. contact ID) to build the full key.
 */

// ── Admin UI state ─────────────────────────────────────────────────────────────
export const ADMIN_ACTIVE_GROUP_KEY = 'adminActiveGroup';
export const ADMIN_ACTIVE_TAB_KEY   = 'adminActiveTab';

/** Active sub-tab within the admin Visits tab (Catalogues/Questionnaire/etc.). */
export const ADMIN_VISITS_SUBTAB_KEY = 'adminVisitsSubtab';

// ── Recent customers cache ─────────────────────────────────────────────────────
export const CP_RECENT_CUSTOMERS_KEY = 'cp_recent_customers';

// ── Customer detail ───────────────────────────────────────────────────────────
/** Prefix for per-contact room-tab index: `${CUSTOMER_ROOM_IDX_PREFIX}${contactId}` */
export const CUSTOMER_ROOM_IDX_PREFIX = 'customerRoomIdx_';

// ── Customers page ────────────────────────────────────────────────────────────
/** sessionStorage – scroll restoration for the customers list. */
export const CUSTOMERS_SCROLL_KEY = 'customers_scroll';

/** sessionStorage – viewer-privilege banner dismissed for this session. */
export const VIEWER_BANNER_DISMISSED_KEY = 'viewerBannerDismissed';

/** localStorage – whether "Priority first" (pin no-status contacts to top) is active. */
export const CUSTOMERS_PRIORITY_FIRST = 'customers_priorityFirst';

// ── Projects page ─────────────────────────────────────────────────────────────
export const PROJECTS_STALENESS_KEY = 'projectsStalenessActive';
export const PROJECTS_SUBSTAGE_KEY  = 'projectsHiddenSubstages';

// ── Invoices ──────────────────────────────────────────────────────────────────
export const INVOICE_PAGE_KEY  = 'mo_invoice_page';
export const INVOICE_DRAFT_KEY = 'mo_invoice_draft';

// ── Onboarding ────────────────────────────────────────────────────────────────
export const ONBOARDING_DRAFT_KEY = 'mo:onboarding:draft';

// ── Sync meta ─────────────────────────────────────────────────────────────────
export const LAST_SYNC_META_KEY          = 'lastSuccessfulSyncAt';
export const CONTACTS_LAST_SYNC_META_KEY = 'customersLastSyncAt';

// ── Trades page ───────────────────────────────────────────────────────────────
export const TRADES_TYPE_FILTER_KEY = 'tradesTypeFilter';

// ── Action handlers page ──────────────────────────────────────────────────────
export const CAH_ORPHANED_DISMISSED_KEY = 'cah_orphaned_dismissed_count';
export const CAH_CONFLICT_DISMISSED_KEY = 'cah_conflict_dismissed_key';

// ── Admin deep-link ────────────────────────────────────────────────────────────
/** Written by WorkflowPage before tab-switching; consumed + cleared by the target tab on mount. */
export const ADMIN_DEEP_LINK_KEY = 'adminDeepLink';

// ── Draft form prefixes (append a dynamic ID to get the full key) ─────────────

/** Email template drafts: `${EMAIL_TEMPLATE_DRAFT_PREFIX}${templateKey}` */
export const EMAIL_TEMPLATE_DRAFT_PREFIX = 'emailTemplateDraft:';

/** Customer-info form drafts: `${CUSTOMER_INFO_DRAFT_PREFIX}${token}` */
export const CUSTOMER_INFO_DRAFT_PREFIX = 'ci_draft_';

/** Contact edit modal drafts: `${CONTACT_EDIT_DRAFT_PREFIX}${contactId}` */
export const CONTACT_EDIT_DRAFT_PREFIX = 'mo-contact-edit-';

/** Arrange-visit modal drafts: `${ARRANGE_VISIT_DRAFT_PREFIX}${contactId}` */
export const ARRANGE_VISIT_DRAFT_PREFIX = 'mo-arrange-visit-draft-';

/** Design-visit wizard new-visit drafts: `${DV_WIZARD_DRAFT_PREFIX}${contactId}` */
export const DV_WIZARD_DRAFT_PREFIX = 'dv-wizard-draft-';

/** Design-visit wizard edit drafts: `${DV_WIZARD_DRAFT_EDIT_PREFIX}${visitId}` */
export const DV_WIZARD_DRAFT_EDIT_PREFIX = 'dv-wizard-draft-edit-';

/** Schedule visit modal drafts: `${SCHEDULE_VISIT_DRAFT_PREFIX}${contactId}` */
export const SCHEDULE_VISIT_DRAFT_PREFIX = 'mo-schedule-visit-draft-';

/** Design-visit follow-up modal drafts: `${DVF_DRAFT_PREFIX}${contactId}` */
export const DVF_DRAFT_PREFIX = 'dvf-draft-';

/** Open-deal action modal drafts: `${OPEN_DEAL_DRAFT_PREFIX}${contactId}` */
export const OPEN_DEAL_DRAFT_PREFIX = 'mo-open-deal-draft-';

/** Deposit-invoice followup modal drafts: `${DEPOSIT_INVOICE_DRAFT_PREFIX}${contactId}` */
export const DEPOSIT_INVOICE_DRAFT_PREFIX = 'mo-deposit-invoice-draft-';
