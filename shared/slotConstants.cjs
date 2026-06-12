'use strict';
/**
 * shared/slotConstants.cjs — Sentinel values for the "No lead status" global slot.
 *
 * The canonical TypeScript/ESM source is src/react/pages/admin/adminConstants.ts.
 * This CJS file exposes the same constants for server-side modules (server.js,
 * photo-reviews.js, etc.) so that a silent string mismatch between the React
 * layer and the API is impossible.
 *
 * Keep in sync with src/react/pages/admin/adminConstants.ts.
 */

/** stage_key sentinel that represents the "No lead status" global null slot. */
const GLOBAL_NULL_STAGE_KEY = '__global__';

/** status_key for the global null slot (always an empty string). */
const GLOBAL_NULL_STATUS_KEY = '';

/** Combined slot key used as a Map/object key: '<stage>|<status>'. */
const GLOBAL_NULL_SLOT_KEY = `${GLOBAL_NULL_STAGE_KEY}|${GLOBAL_NULL_STATUS_KEY}`;

module.exports = { GLOBAL_NULL_STAGE_KEY, GLOBAL_NULL_STATUS_KEY, GLOBAL_NULL_SLOT_KEY };
