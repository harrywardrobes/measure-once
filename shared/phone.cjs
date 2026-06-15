'use strict';
/**
 * shared/phone.cjs — Phone number normalisation and formatting (server-side CJS).
 *
 * Wraps libphonenumber-js/min so that:
 *  - normalizePhone(input, defaultCountry) → E.164 string (e.g. "+447902819990") or null
 *  - formatPhone(e164)                     → International display form (e.g. "+44 7902 819990"),
 *                                            or the input unchanged on parse failure.
 *
 * The `min` bundle is used to keep the footprint small; it covers all countries
 * in libphonenumber-js's minimal metadata set (all standard mobile and landline
 * formats, including UK mobiles and landlines).
 *
 * Follow the same `.cjs` pattern as shared/address.cjs.
 */

const { parsePhoneNumber, isValidPhoneNumber } = require('libphonenumber-js/min');

/**
 * Normalise a user-supplied phone number to E.164.
 *
 * @param {string|null|undefined} input          Raw input (e.g. "07902 819990", "+447902819990").
 * @param {string} [defaultCountry='GB']         ISO-3166-1 alpha-2 default country code.
 * @returns {string|null}  E.164 string on success (e.g. "+447902819990"), or null when:
 *   - input is empty / not a string
 *   - the number cannot be parsed as a valid phone number
 */
function normalizePhone(input, defaultCountry = 'GB') {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    if (!isValidPhoneNumber(trimmed, defaultCountry)) return null;
    const parsed = parsePhoneNumber(trimmed, defaultCountry);
    if (!parsed || !parsed.number) return null;
    return parsed.number;
  } catch {
    return null;
  }
}

/**
 * Format an E.164 phone number for display (international format with spaces).
 *
 * @param {string|null|undefined} e164  E.164 string (e.g. "+447902819990").
 * @returns {string}  International display form (e.g. "+44 7902 819990"),
 *                    or the input string unchanged when it cannot be parsed.
 */
function formatPhone(e164) {
  if (!e164 || typeof e164 !== 'string') return e164 || '';
  const trimmed = e164.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = parsePhoneNumber(trimmed);
    if (!parsed) return trimmed;
    return parsed.formatInternational();
  } catch {
    return trimmed;
  }
}

module.exports = { normalizePhone, formatPhone };
