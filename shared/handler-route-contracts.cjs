'use strict';
/**
 * shared/handler-route-contracts.cjs
 *
 * Explicit server route acceptance contracts — the exact sets of outcome keys
 * and status maps that each server route accepts at runtime.
 *
 * Imported by:
 *   - server.js (runtime)          — uses ARRANGE_VISIT_KEYS, DVF_STATUS_MAP, CONTACT_CUSTOMER_MAP
 *   - photo-reviews.js (runtime)   — uses REVIEW_OUTCOME_STATUS
 *   - drift-guard test             — asserts these equal the registry terminal keys
 *
 * INTENTIONAL EXCLUSION — send_upload_link:
 *   contact_customer.send_upload_link is a terminal registry outcome (Workflow page
 *   shows "Send upload link → AWAITING_PHOTOS"), but the AWAITING_PHOTOS status
 *   change is executed through the upload_photos_and_info route, not through the
 *   contact-customer advance-status endpoint.  Including it in CONTACT_CUSTOMER_MAP
 *   would let the endpoint set AWAITING_PHOTOS without generating or sending the link.
 *   It is therefore excluded here and the exclusion is asserted in the drift-guard.
 */

const {
  getTerminalStatusMap,
  getTerminalKeys,
  getArrangeVisitStatus,
} = require('./handler-outcomes.cjs');

// ── arrange_visit ─────────────────────────────────────────────────────────────
// POST /api/card-actions/arrange-visit/:contactId
// Full terminal set: booked, email_sent, not_proceeding
const ARRANGE_VISIT_KEYS = getTerminalKeys('arrange_visit');

// ── design_visit_followup ─────────────────────────────────────────────────────
// POST /api/card-actions/design-visit-followup/:contactId
// Full terminal set: confirmed, invite_resent, not_proceeding
const DVF_STATUS_MAP = getTerminalStatusMap('design_visit_followup');

// ── contact_customer (advance-status) ─────────────────────────────────────────
// POST /api/card-actions/contact-customer/:contactId/advance-status
// Excluded: send_upload_link (handled via upload_photos_and_info route instead)
const _ccAll = getTerminalStatusMap('contact_customer');
const { send_upload_link: _ccExcluded, ...CONTACT_CUSTOMER_MAP } = _ccAll;

// ── review_customer_photos ────────────────────────────────────────────────────
// POST /api/card-actions/review-customer-photos (via photo-reviews router)
// Full terminal set: not_suitable, rough_estimate_sent
const REVIEW_OUTCOME_STATUS = getTerminalStatusMap('review_customer_photos');

exports.ARRANGE_VISIT_KEYS    = ARRANGE_VISIT_KEYS;
exports.DVF_STATUS_MAP        = DVF_STATUS_MAP;
exports.CONTACT_CUSTOMER_MAP  = CONTACT_CUSTOMER_MAP;
exports.REVIEW_OUTCOME_STATUS = REVIEW_OUTCOME_STATUS;
exports.getArrangeVisitStatus = getArrangeVisitStatus;
