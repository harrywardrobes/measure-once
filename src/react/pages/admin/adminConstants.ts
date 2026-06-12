/**
 * Sentinel values that identify the "No lead status" / global null slot.
 *
 * These constants must be used wherever stage_key='__global__' or the
 * combined slot key '__global__|' is referenced so that a silent mismatch
 * between producers and consumers is impossible.
 */

export const GLOBAL_NULL_STAGE_KEY  = '__global__';
export const GLOBAL_NULL_STATUS_KEY = '';
export const GLOBAL_NULL_SLOT_KEY   = `${GLOBAL_NULL_STAGE_KEY}|${GLOBAL_NULL_STATUS_KEY}` as const;
