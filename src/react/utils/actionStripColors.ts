import { STAGE_COLORS } from '../theme';

export interface ActionStripColors {
  actionTint: string;
  actionTextColor: string;
}

export function getActionStripColors(params: {
  hasDraft: boolean;
  hasNoLeadStatus: boolean;
  handler: unknown;
  actionStageKey: string;
  primaryStageKey: string;
}): ActionStripColors {
  const { hasDraft, hasNoLeadStatus, handler, actionStageKey, primaryStageKey } = params;
  const stageColors = STAGE_COLORS[actionStageKey] || STAGE_COLORS[primaryStageKey];
  const greenCondition = hasDraft || (hasNoLeadStatus && !!handler);
  return {
    actionTint: greenCondition ? '#F0FDF4' : (stageColors?.light || '#f3f4f6'),
    actionTextColor: greenCondition ? '#15803d' : (stageColors?.text || '#374151'),
  };
}
