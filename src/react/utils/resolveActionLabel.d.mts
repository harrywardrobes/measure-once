/**
 * Type declarations for resolveActionLabel.mjs.
 * The implementation is plain ESM so Node.js test scripts can import it
 * directly without a build step.
 */

export declare function resolveActionLabel(
  stageActionLabelMap: Record<string, string | null>,
  substatusActionLabelMap: Record<string, string>,
  stageKey: string,
  leadStatusKey: string | undefined,
  substageId: string | undefined,
  hwSubstatusValue: string | undefined,
): string;
