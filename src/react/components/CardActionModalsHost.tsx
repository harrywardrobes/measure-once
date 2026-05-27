import React, { useCallback, useEffect, useState } from 'react';
import { DesignVisitWizard } from './DesignVisitWizard';
import { MessagePopupModal } from './modals/MessagePopupModal';
import { DesignVisitCalendarModal } from './modals/DesignVisitCalendarModal';
import { VisitCalendarModal } from './modals/VisitCalendarModal';
import { PhoneSummaryModal } from './modals/PhoneSummaryModal';
import { registerCardActionModalOpener } from '../utils/cardActionModalRegistry';
import type { CardActionHandlerData } from '../hooks/useCardActionHandlers';
import type { CardActionContext } from '../utils/dispatchCardActionHandler';
import type { ExistingVisit } from './DesignVisitWizard';

type ModalState =
  | { type: 'none' }
  | { type: 'show_message';                handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'add_design_visit_to_calendar'; handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'schedule_visit';              handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'summarise_phone_call';         handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'start_design_visit';           handler: CardActionHandlerData; ctx: CardActionContext; existingVisit?: ExistingVisit | null };

export function CardActionModalsHost() {
  const [modal, setModal] = useState<ModalState>({ type: 'none' });

  const openModal = useCallback(
    (
      handler: CardActionHandlerData,
      ctx: CardActionContext,
      existingVisit?: ExistingVisit | null,
    ) => {
      switch (handler.type) {
        case 'show_message':
          setModal({ type: 'show_message', handler, ctx });
          break;
        case 'add_design_visit_to_calendar':
          setModal({ type: 'add_design_visit_to_calendar', handler, ctx });
          break;
        case 'schedule_visit':
          setModal({ type: 'schedule_visit', handler, ctx });
          break;
        case 'summarise_phone_call':
          setModal({ type: 'summarise_phone_call', handler, ctx });
          break;
        case 'start_design_visit':
          setModal({ type: 'start_design_visit', handler, ctx, existingVisit });
          break;
        default:
          console.warn('[CardActionModalsHost] Unknown handler type:', handler.type);
      }
    },
    [],
  );

  useEffect(() => {
    registerCardActionModalOpener(openModal);
  }, [openModal]);

  function close() {
    const closing = modal;
    setModal({ type: 'none' });
    if (closing.type === 'start_design_visit' && typeof BroadcastChannel !== 'undefined') {
      const bc = new BroadcastChannel('design_visit_draft_changed');
      bc.postMessage({ ts: Date.now() });
      bc.close();
    }
  }

  return (
    <>
      {modal.type === 'show_message' && (
        <MessagePopupModal handler={modal.handler} open onClose={close} />
      )}
      {modal.type === 'add_design_visit_to_calendar' && (
        <DesignVisitCalendarModal handler={modal.handler} ctx={modal.ctx} open onClose={close} />
      )}
      {modal.type === 'schedule_visit' && (
        <VisitCalendarModal handler={modal.handler} ctx={modal.ctx} open onClose={close} />
      )}
      {modal.type === 'summarise_phone_call' && (
        <PhoneSummaryModal handler={modal.handler} ctx={modal.ctx} open onClose={close} />
      )}
      {modal.type === 'start_design_visit' && (
        <DesignVisitWizard
          handler={modal.handler}
          ctx={modal.ctx}
          existingVisit={modal.existingVisit}
          onClose={close}
        />
      )}
    </>
  );
}
