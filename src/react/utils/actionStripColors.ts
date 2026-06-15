import { ACTION_STRIP_DRAFT_COLORS, NEUTRAL_COLORS, STAGE_COLORS } from '../theme';

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
    actionTint: greenCondition ? ACTION_STRIP_DRAFT_COLORS.tint : (stageColors?.light || NEUTRAL_COLORS[100]),
    actionTextColor: greenCondition ? ACTION_STRIP_DRAFT_COLORS.text : (stageColors?.text || NEUTRAL_COLORS[700]),
  };
}
