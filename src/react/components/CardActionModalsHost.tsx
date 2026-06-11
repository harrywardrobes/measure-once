import React, { useCallback, useEffect, useState } from 'react';
import { DesignVisitWizard } from './DesignVisitWizard';
import { MessagePopupModal } from './modals/MessagePopupModal';
import { DesignVisitCalendarModal } from './modals/DesignVisitCalendarModal';
import { VisitCalendarModal } from './modals/VisitCalendarModal';
import { DeliveryWindowModal } from './modals/DeliveryWindowModal';
import { InstallationSlotModal } from './modals/InstallationSlotModal';
import { PhoneSummaryModal } from './modals/PhoneSummaryModal';
import { UploadPhotosModal } from './modals/UploadPhotosModal';
import { ArrangeVisitModal } from './modals/ArrangeVisitModal';
const ContactCustomerModal = React.lazy(() =>
  import('./modals/ContactCustomerModal').then(m => ({ default: m.ContactCustomerModal }))
);
const ReviewCustomerPhotosDrawer = React.lazy(() =>
  import('./modals/ReviewCustomerPhotosDrawer').then(m => ({ default: m.ReviewCustomerPhotosDrawer }))
);
import { broadcastDesignVisitDraftChanged } from '../utils/broadcastDesignVisitDraft';
import { broadcastContactAttemptLogged } from '../utils/broadcastContactAttempt';
import { registerCardActionModalOpener } from '../utils/cardActionModalRegistry';
import type { CardActionHandlerData } from '../hooks/useCardActionHandlers';
import type { CardActionContext } from '../utils/dispatchCardActionHandler';
import type { ExistingVisit } from './DesignVisitWizard';

type ModalState =
  | { type: 'none' }
  | { type: 'show_message';                  handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'add_design_visit_to_calendar';  handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'schedule_visit';                handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'schedule_delivery_window';      handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'schedule_installation_slot';    handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'summarise_phone_call';          handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'start_design_visit';            handler: CardActionHandlerData; ctx: CardActionContext; existingVisit?: ExistingVisit | null }
  | { type: 'upload_photos_and_info';        handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'review_customer_photos';        handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'arrange_visit';                 handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'contact_customer';              contactId: string; contactName: string; contactEmail: string };

export type HandlerType = Exclude<ModalState['type'], 'none'>;

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
        case 'schedule_delivery_window':
          setModal({ type: 'schedule_delivery_window', handler, ctx });
          break;
        case 'schedule_installation_slot':
          setModal({ type: 'schedule_installation_slot', handler, ctx });
          break;
        case 'summarise_phone_call':
          setModal({ type: 'summarise_phone_call', handler, ctx });
          break;
        case 'start_design_visit':
          setModal({ type: 'start_design_visit', handler, ctx, existingVisit });
          break;
        case 'upload_photos_and_info':
          setModal({ type: 'upload_photos_and_info', handler, ctx });
          break;
        case 'review_customer_photos':
          setModal({ type: 'review_customer_photos', handler, ctx });
          break;
        case 'arrange_visit':
          setModal({ type: 'arrange_visit', handler, ctx });
          break;
        case 'contact_customer':
          setModal({ type: 'contact_customer', contactId: ctx.contactId, contactName: ctx.contactName, contactEmail: ctx.contactEmail });
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
    if (closing.type === 'start_design_visit') {
      broadcastDesignVisitDraftChanged();
    }
    if (closing.type === 'contact_customer') {
      broadcastContactAttemptLogged(closing.contactId);
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
      {modal.type === 'schedule_delivery_window' && (
        <DeliveryWindowModal handler={modal.handler} ctx={modal.ctx} open onClose={close} />
      )}
      {modal.type === 'schedule_installation_slot' && (
        <InstallationSlotModal handler={modal.handler} ctx={modal.ctx} open onClose={close} />
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
      {modal.type === 'upload_photos_and_info' && (
        <UploadPhotosModal handler={modal.handler} ctx={modal.ctx} open onClose={close} />
      )}
      {modal.type === 'review_customer_photos' && (
        <React.Suspense fallback={null}>
          <ReviewCustomerPhotosDrawer handler={modal.handler} ctx={modal.ctx} open onClose={close} />
        </React.Suspense>
      )}
      {modal.type === 'arrange_visit' && (
        <ArrangeVisitModal handler={modal.handler} ctx={modal.ctx} open onClose={close} />
      )}
      {modal.type === 'contact_customer' && (
        <React.Suspense fallback={null}>
          <ContactCustomerModal
            contactId={modal.contactId}
            contactName={modal.contactName}
            contactEmail={modal.contactEmail}
            onClose={close}
          />
        </React.Suspense>
      )}
    </>
  );
}
