import type { CardActionHandlerData } from '../hooks/useCardActionHandlers';
import type { CardActionContext } from './dispatchCardActionHandler';
import type { ExistingVisit } from '../components/DesignVisitWizard';

export type OpenCardActionModalFn = (
  handler: CardActionHandlerData,
  ctx: CardActionContext,
  existingVisit?: ExistingVisit | null,
) => void;

let _opener: OpenCardActionModalFn | null = null;

export function registerCardActionModalOpener(fn: OpenCardActionModalFn): void {
  _opener = fn;
}

export function openCardActionModal(
  handler: CardActionHandlerData,
  ctx: CardActionContext,
  existingVisit?: ExistingVisit | null,
): void {
  if (_opener) {
    _opener(handler, ctx, existingVisit);
  } else {
    console.warn('[cardActionModalRegistry] No modal host registered yet');
  }
}
