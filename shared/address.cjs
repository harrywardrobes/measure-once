'use strict';
/**
 * shared/address.cjs — Structured address model (server-side CJS mirror).
 *
 * Server-side CommonJS copy of shared/address.ts. Required by server.js,
 * customer-info.js, and design-visits.js for Zod validation and HubSpot
 * conversion. Keep this file in sync with shared/address.ts (same country
 * list, same conversion rules). HubSpot remains the source of truth for
 * contact addresses; this module only shapes data on the way in and out.
 */

const { z } = require('zod');

/** Maximum number of street/building lines an address may carry. */
const MAX_ADDRESS_LINES = 5;

/** The default / home-market country. Country is omitted from formatted output for this code. */
const HOME_COUNTRY_CODE = 'GB';

/**
 * Zod schema for a structured address. Accepts partial/empty input; only
 * `countryCode` is required and defaults to "GB". Empty address lines are
 * tolerated here and trimmed by the conversion helpers.
 */
const structuredAddressSchema = z.object({
  addressLines: z.array(z.string()).max(MAX_ADDRESS_LINES).optional().default([]),
  locality: z.string().optional(),
  administrativeArea: z.string().optional(),
  postalCode: z.string().optional(),
  countryCode: z.string().trim().length(2).toUpperCase().default('GB'),
});

/** Countries whose postal convention writes the address largest-unit-first. */
const EASTERN_ORDER_CODES = new Set(['CN', 'JP', 'KR', 'TW', 'HK', 'MO']);

/** Supported country list (ISO 3166-1 alpha-2 → English name). */
const COUNTRIES = [
  { code: 'GB', name: 'United Kingdom' },
  { code: 'IE', name: 'Ireland' },
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'FR', name: 'France' },
  { code: 'DE', name: 'Germany' },
  { code: 'ES', name: 'Spain' },
  { code: 'PT', name: 'Portugal' },
  { code: 'IT', name: 'Italy' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'BE', name: 'Belgium' },
  { code: 'LU', name: 'Luxembourg' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'AT', name: 'Austria' },
  { code: 'DK', name: 'Denmark' },
  { code: 'SE', name: 'Sweden' },
  { code: 'NO', name: 'Norway' },
  { code: 'FI', name: 'Finland' },
  { code: 'IS', name: 'Iceland' },
  { code: 'PL', name: 'Poland' },
  { code: 'CZ', name: 'Czechia' },
  { code: 'SK', name: 'Slovakia' },
  { code: 'HU', name: 'Hungary' },
  { code: 'RO', name: 'Romania' },
  { code: 'BG', name: 'Bulgaria' },
  { code: 'GR', name: 'Greece' },
  { code: 'HR', name: 'Croatia' },
  { code: 'SI', name: 'Slovenia' },
  { code: 'EE', name: 'Estonia' },
  { code: 'LV', name: 'Latvia' },
  { code: 'LT', name: 'Lithuania' },
  { code: 'MT', name: 'Malta' },
  { code: 'CY', name: 'Cyprus' },
  { code: 'UA', name: 'Ukraine' },
  { code: 'TR', name: 'Turkey' },
  { code: 'RU', name: 'Russia' },
  { code: 'MX', name: 'Mexico' },
  { code: 'BR', name: 'Brazil' },
  { code: 'AR', name: 'Argentina' },
  { code: 'CL', name: 'Chile' },
  { code: 'CO', name: 'Colombia' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'NG', name: 'Nigeria' },
  { code: 'KE', name: 'Kenya' },
  { code: 'EG', name: 'Egypt' },
  { code: 'MA', name: 'Morocco' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'SA', name: 'Saudi Arabia' },
  { code: 'QA', name: 'Qatar' },
  { code: 'IL', name: 'Israel' },
  { code: 'IN', name: 'India' },
  { code: 'PK', name: 'Pakistan' },
  { code: 'BD', name: 'Bangladesh' },
  { code: 'CN', name: 'China' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'MO', name: 'Macau' },
  { code: 'TW', name: 'Taiwan' },
  { code: 'JP', name: 'Japan' },
  { code: 'KR', name: 'South Korea' },
  { code: 'SG', name: 'Singapore' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'TH', name: 'Thailand' },
  { code: 'VN', name: 'Vietnam' },
  { code: 'PH', name: 'Philippines' },
  { code: 'ID', name: 'Indonesia' },
];

const CODE_TO_NAME = new Map(COUNTRIES.map((c) => [c.code, c.name]));
const NAME_TO_CODE = new Map(COUNTRIES.map((c) => [c.name.toLowerCase(), c.code]));

function countryCodeToName(code) {
  if (!code) return undefined;
  return CODE_TO_NAME.get(String(code).trim().toUpperCase());
}

function countryNameToCode(name) {
  if (!name) return undefined;
  const trimmed = String(name).trim();
  if (!trimmed) return undefined;
  const byName = NAME_TO_CODE.get(trimmed.toLowerCase());
  if (byName) return byName;
  if (trimmed.length === 2 && CODE_TO_NAME.has(trimmed.toUpperCase())) {
    return trimmed.toUpperCase();
  }
  return undefined;
}

function emptyAddress(countryCode = HOME_COUNTRY_CODE) {
  return { addressLines: ['', ''], countryCode };
}

function isAddressEmpty(addr) {
  if (!addr) return true;
  const hasLine = (addr.addressLines || []).some((l) => l && l.trim());
  return !hasLine
    && !(addr.locality && addr.locality.trim())
    && !(addr.administrativeArea && addr.administrativeArea.trim())
    && !(addr.postalCode && addr.postalCode.trim());
}

function formatAddress(addr, opts = {}) {
  if (!addr) return '';
  const home = (opts.homeCountry || HOME_COUNTRY_CODE).toUpperCase();
  const sep = opts.separator != null ? opts.separator : ', ';
  const code = (addr.countryCode || home).toUpperCase();

  const lines = (addr.addressLines || []).map((l) => (l || '').trim()).filter(Boolean);
  const locality = (addr.locality || '').trim();
  const area = (addr.administrativeArea || '').trim();
  const postal = (addr.postalCode || '').trim();
  const countryName = code === home ? '' : (countryCodeToName(code) || '');

  let parts;
  if (EASTERN_ORDER_CODES.has(code)) {
    parts = [countryName, postal, area, locality, ...lines];
  } else {
    parts = [...lines, locality, area, postal, countryName];
  }
  return parts.filter(Boolean).join(sep);
}

function hubspotToAddress(props) {
  const p = props || {};
  const addressLines = String(p.address || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const countryCode = countryNameToCode(p.country) || HOME_COUNTRY_CODE;
  return {
    addressLines,
    locality: (p.city && String(p.city).trim()) || undefined,
    administrativeArea: (p.state && String(p.state).trim()) || undefined,
    postalCode: (p.zip && String(p.zip).trim()) || undefined,
    countryCode,
  };
}

function addressToHubspot(addr) {
  const a = addr || { addressLines: [], countryCode: HOME_COUNTRY_CODE };
  const lines = (a.addressLines || []).map((l) => (l || '').trim()).filter(Boolean);
  return {
    address: lines.join('\n'),
    city: (a.locality || '').trim(),
    state: (a.administrativeArea || '').trim(),
    zip: (a.postalCode || '').trim(),
    country: countryCodeToName(a.countryCode) || '',
  };
}

/**
 * Convert `addressComponents` from the Places API (New) into the legacy
 * `GoogleAddressComponent[]` shape so `googleComponentsToAddress` can be
 * called unchanged. The new API uses `longText`/`shortText` instead of
 * `long_name`/`short_name`.
 */
function adaptNewPlaceComponents(components) {
  if (!components) return [];
  return components.map(function (c) {
    return {
      long_name: c.longText != null ? c.longText : '',
      short_name: c.shortText != null ? c.shortText : '',
      types: Array.isArray(c.types) ? c.types : [],
    };
  });
}

function googleComponentsToAddress(components) {
  const list = components || [];
  const get = (type) => list.find((c) => Array.isArray(c.types) && c.types.includes(type));

  const streetNumber = (get('street_number') || {}).long_name || '';
  const route = (get('route') || {}).long_name || '';
  const premise = (get('premise') || {}).long_name || '';
  const subpremise = (get('subpremise') || {}).long_name || '';
  const line1 = [streetNumber, route].filter(Boolean).join(' ').trim();

  const lines = [];
  if (subpremise) lines.push(subpremise);
  if (premise && premise !== line1) lines.push(premise);
  if (line1) lines.push(line1);

  const locality =
    (get('postal_town') || {}).long_name ||
    (get('locality') || {}).long_name ||
    (get('sublocality') || {}).long_name ||
    '';
  const postalCode = (get('postal_code') || {}).long_name || '';
  const countryCode = ((get('country') || {}).short_name || HOME_COUNTRY_CODE).toUpperCase();

  const adminLevel1 = (get('administrative_area_level_1') || {}).long_name || '';
  const adminLevel2 = (get('administrative_area_level_2') || {}).long_name || '';
  const administrativeArea =
    countryCode === 'GB' ? adminLevel2 || adminLevel1 : adminLevel1 || adminLevel2;

  return {
    addressLines: lines.length ? lines : [''],
    locality: locality || undefined,
    administrativeArea: administrativeArea || undefined,
    postalCode: postalCode || undefined,
    countryCode,
  };
}

module.exports = {
  MAX_ADDRESS_LINES,
  HOME_COUNTRY_CODE,
  structuredAddressSchema,
  COUNTRIES,
  countryCodeToName,
  countryNameToCode,
  emptyAddress,
  isAddressEmpty,
  formatAddress,
  hubspotToAddress,
  addressToHubspot,
  adaptNewPlaceComponents,
  googleComponentsToAddress,
};
