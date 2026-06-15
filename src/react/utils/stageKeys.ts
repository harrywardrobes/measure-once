/**
 * Canonical ordered list of pipeline stage keys.
 * This is the single authoritative source — import from here, never re-declare.
 */
export const STAGE_KEYS = [
  'sales',
  'designvisit',
  'survey',
  'order',
  'workshop',
  'packing',
  'delivery',
  'installation',
  'aftercare',
  'customerservice',
] as const;

export type StageKey = (typeof STAGE_KEYS)[number];
