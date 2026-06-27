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

export interface DirectContactModalParams {
  contactId: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string;
  contactMobile?: string;
  openEmail?: boolean;
}

type OpenDirectContactModalFn = (params: DirectContactModalParams) => void;
let _directOpener: OpenDirectContactModalFn | null = null;

export function registerDirectContactModalOpener(fn: OpenDirectContactModalFn): void {
  _directOpener = fn;
}

export function openDirectContactModal(params: DirectContactModalParams): void {
  if (_directOpener) {
    _directOpener(params);
  } else {
    console.warn('[cardActionModalRegistry] No direct contact modal opener registered yet');
  }
}
