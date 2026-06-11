import type { CardActionHandlerData } from '../hooks/useCardActionHandlers';
import { openCardActionModal } from './cardActionModalRegistry';
import { isHandlerType } from './handlerMeta';

export interface CardActionContext {
  contactId: string;
  contactName: string;
  contactEmail: string;
}

/**
 * Dispatch a card action handler by routing to the React CardActionModalsHost.
 *
 * The host registers itself via cardActionModalRegistry on mount. This function
 * is the typed TypeScript entry-point so React components and the click
 * delegation handler never bypass the registry.
 */
export function dispatchCardActionHandler(
  handler: CardActionHandlerData,
  ctx: CardActionContext,
): void {
  if (!isHandlerType(handler.type)) {
    const msg = `[dispatchCardActionHandler] Unknown handler type: "${handler.type}". Ignoring action.`;
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(msg);
    }
    console.warn(msg);
    return;
  }
  openCardActionModal(handler, ctx);
}
