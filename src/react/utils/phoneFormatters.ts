/**
 * src/react/utils/phoneFormatters.ts — Phone number normalisation and formatting (ESM/React).
 *
 * Thin ESM wrapper around libphonenumber-js/min for use in React components.
 * Mirrors the API of shared/phone.cjs so client and server behave identically.
 */

import { parsePhoneNumber, isValidPhoneNumber } from 'libphonenumber-js/min';

/**
 * Normalise a user-supplied phone number to E.164.
 *
 * @param input          Raw input (e.g. "07902 819990", "+447902819990").
 * @param defaultCountry ISO-3166-1 alpha-2 default country (default: 'GB').
 * @returns E.164 string on success (e.g. "+447902819990"), or null when the
 *          number is empty or cannot be parsed as a valid phone number.
 */
export function normalizePhone(input: string | null | undefined, defaultCountry: string = 'GB'): string | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    if (!isValidPhoneNumber(trimmed, defaultCountry as Parameters<typeof isValidPhoneNumber>[1])) return null;
    const parsed = parsePhoneNumber(trimmed, defaultCountry as Parameters<typeof parsePhoneNumber>[1]);
    if (!parsed || !parsed.number) return null;
    return parsed.number;
  } catch {
    return null;
  }
}

/**
 * Format an E.164 (or any parseable) phone number for display.
 *
 * @param e164  E.164 string (e.g. "+447902819990") or raw number string.
 * @returns International display form (e.g. "+44 7902 819990"),
 *          or the input string unchanged when it cannot be parsed.
 */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164 || typeof e164 !== 'string') return e164 ?? '';
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
