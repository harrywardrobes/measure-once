/**
 * How long (ms) the "Copied!" / copy-done indicator stays visible before
 * resetting to the default state.
 *
 * Tradeoff: too short and users may not notice the confirmation; too long
 * and a second copy attempt looks broken. 1500 ms is long enough to read
 * "Copied!" comfortably without feeling sluggish.
 */
export const COPY_DONE_RESET_MS = 1500;

/**
 * How long (ms) a transient success banner / checkmark stays visible before
 * auto-hiding. Used for profile-photo approval, photo-upload submission
 * success, and settings-saved confirmations.
 *
 * Tradeoff: 2500 ms is enough to read a one-line message without the UI
 * feeling frozen; shorter can cause users to miss the confirmation.
 */
export const SUCCESS_BANNER_HIDE_MS = 2500;

/**
 * How long (ms) the photo-rejection feedback message stays visible before
 * auto-hiding. Slightly longer than SUCCESS_BANNER_HIDE_MS so the user has
 * time to read any guidance text.
 */
export const REJECTION_BANNER_HIDE_MS = 3500;

/**
 * Debounce delay (ms) for inline phone / e-mail conflict checks in the
 * trade-contact form. Prevents a conflict-check network call on every
 * keystroke.
 *
 * Tradeoff: 300 ms feels immediate for a human typist while avoiding
 * redundant requests mid-word.
 */
export const CONFLICT_CHECK_DEBOUNCE_MS = 300;

/**
 * Debounce delay (ms) applied when a task-changed broadcast arrives on the
 * customer-detail page. Collapses bursts of rapid task mutations into one
 * task-list refresh.
 *
 * Tradeoff: 300 ms keeps the task list nearly real-time while absorbing
 * multi-step task operations that fire several change events in quick
 * succession.
 */
export const TASK_REFRESH_DEBOUNCE_MS = 300;

/**
 * Debounce delay (ms) for the customer-list search input. The search query
 * is committed only after the user stops typing for this long.
 *
 * Tradeoff: 250 ms is fast enough to feel responsive but avoids re-filtering
 * on every character for fast typists.
 */
export const SEARCH_INPUT_DEBOUNCE_MS = 250;

/**
 * Debounce delay (ms) for the contact-search autocomplete (command palette,
 * useContactSearch hook). Avoids a network call on every keystroke.
 *
 * Tradeoff: 200 ms feels instant for a type-ahead while still consolidating
 * rapid keystrokes into a single request.
 */
export const CONTACT_SEARCH_DEBOUNCE_MS = 200;

/**
 * Debounce delay (ms) before checking whether a new-contact e-mail address
 * already exists in the system. Slightly longer than CONTACT_SEARCH_DEBOUNCE_MS
 * because a full-address duplicate check is only useful once the user has
 * finished typing.
 *
 * Tradeoff: 400 ms avoids premature "duplicate detected" flashes while still
 * running the check before the user moves to the next field.
 */
export const EMAIL_DUPE_CHECK_DEBOUNCE_MS = 400;
