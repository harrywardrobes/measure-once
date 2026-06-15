import { STAGE_COLORS, StageColor } from '../theme';

/**
 * Look up the colour tokens for a pipeline stage key.
 * Falls back to the 'sales' stage colours when the key is not found.
 *
 * Single source of truth — import from here instead of duplicating the lookup
 * in individual components/pages.
 */
export function stageColour(stageKey: string): StageColor {
  return STAGE_COLORS[stageKey] ?? STAGE_COLORS.sales;
}
