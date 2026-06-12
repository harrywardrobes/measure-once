/**
 * shared/addressSchema.ts — Zod schema for StructuredAddress (server-side).
 *
 * Kept separate from shared/address.ts so the client bundle, which only needs
 * the lightweight format/conversion helpers, never pulls in zod. The runtime
 * validation schema is only used by the server (which actually runs against
 * shared/address.cjs); this TypeScript mirror exists for any future TS
 * consumer that needs the canonical schema. Keep it in sync with the schema
 * in shared/address.cjs.
 */

import { z } from 'zod';
import { MAX_ADDRESS_LINES } from './address';

/**
 * Zod schema for a structured address. Accepts partial/empty input (a
 * half-filled form draft is still a valid object); only `countryCode` is
 * required and defaults to "GB". Empty address lines are tolerated here and
 * trimmed by the conversion helpers.
 */
export const structuredAddressSchema = z.object({
  addressLines: z.array(z.string()).max(MAX_ADDRESS_LINES).optional().default([]),
  locality: z.string().optional(),
  administrativeArea: z.string().optional(),
  postalCode: z.string().optional(),
  countryCode: z.string().trim().length(2).toUpperCase().default('GB'),
});
