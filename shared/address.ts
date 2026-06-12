/**
 * shared/address.ts — Structured address model (TypeScript / ESM).
 *
 * This is the single canonical source of truth for the structured-address
 * type, Zod schema, country list, and the format/HubSpot conversion helpers.
 * It is imported by the React layer (via Vite/TypeScript bundling) wherever
 * addresses are entered, rendered, or sent to HubSpot.
 *
 * The server-side CJS mirror lives in shared/address.cjs and MUST be kept in
 * sync with this file (same country list, same conversion rules). HubSpot
 * remains the source of truth for contact addresses; this module only shapes
 * the data on the way in and out.
 *
 * StructuredAddress field meanings:
 *   addressLines       — 1–5 street / building lines, largest-to-smallest.
 *   locality           — city / town / post town.
 *   administrativeArea — county / state / region.
 *   postalCode         — postcode / ZIP / postal code.
 *   countryCode        — ISO 3166-1 alpha-2 (e.g. "GB", "US"). Defaults "GB".
 */

export interface StructuredAddress {
  addressLines: string[];
  locality?: string;
  administrativeArea?: string;
  postalCode?: string;
  countryCode: string;
}

/** Maximum number of street/building lines an address may carry. */
export const MAX_ADDRESS_LINES = 5;

/** The default / home-market country. Country is omitted from formatted output for this code. */
export const HOME_COUNTRY_CODE = 'GB';

/**
 * Countries whose postal convention writes the address largest-unit-first
 * (country, postal code, administrative area, locality, then street lines).
 * Everything else uses Western order (street lines first, country last).
 */
const EASTERN_ORDER_CODES = new Set(['CN', 'JP', 'KR', 'TW', 'HK', 'MO']);

export interface Country {
  code: string;
  name: string;
}

/**
 * Supported country list (ISO 3166-1 alpha-2 → English name). Used by the
 * country <select> and for HubSpot name↔code conversion. HubSpot stores the
 * English country name; unknown names round-trip through unchanged.
 */
export const COUNTRIES: Country[] = [
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

/** ISO alpha-2 code → English country name. Returns undefined for unknown codes. */
export function countryCodeToName(code?: string | null): string | undefined {
  if (!code) return undefined;
  return CODE_TO_NAME.get(code.trim().toUpperCase());
}

/**
 * English country name → ISO alpha-2 code. Tolerates a value that is already a
 * 2-letter code. Returns undefined when it cannot be resolved.
 */
export function countryNameToCode(name?: string | null): string | undefined {
  if (!name) return undefined;
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const byName = NAME_TO_CODE.get(trimmed.toLowerCase());
  if (byName) return byName;
  // Already a known 2-letter code?
  if (trimmed.length === 2 && CODE_TO_NAME.has(trimmed.toUpperCase())) {
    return trimmed.toUpperCase();
  }
  return undefined;
}

/** Build a normalised, empty-safe StructuredAddress with sensible defaults. */
export function emptyAddress(countryCode: string = HOME_COUNTRY_CODE): StructuredAddress {
  return { addressLines: [''], countryCode };
}

/** True when the address has no meaningful content (used to skip rendering). */
export function isAddressEmpty(addr?: StructuredAddress | null): boolean {
  if (!addr) return true;
  const hasLine = (addr.addressLines || []).some((l) => l && l.trim());
  return !hasLine && !addr.locality?.trim() && !addr.administrativeArea?.trim() && !addr.postalCode?.trim();
}

export interface FormatAddressOptions {
  /** Country code treated as "home" (its name is omitted). Defaults "GB". */
  homeCountry?: string;
  /** Join separator for the single-line output. Defaults ", ". */
  separator?: string;
}

/**
 * Render a StructuredAddress as a single human-readable line.
 *
 * - Western countries: street lines → locality → administrative area →
 *   postal code → country.
 * - Eastern countries (CN/JP/KR/TW/HK/MO): country → postal code →
 *   administrative area → locality → street lines (largest unit first).
 * - The country name is omitted when it matches the home market (GB by
 *   default) so domestic addresses stay clean. Unknown country codes are
 *   omitted entirely rather than printing a raw code.
 * - Empty parts are dropped.
 */
export function formatAddress(addr?: StructuredAddress | null, opts: FormatAddressOptions = {}): string {
  if (!addr) return '';
  const home = (opts.homeCountry || HOME_COUNTRY_CODE).toUpperCase();
  const sep = opts.separator ?? ', ';
  const code = (addr.countryCode || home).toUpperCase();

  const lines = (addr.addressLines || []).map((l) => (l || '').trim()).filter(Boolean);
  const locality = addr.locality?.trim() || '';
  const area = addr.administrativeArea?.trim() || '';
  const postal = addr.postalCode?.trim() || '';
  const countryName = code === home ? '' : (countryCodeToName(code) || '');

  let parts: string[];
  if (EASTERN_ORDER_CODES.has(code)) {
    parts = [countryName, postal, area, locality, ...lines];
  } else {
    parts = [...lines, locality, area, postal, countryName];
  }
  return parts.filter(Boolean).join(sep);
}

/** Raw HubSpot contact address properties. */
export interface HubspotAddressProps {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
}

/**
 * Convert raw HubSpot contact properties into a StructuredAddress.
 * `address` may carry multiple newline-separated lines. The HubSpot `country`
 * is an English name; it is resolved to an ISO code (falling back to GB when
 * absent or unrecognised so the UI always has a country selected).
 */
export function hubspotToAddress(props?: HubspotAddressProps | null): StructuredAddress {
  const p = props || {};
  const addressLines = (p.address || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const countryCode = countryNameToCode(p.country) || HOME_COUNTRY_CODE;
  return {
    addressLines: addressLines.length ? addressLines : [],
    locality: p.city?.trim() || undefined,
    administrativeArea: p.state?.trim() || undefined,
    postalCode: p.zip?.trim() || undefined,
    countryCode,
  };
}

/**
 * Convert a StructuredAddress into raw HubSpot contact properties. Multiple
 * address lines are newline-joined into the single HubSpot `address` field;
 * the ISO country code is expanded to its English name (empty when unknown).
 */
export function addressToHubspot(addr?: StructuredAddress | null): Required<HubspotAddressProps> {
  const a = addr || ({ addressLines: [], countryCode: HOME_COUNTRY_CODE } as StructuredAddress);
  const lines = (a.addressLines || []).map((l) => (l || '').trim()).filter(Boolean);
  return {
    address: lines.join('\n'),
    city: a.locality?.trim() || '',
    state: a.administrativeArea?.trim() || '',
    zip: a.postalCode?.trim() || '',
    country: countryCodeToName(a.countryCode) || '',
  };
}
