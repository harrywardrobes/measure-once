/**
 * How long (ms) to suppress duplicate task-changed fetches for the same
 * contact after the first one fires.
 *
 * Tradeoff: lower = badges refresh sooner after rapid scroll events, but
 * redundant network requests may be made; higher = fewer requests but the
 * badge may lag slightly when the user scrolls back to the same contact
 * quickly. 500 ms is imperceptible to the user and eliminates most duplicates.
 */
export const TASK_CHANGED_COOLDOWN_MS = 500;
