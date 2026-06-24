/**
 * DesignVisitFollowupModal — card-action handler for design_visit_followup.
 *
 * Flow:
 *   loading → hub → one of three paths:
 *     • confirmed  → ScheduleVisitModal (visitType locked to 'design') →
 *                    POST /api/card-actions/design-visit-followup/outcome → done
 *     • resend     → optional date/time picker + editable email (visit_invite template) →
 *                    POST /api/emails/send →
 *                    POST /api/card-actions/design-visit-followup/outcome → done
 *     • not_proceeding → POST /api/card-actions/design-visit-followup/outcome → done
 *
 * Draft persistence: sessionStorage keyed per contactId (DVF_DRAFT_PREFIX).
 * The draft only stores the current step (to restore position on refresh);
 * email body is always freshly fetched from the template.
 */
import React, { useEffect, useRef, useState } from 'react';
import { DVF_DRAFT_PREFIX } from '../../constants/localStorageKeys';
import { DVF_OUTCOME_KEY, STAFF_EMAIL_TEMPLATE_KEY } from '../../utils/handlerMeta';
import { leadStatusConfirmationMessage } from '../../utils/leadStatusConfirmation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { DuplicateCancelErrorAlert } from './DuplicateCancelErrorAlert';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { TimePicker } from '@mui/x-date-pickers/TimePicker';
import type { Dayjs } from 'dayjs';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';
import { GET, POST, DELETE } from '../../utils/api';
import { useToast } from '../../contexts/ToastContext';
import { useDiscardGuard } from '../../hooks/useDiscardGuard';
import { useBeforeUnloadGuard } from '../../hooks/useBeforeUnloadGuard';
import dayjs from 'dayjs';
import { DEMO_CONTACT } from './demoData';
import { DemoActionTooltip } from './demoMode';
import { DiscardConfirmDialog } from './DiscardConfirmDialog';
import { FullScreenModal } from './FullScreenModal';
import { ModalContactHeader } from './ModalContactHeader';
import { ScheduleVisitModal } from './ScheduleVisitModal';

type Step = 'loading' | 'hub' | 'schedule' | 'resend' | 'outcome_in_progress' | 'done';

interface ContactInfo {
  contactName: string;
  contactEmail: string;
  phone: string;
  mobile: string;
  leadStatus: string | null;
  contactAddress: string;
}

const DEMO_CONTACT_INFO: ContactInfo = {
  contactName: DEMO_CONTACT.name,
  contactEmail: DEMO_CONTACT.email,
  phone: DEMO_CONTACT.phone,
  mobile: DEMO_CONTACT.mobile,
  leadStatus: null,
  contactAddress: DEMO_CONTACT.address,
};

function draftKey(contactId: string | number | null | undefined): string {
  return `${DVF_DRAFT_PREFIX}${contactId ?? 'unknown'}`;
}

function saveDraftStep(key: string, step: Step): void {
  try { sessionStorage.setItem(key, step); } catch { /* ignore */ }
}

function clearDraftStep(key: string): void {
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
}

/** Format a date + time pair as a human-readable proposed slot sentence, or '' if neither is set. */
function buildProposedDateLine(date: Dayjs | null, time: Dayjs | null): string {
  if (!date && !time) return '';
  const parts: string[] = [];
  if (date) parts.push(date.format('D MMMM YYYY'));
  if (time) parts.push(time.format('h:mm A'));
  return `We have a proposed slot available: ${parts.join(' at ')}. Please let us know if this works for you, or suggest an alternative time.\n\n`;
}

interface CalendarEventStub {
  id?: string;
  summary?: string;
  start?: { dateTime?: string };
}

export interface DesignVisitFollowupModalProps {
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
  demo?: boolean;
}

export function DesignVisitFollowupModal({ handler, ctx, open, onClose, demo }: DesignVisitFollowupModalProps) {
  const showToast = useToast();
  const key = draftKey(ctx.contactId);

  const [step, setStep] = useState<Step>(demo ? 'hub' : 'loading');
  const [contactInfo, setContactInfo] = useState<ContactInfo | null>(demo ? DEMO_CONTACT_INFO : null);
  const [loadError, setLoadError] = useState('');

  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [emailFetchedSubject, setEmailFetchedSubject] = useState('');
  const [emailFetchedBody, setEmailFetchedBody] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailError, setEmailError] = useState('');

  const [resendDate, setResendDate] = useState<Dayjs | null>(null);
  const [resendTime, setResendTime] = useState<Dayjs | null>(null);

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [outcomeError, setOutcomeError] = useState('');

  const [duplicateEvent, setDuplicateEvent] = useState<CalendarEventStub | null>(null);
  const [showDuplicateConfirm, setShowDuplicateConfirm] = useState(false);
  const [cancellingExisting, setCancellingExisting] = useState(false);
  const [cancelExistingError, setCancelExistingError] = useState('');
  const [showRescheduleModal, setShowRescheduleModal] = useState(false);

  const fetchedRef = useRef(false);

  function goToStep(s: Step) {
    setStep(s);
    saveDraftStep(key, s);
  }

  function handleClose() {
    clearDraftStep(key);
    setShowDuplicateConfirm(false);
    setDuplicateEvent(null);
    setCancelExistingError('');
    onClose();
  }

  useEffect(() => {
    if (!open || fetchedRef.current) return;
    if (demo) {
      fetchedRef.current = true;
      setContactInfo(DEMO_CONTACT_INFO);
      setStep('hub');
      return;
    }
    fetchedRef.current = true;
    setStep('loading');
    setLoadError('');
    POST('/api/card-actions/design-visit-followup', { contactId: ctx.contactId })
      .then((data) => {
        setContactInfo(data as ContactInfo);
        goToStep('hub');
      })
      .catch((e: Error) => {
        setLoadError((e as { message?: string }).message || 'Failed to load contact info.');
        setStep('hub');
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Fetch (or re-fetch) the visit_invite template, incorporating optional proposed date/time. */
  function fetchResendTemplate(date: Dayjs | null, time: Dayjs | null, info: ContactInfo | null) {
    if (demo) {
      const firstName = (info?.contactName || '').split(' ')[0] || 'there';
      const subj = 'Your design visit — getting in touch';
      const body = `Hi ${firstName},\n\nThank you for your interest in booking a design visit with us.\n\nCould you please let us know your availability over the next week?\n\nBest regards`;
      setEmailSubject(subj);
      setEmailBody(body);
      setEmailFetchedSubject(subj);
      setEmailFetchedBody(body);
      return;
    }
    setEmailLoading(true);
    setEmailError('');
    const firstName = (info?.contactName || '').split(' ')[0] || 'there';
    POST('/api/email-templates/render', {
      key: STAFF_EMAIL_TEMPLATE_KEY.visit_invite,
      vars: {
        firstName,
        visitLabel: 'design visit',
        visitDuration: '60',
        location: info?.contactAddress ? ` at ${info.contactAddress}` : '',
        proposedDate: date ? date.format('D MMMM YYYY') : '',
        proposedTime: time ? time.format('h:mm A') : '',
        proposedDateLine: buildProposedDateLine(date, time),
      },
    })
      .then((data) => {
        const d = data as { subject?: string; body_text?: string };
        const subj = d.subject ?? '';
        const body = d.body_text ?? '';
        setEmailSubject(subj);
        setEmailBody(body);
        setEmailFetchedSubject(subj);
        setEmailFetchedBody(body);
      })
      .catch(() => {
        const subj = 'Your design visit — getting in touch';
        const body = `Hi ${firstName},\n\nThank you for your interest in booking a design visit with us.\n\nCould you please let us know your availability over the next week?\n\nBest regards`;
        setEmailSubject(subj);
        setEmailBody(body);
        setEmailFetchedSubject(subj);
        setEmailFetchedBody(body);
      })
      .finally(() => setEmailLoading(false));
  }

  // "Resend invite" — fetch editable visit_invite template
  function handleResendInvite() {
    goToStep('resend');
    setResendDate(null);
    setResendTime(null);
    fetchResendTemplate(null, null, contactInfo);
  }

  // Re-fetch template whenever the proposed date/time changes (only on the resend step, non-demo)
  useEffect(() => {
    if (step !== 'resend') return;
    if (demo) return;
    fetchResendTemplate(resendDate, resendTime, contactInfo);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resendDate, resendTime]);

  // "Confirmed" — check for duplicate calendar events then open ScheduleVisitModal
  async function handleConfirmed() {
    if (demo) {
      goToStep('schedule');
      setScheduleOpen(true);
      return;
    }
    try {
      const events = await GET<{ items?: CalendarEventStub[] }>(
        `/api/events?contactId=${encodeURIComponent(ctx.contactId)}`
      );
      const future = (events.items ?? []).find(e => {
        const dt = e.start?.dateTime;
        return dt ? dayjs(dt).isAfter(dayjs()) : false;
      });
      if (future) {
        setDuplicateEvent(future);
        setShowDuplicateConfirm(true);
        return;
      }
    } catch { /* Google not connected or network error — proceed */ }
    goToStep('schedule');
    setScheduleOpen(true);
  }

  /** Book both — dismiss the guard and open ScheduleVisitModal as normal. */
  function handleBookBoth() {
    setShowDuplicateConfirm(false);
    setDuplicateEvent(null);
    setCancelExistingError('');
    goToStep('schedule');
    setScheduleOpen(true);
  }

  /** Delete the existing event then open ScheduleVisitModal for a new booking. */
  async function handleCancelExisting() {
    if (!duplicateEvent?.id) {
      setCancelExistingError('Could not cancel the existing visit — no event ID was available. Use "Book both" or go back and cancel it manually.');
      return;
    }
    setCancellingExisting(true);
    setCancelExistingError('');
    try {
      await DELETE(`/api/events/${encodeURIComponent(duplicateEvent.id)}`);
    } catch (e) {
      setCancellingExisting(false);
      setCancelExistingError((e as Error).message || 'Could not cancel the existing visit.');
      return;
    }
    setCancellingExisting(false);
    setShowDuplicateConfirm(false);
    setDuplicateEvent(null);
    goToStep('schedule');
    setScheduleOpen(true);
  }

  /** Open a second ScheduleVisitModal pre-populated with the existing event's details. */
  function handleRescheduleExisting() {
    setShowDuplicateConfirm(false);
    setCancelExistingError('');
    setShowRescheduleModal(true);
  }

  // Called by ScheduleVisitModal on successful calendar event creation
  function handleScheduleSuccess() {
    setScheduleOpen(false);
    if (demo) {
      showToast('Demo mode — no changes saved', false);
      goToStep('done');
      return;
    }
    goToStep('outcome_in_progress');
    setOutcomeError('');
    POST('/api/card-actions/design-visit-followup/outcome', {
      contactId: ctx.contactId,
      outcome: DVF_OUTCOME_KEY.confirmed,
    })
      .then((data) => {
        const conf = leadStatusConfirmationMessage((data as { setsLeadStatus?: string | null } | undefined)?.setsLeadStatus);
        showToast(conf ? `Visit confirmed — ${conf.toLowerCase()}` : 'Visit confirmed and scheduled', false);
        goToStep('done');
      })
      .catch((e: Error) => {
        setOutcomeError((e as { message?: string }).message || 'Failed to update lead status.');
        goToStep('hub');
      });
  }

  function handleScheduleClose() {
    setScheduleOpen(false);
    if (step === 'schedule') goToStep('hub');
  }

  async function handleSendResendEmail() {
    if (!demo && !contactInfo?.contactEmail) return;
    setEmailError('');
    if (demo) {
      showToast('Demo mode — no changes saved', false);
      goToStep('done');
      return;
    }
    goToStep('outcome_in_progress');
    try {
      await POST('/api/emails/send', {
        to: contactInfo!.contactEmail,
        subject: emailSubject.trim(),
        text: emailBody.trim(),
      });
      const data = await POST('/api/card-actions/design-visit-followup/outcome', {
        contactId: ctx.contactId,
        outcome: DVF_OUTCOME_KEY.invite_resent,
      }) as { setsLeadStatus?: string | null } | undefined;
      const conf = leadStatusConfirmationMessage(data?.setsLeadStatus);
      showToast(conf ? `Invite email sent — ${conf.toLowerCase()}` : 'Invite email sent', false);
      goToStep('done');
    } catch (e) {
      setEmailError((e as { message?: string }).message || 'Failed to send email.');
      goToStep('resend');
    }
  }

  async function handleNotProceeding() {
    if (demo) {
      showToast('Demo mode — no changes saved', false);
      goToStep('done');
      return;
    }
    goToStep('outcome_in_progress');
    setOutcomeError('');
    try {
      const data = await POST('/api/card-actions/design-visit-followup/outcome', {
        contactId: ctx.contactId,
        outcome: DVF_OUTCOME_KEY.not_proceeding,
      }) as { setsLeadStatus?: string | null } | undefined;
      const conf = leadStatusConfirmationMessage(data?.setsLeadStatus);
      showToast(conf ? `Not proceeding — ${conf.toLowerCase()}` : 'Contact marked as not proceeding', false);
      goToStep('done');
    } catch (e) {
      setOutcomeError((e as { message?: string }).message || 'Failed to update lead status.');
      goToStep('hub');
    }
  }

  // Auto-close once done step is shown
  useEffect(() => {
    if (step === 'done') {
      const t = setTimeout(() => handleClose(), 1200);
      return () => clearTimeout(t);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const isLocked = step === 'outcome_in_progress';
  const hasUnsavedChanges = !isLocked && !demo && step === 'resend' && !emailLoading && (
    resendDate !== null ||
    resendTime !== null ||
    emailSubject.trim() !== emailFetchedSubject.trim() ||
    emailBody.trim()    !== emailFetchedBody.trim()
  );

  const { confirmOpen: confirmDiscardOpen, handleRequestClose, handleKeepEditing } = useDiscardGuard(
    hasUnsavedChanges,
    handleClose,
    isLocked,
  );
  useBeforeUnloadGuard(hasUnsavedChanges);

  const hubDialogOpen = open && step !== 'schedule' && !showDuplicateConfirm && !showRescheduleModal;

  function renderContent() {
    if (step === 'loading') {
      return (
        <Stack spacing={2}>
          <ModalContactHeader
            name={ctx.contactName}
            email={ctx.contactEmail}
            phone={ctx.contactPhone}
            mobile={ctx.contactMobile}
          />
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={28} />
          </Box>
        </Stack>
      );
    }
    if (step === 'done') {
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <Typography variant="body2" color="text.secondary">Done — closing…</Typography>
        </Box>
      );
    }
    if (step === 'outcome_in_progress') {
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={28} />
        </Box>
      );
    }
    if (step === 'hub') {
      return (
        <Stack spacing={2}>
          {loadError && <Alert severity="error">{loadError}</Alert>}
          {outcomeError && <Alert severity="error">{outcomeError}</Alert>}
          <ModalContactHeader
            name={contactInfo?.contactName}
            email={contactInfo?.contactEmail}
            phone={contactInfo?.phone || ctx.contactPhone}
            mobile={contactInfo?.mobile || ctx.contactMobile}
          />
          <Typography variant="body2" color="text.secondary">
            What happened when you followed up?
          </Typography>
          <Stack spacing={1.5}>
            <Button
              variant="contained"
              color="success"
              fullWidth
              onClick={() => void handleConfirmed()}
              data-testid="dvf-confirmed"
            >
              Customer confirmed — schedule visit
            </Button>
            <Button
              variant="outlined"
              fullWidth
              onClick={handleResendInvite}
              disabled={!demo && !contactInfo?.contactEmail}
              data-testid="dvf-resend"
            >
              Resend invite email
            </Button>
            <DemoActionTooltip demo={demo}>
              <Button
                variant="outlined"
                color="error"
                fullWidth
                onClick={() => void handleNotProceeding()}
                data-testid="dvf-not-proceeding"
              >
                Not proceeding
              </Button>
            </DemoActionTooltip>
          </Stack>
        </Stack>
      );
    }
    if (step === 'resend') {
      return (
        <Stack spacing={2}>
          {emailError && <Alert severity="error">{emailError}</Alert>}
          <ModalContactHeader
            name={contactInfo?.contactName}
            email={contactInfo?.contactEmail}
            phone={contactInfo?.phone || ctx.contactPhone}
            mobile={contactInfo?.mobile || ctx.contactMobile}
          />
          <Typography variant="body2" color="text.secondary">
            Sending to: <strong>{contactInfo?.contactEmail || '—'}</strong>
          </Typography>
          <Stack spacing={1.5}>
            <Typography variant="body2" color="text.secondary">
              Optionally include a proposed date and time in the email:
            </Typography>
            <Stack direction="row" spacing={1.5}>
              <DatePicker
                label="Proposed date"
                value={resendDate}
                onChange={(v) => setResendDate(v)}
                slotProps={{ textField: { size: 'small', fullWidth: true } }}
                disablePast
              />
              <TimePicker
                label="Proposed time"
                value={resendTime}
                onChange={(v) => setResendTime(v)}
                slotProps={{ textField: { size: 'small', fullWidth: true } }}
              />
            </Stack>
          </Stack>
          {emailLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <CircularProgress size={24} />
            </Box>
          ) : (
            <>
              <TextField
                label="Subject"
                value={emailSubject}
                onChange={e => { setEmailSubject(e.target.value); setEmailError(''); }}
                size="small"
                fullWidth
                slotProps={{ htmlInput: { maxLength: 300 } }}
                data-testid="dvf-email-subject"
              />
              <TextField
                label="Body"
                value={emailBody}
                onChange={e => { setEmailBody(e.target.value); setEmailError(''); }}
                multiline
                minRows={6}
                size="small"
                fullWidth
                slotProps={{ htmlInput: { maxLength: 8000 } }}
                data-testid="dvf-email-body"
              />
              <Typography variant="caption" color="text.secondary">
                Sent from your connected Gmail account. Lead status will update to "Design Invited".
              </Typography>
            </>
          )}
        </Stack>
      );
    }
    return null;
  }

  function renderActions() {
    if (step === 'loading' || step === 'outcome_in_progress' || step === 'done') return null;
    if (step === 'hub') {
      return <Button onClick={handleClose}>Close</Button>;
    }
    if (step === 'resend') {
      return (
        <>
          <Button onClick={() => goToStep('hub')}>Back</Button>
          <DemoActionTooltip demo={demo}>
            <Button
              variant="contained"
              onClick={() => void handleSendResendEmail()}
              disabled={demo || emailLoading || !emailSubject.trim() || !emailBody.trim() || (!demo && !contactInfo?.contactEmail)}
              data-testid="dvf-send-invite"
            >
              Send invite
            </Button>
          </DemoActionTooltip>
        </>
      );
    }
    return null;
  }

  const dialogTitle = (() => {
    if (step === 'resend') return 'Resend design visit invite';
    if (step === 'done') return 'Done';
    return ctx.contactName ? `Follow up with ${ctx.contactName}` : 'Design visit follow-up';
  })();

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <>
        <FullScreenModal
          open={hubDialogOpen}
          onClose={handleRequestClose}
          disableClose={step === 'loading' || step === 'done' || isLocked}
          title={dialogTitle}
          headerActions={
            demo ? <Chip label="Demo preview" size="small" color="info" variant="outlined" /> : undefined
          }
          footer={renderActions() || undefined}
        >
          {renderContent()}
        </FullScreenModal>

        <DiscardConfirmDialog
          open={confirmDiscardOpen}
          onDiscard={handleClose}
          onKeepEditing={handleKeepEditing}
        />

        <ScheduleVisitModal
          handler={handler}
          ctx={{
            ...ctx,
            contactPhone:  contactInfo?.phone  || ctx.contactPhone,
            contactMobile: contactInfo?.mobile || ctx.contactMobile,
          }}
          visitType="design"
          contactAddress={contactInfo?.contactAddress}
          open={scheduleOpen}
          onClose={handleScheduleClose}
          onSuccess={handleScheduleSuccess}
          demo={demo ?? false}
        />

        {/* Duplicate-visit confirmation dialog */}
        <FullScreenModal
          open={showDuplicateConfirm}
          onClose={() => {
            if (cancellingExisting) return;
            setShowDuplicateConfirm(false);
            setDuplicateEvent(null);
            setCancelExistingError('');
          }}
          title="Existing visit found"
          centerContent
          footer={
            <>
              <Button
                onClick={() => {
                  setShowDuplicateConfirm(false);
                  setDuplicateEvent(null);
                  setCancelExistingError('');
                }}
                disabled={cancellingExisting}
              >
                Keep existing
              </Button>
              <Button
                onClick={handleRescheduleExisting}
                disabled={cancellingExisting}
                data-testid="dvf-duplicate-reschedule"
              >
                Reschedule existing
              </Button>
              <Button
                color="error"
                onClick={() => void handleCancelExisting()}
                disabled={cancellingExisting}
                data-testid="dvf-duplicate-cancel-existing"
              >
                {cancellingExisting ? 'Cancelling…' : 'Cancel existing & book new'}
              </Button>
              <Button
                variant="contained"
                onClick={handleBookBoth}
                disabled={cancellingExisting}
                data-testid="dvf-duplicate-book-both"
              >
                Book both
              </Button>
            </>
          }
        >
          <Stack spacing={1}>
            <Typography variant="body2">
              {ctx.contactName || 'This contact'} already has a visit booked
              {duplicateEvent?.start?.dateTime
                ? ` for ${dayjs(duplicateEvent.start.dateTime).format('dddd D MMMM [at] h:mm A')}`
                : ''}
              .
            </Typography>
            <Typography variant="body2">
              How would you like to proceed?
            </Typography>
            {/* Canonical duplicate-visit cancel-existing error pattern.
                See DuplicateCancelErrorAlert for the shared component and
                instructions for new visit types that need the same guard. */}
            {cancelExistingError && (
              <DuplicateCancelErrorAlert
                message={cancelExistingError}
                onRetry={() => void handleCancelExisting()}
                retryButtonTestId="dvf-duplicate-cancel-existing-retry"
              />
            )}
          </Stack>
        </FullScreenModal>

        {/* Reschedule existing visit — pre-populated with the existing event's details */}
        {showRescheduleModal && (
          <ScheduleVisitModal
            ctx={{
              ...ctx,
              contactPhone:  contactInfo?.phone  || ctx.contactPhone,
              contactMobile: contactInfo?.mobile || ctx.contactMobile,
            }}
            visitType="design"
            contactAddress={contactInfo?.contactAddress}
            initialStartDt={duplicateEvent?.start?.dateTime}
            initialTitle={duplicateEvent?.summary}
            existingEventId={duplicateEvent?.id}
            open={showRescheduleModal}
            onClose={() => { setShowRescheduleModal(false); setDuplicateEvent(null); }}
            onSuccess={() => {
              setShowRescheduleModal(false);
              setDuplicateEvent(null);
              showToast('Existing visit rescheduled', false);
            }}
            demo={demo ?? false}
          />
        )}
      </>
    </LocalizationProvider>
  );
}
