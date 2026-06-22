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

/**
 * Canonical human-readable labels for each stage key.
 * Import from here instead of declaring a local fallback map.
 */
export const STAGE_LABELS: Record<StageKey, string> = {
  sales:           'Sales',
  designvisit:     'Design Visit',
  survey:          'Survey',
  order:           'Order',
  workshop:        'Workshop',
  packing:         'Packing',
  delivery:        'Delivery',
  installation:    'Installation',
  aftercare:       'Aftercare',
  customerservice: 'Customer Service',
};
