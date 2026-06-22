import React, { useCallback, useEffect, useState } from 'react';
import { MessagePopupModal } from './modals/MessagePopupModal';
import { PhoneSummaryModal } from './modals/PhoneSummaryModal';
// ScheduleVisitModal uses @mui/x-date-pickers; lazy-import keeps the date-picker
// chunk out of the always-loaded bundle (it's only downloaded when the modal opens).
const ScheduleVisitModal = React.lazy(() =>
  import('./modals/ScheduleVisitModal').then(m => ({ default: m.ScheduleVisitModal }))
);
import { UploadPhotosModal } from './modals/UploadPhotosModal';
const DesignVisitWizard = React.lazy(() =>
  import('./DesignVisitWizard').then(m => ({ default: m.DesignVisitWizard }))
);
const SurveyVisitWizard = React.lazy(() =>
  import('./SurveyVisitWizard').then(m => ({ default: m.SurveyVisitWizard }))
);
const ArrangeVisitModal = React.lazy(() =>
  import('./modals/ArrangeVisitModal').then(m => ({ default: m.ArrangeVisitModal }))
);
const ContactCustomerModal = React.lazy(() =>
  import('./modals/ContactCustomerModal').then(m => ({ default: m.ContactCustomerModal }))
);
const ReviewCustomerPhotosDrawer = React.lazy(() =>
  import('./modals/ReviewCustomerPhotosDrawer').then(m => ({ default: m.ReviewCustomerPhotosDrawer }))
);
const DesignVisitFollowupModal = React.lazy(() =>
  import('./modals/DesignVisitFollowupModal').then(m => ({ default: m.DesignVisitFollowupModal }))
);
const OpenDealActionModal = React.lazy(() =>
  import('./modals/OpenDealActionModal').then(m => ({ default: m.OpenDealActionModal }))
);
const DepositInvoiceModal = React.lazy(() =>
  import('./modals/DepositInvoiceModal').then(m => ({ default: m.DepositInvoiceModal }))
);
import { broadcastDesignVisitDraftChanged } from '../utils/broadcastDesignVisitDraft';
import { broadcastContactAttemptLogged } from '../utils/broadcastContactAttempt';
import { registerCardActionModalOpener } from '../utils/cardActionModalRegistry';
import type { CardActionHandlerData } from '../hooks/useCardActionHandlers';
import type { CardActionContext } from '../utils/dispatchCardActionHandler';
import type { ExistingVisit } from './DesignVisitWizard';
import type { ExistingSurveyVisit } from './SurveyVisitWizard';

type ModalState =
  | { type: 'none' }
  | { type: 'show_message';                  handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'schedule_visit';                handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'summarise_phone_call';          handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'start_design_visit';            handler: CardActionHandlerData; ctx: CardActionContext; existingVisit?: ExistingVisit | null }
  | { type: 'start_survey_visit';            handler: CardActionHandlerData; ctx: CardActionContext; existingSurveyVisit?: ExistingSurveyVisit | null }
  | { type: 'upload_photos_and_info';        handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'review_customer_photos';        handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'arrange_visit';                 handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'contact_customer';              contactId: string; contactName: string; contactEmail: string; contactPhone?: string; contactMobile?: string }
  | { type: 'design_visit_followup';         handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'open_deal';                     handler: CardActionHandlerData; ctx: CardActionContext }
  | { type: 'deposit_invoice_followup';      handler: CardActionHandlerData; ctx: CardActionContext };

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
        case 'schedule_visit':
          setModal({ type: 'schedule_visit', handler, ctx });
          break;
        case 'summarise_phone_call':
          setModal({ type: 'summarise_phone_call', handler, ctx });
          break;
        case 'start_design_visit':
          setModal({ type: 'start_design_visit', handler, ctx, existingVisit });
          break;
        case 'start_survey_visit':
          setModal({ type: 'start_survey_visit', handler, ctx });
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
          setModal({ type: 'contact_customer', contactId: ctx.contactId, contactName: ctx.contactName, contactEmail: ctx.contactEmail, contactPhone: ctx.contactPhone, contactMobile: ctx.contactMobile });
          break;
        case 'design_visit_followup':
          setModal({ type: 'design_visit_followup', handler, ctx });
          break;
        case 'open_deal':
          setModal({ type: 'open_deal', handler, ctx });
          break;
        case 'deposit_invoice_followup':
          setModal({ type: 'deposit_invoice_followup', handler, ctx });
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
      {modal.type === 'schedule_visit' && (
        <React.Suspense fallback={null}>
          <ScheduleVisitModal
            handler={modal.handler}
            ctx={modal.ctx}
            visitType={modal.handler.config?.visitType as string | undefined}
            open
            onClose={close}
          />
        </React.Suspense>
      )}
      {modal.type === 'summarise_phone_call' && (
        <PhoneSummaryModal handler={modal.handler} ctx={modal.ctx} open onClose={close} />
      )}
      {modal.type === 'start_design_visit' && (
        <React.Suspense fallback={null}>
          <DesignVisitWizard
            handler={modal.handler}
            ctx={modal.ctx}
            existingVisit={modal.existingVisit}
            onClose={close}
          />
        </React.Suspense>
      )}
      {modal.type === 'start_survey_visit' && (
        <React.Suspense fallback={null}>
          <SurveyVisitWizard
            handler={modal.handler}
            ctx={modal.ctx}
            existingVisit={modal.existingSurveyVisit}
            onClose={close}
          />
        </React.Suspense>
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
        <React.Suspense fallback={null}>
          <ArrangeVisitModal handler={modal.handler} ctx={modal.ctx} open onClose={close} />
        </React.Suspense>
      )}
      {modal.type === 'contact_customer' && (
        <React.Suspense fallback={null}>
          <ContactCustomerModal
            contactId={modal.contactId}
            contactName={modal.contactName}
            contactEmail={modal.contactEmail}
            contactPhone={modal.contactPhone}
            contactMobile={modal.contactMobile}
            onClose={close}
          />
        </React.Suspense>
      )}
      {modal.type === 'design_visit_followup' && (
        <React.Suspense fallback={null}>
          <DesignVisitFollowupModal handler={modal.handler} ctx={modal.ctx} open onClose={close} />
        </React.Suspense>
      )}
      {modal.type === 'open_deal' && (
        <React.Suspense fallback={null}>
          <OpenDealActionModal handler={modal.handler} ctx={modal.ctx} open onClose={close} />
        </React.Suspense>
      )}
      {modal.type === 'deposit_invoice_followup' && (
        <React.Suspense fallback={null}>
          <DepositInvoiceModal handler={modal.handler} ctx={modal.ctx} open onClose={close} />
        </React.Suspense>
      )}
    </>
  );
}
