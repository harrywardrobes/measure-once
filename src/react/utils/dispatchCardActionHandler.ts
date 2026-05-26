import type { CardActionHandlerData } from '../hooks/useCardActionHandlers';

export interface CardActionContext {
  contactId: string;
  contactName: string;
  contactEmail: string;
}

type ModalOpener = (handler: CardActionHandlerData, ctx: CardActionContext) => void;

function _getWindowFn(name: string): ModalOpener | undefined {
  return (window as unknown as Record<string, unknown>)[name] as ModalOpener | undefined;
}

/**
 * Dispatch a card action handler — look up the appropriate modal opener from
 * the vanilla-JS layer (card-action-modals.js) and invoke it.
 *
 * The modal implementations remain as vanilla JS for now; this function is the
 * typed TypeScript entry-point so React components never call through
 * `window.dispatchCardActionHandler` directly.
 */
export function dispatchCardActionHandler(
  handler: CardActionHandlerData,
  ctx: CardActionContext,
): void {
  switch (handler.type) {
    case 'add_design_visit_to_calendar':
      _getWindowFn('openDesignVisitModal')?.(handler, ctx);
      break;
    case 'summarise_phone_call':
      _getWindowFn('openPhoneSummaryModal')?.(handler, ctx);
      break;
    case 'show_message':
      _getWindowFn('openMessagePopup')?.(handler, ctx);
      break;
    case 'start_design_visit':
      _getWindowFn('openDesignVisitWizard')?.(handler, ctx);
      break;
    default:
      console.warn('[dispatchCardActionHandler] Unknown handler type:', handler.type);
  }
}
