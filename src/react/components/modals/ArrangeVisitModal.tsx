import React, { useEffect, useRef, useState } from 'react';
import { ARRANGE_VISIT_DRAFT_PREFIX } from '../../constants/localStorageKeys';
import { nowDate, nowDateTime } from '../../utils/dateDefaults';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { TimePicker } from '@mui/x-date-pickers/TimePicker';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';
import { POST, PATCH, ApiError, isGoogleAuthError, LEAD_STATUS_REMOVED_MESSAGE } from '../../utils/api';
import { openConnectModal, useServiceStatuses } from '../../context/ConnectionToastContext';
import { GoogleAuthAlert } from '../GoogleAuthAlert';
import { useToast } from '../../contexts/ToastContext';
import { useDiscardGuard } from '../../hooks/useDiscardGuard';
import { DiscardConfirmDialog } from './DiscardConfirmDialog';
import { broadcastLeadStatusChange } from '../../utils/broadcastLeadStatus';
import { leadStatusConfirmationMessage } from '../../utils/leadStatusConfirmation';
import { ARRANGE_VISIT_KEY, STAFF_EMAIL_TEMPLATE_KEY } from '../../utils/handlerMeta';
import { ModalContactHeader } from './ModalContactHeader';
import { DemoActionTooltip } from './demoMode';
import { FullScreenModal } from './FullScreenModal';
import { DEMO_CONTACT } from './demoData';
import { AddressInput } from '../AddressInput';
import { emptyAddress, formatAddress, type StructuredAddress } from '../../../../shared/address';

interface Props {
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
  demo?: boolean;
}

type Step =
  | 'loading'
  | 'call'
  | 'booked'
  | 'email'
  | 'done';

interface ContactInfo {
  visitType: 'design' | 'survey';
  contactName: string;
  contactPhone: string;
  contactMobilePhone: string;
  contactEmail: string;
  contactAddress: string;
  contactStructuredAddress: StructuredAddress;
}

interface DraftState {
  step: Step;
  structuredAddress: StructuredAddress;
  bookedSlotIso: string | null;
  emailSubject: string;
  emailBody: string;
  proposedEmailDateIso: string | null;
  proposedEmailTimeIso: string | null;
}

/** Format a date + time pair as a human-readable proposed slot sentence, or '' if neither is set. */
function buildProposedDateLine(date: Dayjs | null, time: Dayjs | null): string {
  if (!date && !time) return '';
  const parts: string[] = [];
  if (date) parts.push(date.format('D MMMM YYYY'));
  if (time) parts.push(time.format('h:mm A'));
  return `We have a proposed slot available: ${parts.join(' at ')}. Please let us know if this works for you, or suggest an alternative time.\n\n`;
}

function draftKey(contactId: string): string {
  return ARRANGE_VISIT_DRAFT_PREFIX + contactId;
}

function loadDraft(key: string): Partial<DraftState> {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<DraftState>;
  } catch {
    return {};
  }
}

function saveDraft(key: string, draft: Partial<DraftState>): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // quota or private browsing — silently ignore
  }
}

function clearDraft(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function visitLabel(visitType: 'design' | 'survey'): string {
  return visitType === 'survey' ? 'survey visit' : 'design visit';
}

const DEMO_CONTACT_INFO: ContactInfo = {
  visitType: DEMO_CONTACT.visitType,
  contactName: DEMO_CONTACT.name,
  contactPhone: DEMO_CONTACT.phone,
  contactMobilePhone: DEMO_CONTACT.mobile,
  contactEmail: DEMO_CONTACT.email,
  contactAddress: DEMO_CONTACT.address,
  contactStructuredAddress: {
    addressLines: ['12 Willow Lane'],
    locality: 'London',
    administrativeArea: '',
    postalCode: 'SW1A 1AA',
    countryCode: 'GB',
  },
};

export function ArrangeVisitModal({ handler, ctx, open, onClose, demo }: Props) {
  const key = draftKey(ctx.contactId);
  const draft = demo ? {} : loadDraft(key);

  const showToast = useToast();
  const serviceStatuses = useServiceStatuses();
  const googleDisconnected = serviceStatuses.get('google') === 'error';

  const [step, setStep] = useState<Step>(demo ? 'call' : 'loading');
  const [contactInfo, setContactInfo] = useState<ContactInfo | null>(demo ? DEMO_CONTACT_INFO : null);
  // True while the background contact-info fetch is in flight (e.g. during a
  // draft restore where the step jumps past 'loading' but contactInfo is null).
  // Lets ModalContactHeader show skeletons instead of a false "no details" warning.
  const [contactLoading, setContactLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');
  // Becomes true the first time the user progresses past the initial 'call' step.
  // Stays true even if they navigate back to 'call', so closing still prompts.
  // Initialized from restored draft so a draft on booked/email step already counts.
  const [madeProgress, setMadeProgress] = useState(
    draft.step === 'booked' || draft.step === 'email'
  );

  const hasUnsavedChanges =
    step === 'booked' ||
    step === 'email' ||
    (madeProgress && step === 'call');
  const _hasUnsavedChangesRef = useRef(hasUnsavedChanges);
  _hasUnsavedChangesRef.current = hasUnsavedChanges;

  const [structuredAddress, setStructuredAddress] = useState<StructuredAddress>(
    demo ? DEMO_CONTACT_INFO.contactStructuredAddress : (draft.structuredAddress ?? emptyAddress()),
  );
  const [bookedSlot, setBookedSlot] = useState<Dayjs | null>(
    draft.bookedSlotIso ? dayjs(draft.bookedSlotIso) : dayjs(nowDateTime()),
  );

  const [emailSubject, setEmailSubject] = useState(draft.emailSubject ?? '');
  const [emailBody, setEmailBody]       = useState(draft.emailBody ?? '');

  const [proposedEmailDate, setProposedEmailDate] = useState<Dayjs | null>(
    draft.proposedEmailDateIso ? dayjs(draft.proposedEmailDateIso) : dayjs(nowDate()),
  );
  const [proposedEmailTime, setProposedEmailTime] = useState<Dayjs | null>(
    draft.proposedEmailTimeIso ? dayjs(draft.proposedEmailTimeIso) : dayjs(nowDateTime()),
  );
  const [emailLoading, setEmailLoading] = useState(false);

  // Pre-fetched no-answer template from the server (admin-editable). Populated
  // alongside the contact-info load so clicking "No answer" has no extra delay.
  const [noAnswerTemplate, setNoAnswerTemplate] = useState<{ subject: string; body_text: string } | null>(null);

  useEffect(() => {
    if (!open) return;

    setLoadError('');
    setActionError('');
    setNoAnswerTemplate(null);

    if (demo) {
      setContactInfo(DEMO_CONTACT_INFO);
      setContactLoading(false);
      setStep(prev => prev === 'loading' ? 'call' : prev);
      return;
    }

    setContactLoading(true);

    const hasDraft = draft.step && draft.step !== 'loading' && draft.step !== 'done';
    if (hasDraft) {
      setStep(draft.step as Step);
      if (draft.structuredAddress) setStructuredAddress(draft.structuredAddress);
      if (draft.bookedSlotIso) setBookedSlot(dayjs(draft.bookedSlotIso));
      if (draft.emailSubject) setEmailSubject(draft.emailSubject);
      if (draft.emailBody) setEmailBody(draft.emailBody);
      // Fall through: still fetch contactInfo in the background so phone
      // numbers are populated even when restoring from a saved draft.
    } else {
      setStep('loading');
    }

    POST('/api/card-actions/arrange-visit', { contactId: ctx.contactId })
      .then((data: unknown) => {
        const d = data as ContactInfo;
        setContactInfo(d);
        setContactLoading(false);
        if (!hasDraft) {
          // Fresh open: initialise address and step from the API response.
          // Use functional update so a stale response from a rapid reopen
          // never clobbers a step that has already advanced past 'loading'.
          setStructuredAddress(d.contactStructuredAddress || emptyAddress());
          setStep(prev => prev === 'loading' ? 'call' : prev);
          saveDraft(key, { step: 'call', structuredAddress: d.contactStructuredAddress || emptyAddress(), bookedSlotIso: null, emailSubject: '', emailBody: '' });
        }

        // Pre-fetch the no-answer email template using the actual contact name
        // and visit type so it reflects any admin edits to the template.
        const firstName = (d.contactName || '').split(' ')[0] || 'there';
        const vLabel = visitLabel(d.visitType ?? 'design');
        POST('/api/email-templates/render', {
          key: STAFF_EMAIL_TEMPLATE_KEY.arrange_visit_no_answer,
          vars: { firstName, visitLabel: vLabel, proposedDate: '', proposedTime: '', proposedDateLine: '' },
        })
          .then((t: unknown) => setNoAnswerTemplate(t as { subject: string; body_text: string }))
          .catch(() => { /* silently ignore — buildNoAnswerEmail fallback used */ });
      })
      .catch((e: Error) => {
        setContactLoading(false);
        if (!hasDraft) {
          // Fresh open: show the error and advance past the loading spinner.
          setLoadError(e.message || 'Could not load contact info.');
          setStep(prev => prev === 'loading' ? 'call' : prev);
        }
        // Draft restore: phone numbers just won't appear if the API is
        // unreachable; the user can still proceed with their saved state.
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (demo) return;
    if (step === 'loading' || step === 'done') return;
    saveDraft(key, {
      step,
      structuredAddress,
      bookedSlotIso: bookedSlot?.toISOString() ?? null,
      emailSubject,
      emailBody,
      proposedEmailDateIso: proposedEmailDate?.toISOString() ?? null,
      proposedEmailTimeIso: proposedEmailTime?.toISOString() ?? null,
    });
  }, [key, step, structuredAddress, bookedSlot, emailSubject, emailBody, proposedEmailDate, proposedEmailTime]);

  // Re-fetch the no-answer email template whenever the proposed date/time changes
  // while the user is on the email step (same pattern as DesignVisitFollowupModal).
  useEffect(() => {
    if (step !== 'email') return;
    fetchEmailTemplate(proposedEmailDate, proposedEmailTime, contactInfo);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposedEmailDate, proposedEmailTime]);

  function handleClose() {
    setActionError('');
    setMadeProgress(false);
    onClose();
  }

  function handleDiscard() {
    if (!demo) clearDraft(key);
    handleClose();
  }

  const { confirmOpen: confirmDiscardOpen, handleRequestClose, handleKeepEditing } = useDiscardGuard(
    demo ? false : _hasUnsavedChangesRef.current,
    handleDiscard,
    submitting,
  );

  async function handleOutcome(outcome: 'not_proceeding' | 'call_back_later') {
    if (outcome === 'call_back_later') {
      if (!demo) clearDraft(key);
      onClose();
      return;
    }
    if (demo) return;
    setSubmitting(true);
    setActionError('');
    try {
      // Offline-aware: the status change is queued and replayed on reconnect.
      const { sendOrQueue } = await import('../../lib/offlineQueue');
      const res = await sendOrQueue({
        area: 'visit',
        label: 'Visit outcome — not proceeding',
        method: 'POST',
        url: '/api/card-actions/arrange-visit/outcome',
        body: {
          contactId: ctx.contactId,
          outcome: ARRANGE_VISIT_KEY.not_proceeding,
          visitType: contactInfo?.visitType ?? 'design',
        },
      });
      if (!res.queued && !res.ok) {
        const d = res.data as { error?: string; code?: string } | undefined;
        if (d?.code === 'LEAD_STATUS_REMOVED') {
          throw new Error(LEAD_STATUS_REMOVED_MESSAGE);
        }
        throw new Error(d?.error || 'Could not update status.');
      }
      clearDraft(key);
      if (res.queued) {
        showToast('Saved offline — status will update when you reconnect', false);
      } else {
        const d = res.data as { hs_lead_status?: string; setsLeadStatus?: string | null } | undefined;
        showToast(leadStatusConfirmationMessage(d?.setsLeadStatus) || 'Status updated to Not Suitable', false);
        broadcastLeadStatusChange(ctx.contactId, {
          hs_lead_status: d?.hs_lead_status ?? '',
        });
      }
      setStep('done');
      onClose();
    } catch (e) {
      setActionError((e as Error).message || 'Could not update status.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleBooked() {
    if (demo) return;
    if (!bookedSlot || !bookedSlot.isValid()) {
      setActionError('Please select a date and time.');
      return;
    }
    setSubmitting(true);
    setActionError('');
    try {
      // Offline-aware: the booking status change is queued and replayed on
      // reconnect. The calendar-event side effect requires a live Google
      // session, so it is dispatched only when the write actually went through
      // now (skipped when queued offline).
      // Persist any address edits back to the contact (HubSpot source of truth).
      // Best-effort: a failure here (e.g. offline) must not block the booking,
      // which is itself offline-aware via sendOrQueue below.
      try {
        await PATCH(`/api/contacts/${encodeURIComponent(ctx.contactId)}`, { structuredAddress });
      } catch { /* address save is best-effort; booking still proceeds */ }

      const { sendOrQueue } = await import('../../lib/offlineQueue');
      const res = await sendOrQueue({
        area: 'visit',
        label: 'Visit booked',
        method: 'POST',
        url: '/api/card-actions/arrange-visit/outcome',
        body: {
          contactId: ctx.contactId,
          outcome: ARRANGE_VISIT_KEY.booked,
          visitType: contactInfo?.visitType ?? 'design',
          slot: bookedSlot.toISOString(),
          address: formatAddress(structuredAddress),
        },
      });
      if (!res.queued && !res.ok) {
        const d = res.data as { error?: string; code?: string } | undefined;
        if (d?.code === 'LEAD_STATUS_REMOVED') {
          throw new Error(LEAD_STATUS_REMOVED_MESSAGE);
        }
        throw new Error(d?.error || 'Could not update status.');
      }
      clearDraft(key);

      if (res.queued) {
        showToast('Booking saved offline — it will sync when you reconnect', false);
      } else {
        const d = res.data as { hs_lead_status?: string; setsLeadStatus?: string | null } | undefined;
        const conf = leadStatusConfirmationMessage(d?.setsLeadStatus);
        showToast(conf ? `Visit booked — ${conf.toLowerCase()}` : 'Visit booked and status updated', false);
        broadcastLeadStatusChange(ctx.contactId, {
          hs_lead_status: d?.hs_lead_status ?? '',
        });
        const calendarHandler = _findCalendarHandler();
        if (calendarHandler) {
          const d = window as unknown as {
            dispatchCardActionHandler?: (h: CardActionHandlerData, c: CardActionContext) => void;
          };
          d.dispatchCardActionHandler?.(calendarHandler, {
            ...ctx,
            contactName: contactInfo?.contactName || ctx.contactName,
          });
        }
      }

      setStep('done');
      onClose();
    } catch (e) {
      setActionError((e as Error).message || 'Could not update status.');
    } finally {
      setSubmitting(false);
    }
  }

  function buildNoAnswerEmail(name: string, vLabel: string): { subject: string; body: string } {
    const firstName = name.split(' ')[0] || 'there';
    const subject = `Booking your ${vLabel} — getting in touch`;
    const body =
      `Hi ${firstName},\n\n` +
      `Thanks for your interest in booking a ${vLabel} with us. I tried to give you a call but wasn't able to reach you.\n\n` +
      `Could you let us know your availability over the next week? If you can share which days and evenings work best for you, we can either call you back at a convenient time or lock in a date for your ${vLabel}.\n\n` +
      `Just reply to this email and we'll get it arranged.\n\n` +
      `Best regards`;
    return { subject, body };
  }

  function fetchEmailTemplate(date: Dayjs | null, time: Dayjs | null, info: ContactInfo | null): void {
    setEmailLoading(true);
    const firstName = (info?.contactName || '').split(' ')[0] || 'there';
    const vLabel = visitLabel(info?.visitType ?? 'design');
    POST('/api/email-templates/render', {
      key: STAFF_EMAIL_TEMPLATE_KEY.arrange_visit_no_answer,
      vars: {
        firstName,
        visitLabel: vLabel,
        proposedDate: date ? date.format('D MMMM YYYY') : '',
        proposedTime: time ? time.format('h:mm A') : '',
        proposedDateLine: buildProposedDateLine(date, time),
      },
    })
      .then((t: unknown) => {
        const d = t as { subject?: string; body_text?: string };
        setEmailSubject(d.subject ?? '');
        setEmailBody(d.body_text ?? '');
      })
      .catch(() => {
        const { subject, body } = buildNoAnswerEmail(info?.contactName || 'there', vLabel);
        setEmailSubject(subject);
        setEmailBody(body);
      })
      .finally(() => setEmailLoading(false));
  }

  async function handleEmailSent() {
    if (demo) return;
    if (!emailBody.trim()) {
      setActionError('Email body cannot be empty.');
      return;
    }

    const visitType = contactInfo?.visitType ?? 'design';

    setSubmitting(true);
    setActionError('');
    try {
      await POST('/api/emails/send', {
        to: contactInfo?.contactEmail || ctx.contactEmail,
        subject: emailSubject,
        body: emailBody,
      });
      const outcomeData = await POST('/api/card-actions/arrange-visit/outcome', {
        contactId: ctx.contactId,
        outcome: ARRANGE_VISIT_KEY.email_sent,
        visitType,
      }) as { hs_lead_status?: string; setsLeadStatus?: string | null } | undefined;
      clearDraft(key);
      const conf = leadStatusConfirmationMessage(outcomeData?.setsLeadStatus);
      showToast(conf ? `Email sent — ${conf.toLowerCase()}` : 'Email sent and status updated', false);
      broadcastLeadStatusChange(ctx.contactId, {
        hs_lead_status: outcomeData?.hs_lead_status ?? '',
      });
      setStep('done');
      onClose();
    } catch (e) {
      if (isGoogleAuthError(e)) {
        setActionError('GOOGLE_AUTH');
        openConnectModal('google', 'Google is disconnected — reconnect it to send emails from your Gmail account.');
      } else if ((e as ApiError).code === 'LEAD_STATUS_REMOVED') {
        setActionError(LEAD_STATUS_REMOVED_MESSAGE);
      } else {
        setActionError((e as Error).message || 'Could not send email.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const visitType = contactInfo?.visitType ?? 'design';
  const label = visitLabel(visitType);
  const displayName = contactInfo?.contactName || ctx.contactName || 'the customer';
  const landline = contactInfo?.contactPhone || '';
  const mobile = contactInfo?.contactMobilePhone || '';

  const titleStr =
    step === 'loading' ? `Arrange ${label}`
    : step === 'call' ? `Call ${displayName}`
    : step === 'booked' ? `Book ${label} for ${displayName}`
    : step === 'email' ? `Ask ${displayName} for availability`
    : '';

  let footerNode: React.ReactNode = null;
  if (step === 'loading') {
    footerNode = <Button onClick={handleRequestClose}>Cancel</Button>;
  } else if (step === 'call') {
    footerNode = (
      <>
        <Button
          disabled={submitting}
          onClick={() => {
            setActionError('');
            setProposedEmailDate(dayjs(nowDate()));
            setProposedEmailTime(dayjs(nowDateTime()));
            if (!emailSubject && !emailBody) {
              if (noAnswerTemplate) {
                setEmailSubject(noAnswerTemplate.subject);
                setEmailBody(noAnswerTemplate.body_text);
              } else {
                fetchEmailTemplate(null, null, contactInfo);
              }
            }
            setMadeProgress(true); setStep('email');
          }}
          variant="outlined"
          data-testid="av-outcome-no-answer"
        >
          No answer
        </Button>
        <Button
          disabled={submitting}
          onClick={() => handleOutcome('call_back_later')}
          variant="outlined"
          data-testid="av-outcome-call-back"
        >
          Call back later
        </Button>
        <DemoActionTooltip demo={demo}>
          <Button
            disabled={submitting || demo}
            onClick={() => handleOutcome('not_proceeding')}
            color="error"
            variant="outlined"
            data-testid="av-outcome-not-proceeding"
          >
            {submitting ? <CircularProgress size={18} /> : 'Not proceeding'}
          </Button>
        </DemoActionTooltip>
        <Button
          disabled={submitting}
          onClick={() => { setActionError(''); setMadeProgress(true); setStep('booked'); }}
          variant="contained"
          color="success"
          data-testid="av-outcome-booked"
        >
          Booked
        </Button>
      </>
    );
  } else if (step === 'booked') {
    footerNode = (
      <>
        <Button onClick={() => { setActionError(''); setStep('call'); }} disabled={submitting}>Back</Button>
        <DemoActionTooltip demo={demo}>
          <Button
            variant="contained"
            onClick={handleBooked}
            disabled={submitting || demo}
            data-testid="av-booked-confirm"
          >
            {submitting ? <CircularProgress size={18} color="inherit" /> : 'Confirm booking'}
          </Button>
        </DemoActionTooltip>
      </>
    );
  } else if (step === 'email') {
    footerNode = (
      <>
        <Button onClick={() => { setActionError(''); setStep('call'); }} disabled={submitting}>Back</Button>
        <DemoActionTooltip demo={demo}>
          <Button
            variant="contained"
            onClick={handleEmailSent}
            disabled={submitting || demo || emailLoading}
            data-testid="av-email-send"
          >
            {submitting ? <CircularProgress size={18} color="inherit" /> : 'Send email'}
          </Button>
        </DemoActionTooltip>
      </>
    );
  }

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <FullScreenModal
        open={open}
        onClose={handleRequestClose}
        disableClose={submitting}
        title={titleStr}
        headerActions={
          demo ? <Chip label="Demo preview" size="small" color="info" variant="outlined" /> : undefined
        }
        footer={footerNode || undefined}
      >
        {step === 'loading' && (
          <>
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress size={36} />
            </Box>
            {loadError && (
              <Alert severity="error" sx={{ mt: 1 }}>{loadError}</Alert>
            )}
          </>
        )}

        {step === 'call' && (
              <Stack spacing={2} sx={{ mt: 0.5 }}>
                <ModalContactHeader
                  name={displayName}
                  phone={landline}
                  mobile={mobile}
                  email={contactInfo?.contactEmail || ctx.contactEmail}
                  loading={contactLoading && !contactInfo}
                />
                <Typography variant="body2">
                  Call {displayName} to book their {label}. What was the outcome?
                </Typography>
                {actionError && (
                  <Alert severity="error">{actionError}</Alert>
                )}
              </Stack>
        )}

        {step === 'booked' && (
              <Stack spacing={2} sx={{ mt: 0.5 }}>
                <ModalContactHeader
                  name={displayName}
                  phone={landline}
                  mobile={mobile}
                  email={contactInfo?.contactEmail || ctx.contactEmail}
                  loading={contactLoading && !contactInfo}
                />
                <DateTimePicker
                  label="Visit date & time"
                  value={bookedSlot}
                  onChange={(v: Dayjs | null) => setBookedSlot(v)}
                  slotProps={{
                    textField: {
                      id: 'av-booked-slot',
                      fullWidth: true,
                      size: 'small',
                    },
                  }}
                />
                <AddressInput
                  value={structuredAddress}
                  onChange={setStructuredAddress}
                  disabled={submitting}
                  idPrefix="av-booked-address"
                  surface="arrangeVisit"
                />
                {actionError && (
                  <Alert severity="error">{actionError}</Alert>
                )}
              </Stack>
        )}

        {step === 'email' && (
              <Stack spacing={2} sx={{ mt: 0.5 }}>
                <ModalContactHeader
                  name={displayName}
                  phone={landline}
                  mobile={mobile}
                  email={contactInfo?.contactEmail || ctx.contactEmail}
                  loading={contactLoading && !contactInfo}
                />
                {googleDisconnected && !demo && (
                  <Alert
                    severity="warning"
                    action={
                      <Button
                        color="inherit"
                        size="small"
                        onClick={() => openConnectModal('google', 'Reconnect Google to send emails.')}
                      >
                        Reconnect
                      </Button>
                    }
                  >
                    Google is disconnected — emails can&apos;t be sent until you reconnect.
                  </Alert>
                )}
                <Typography variant="body2" color="text.secondary">
                  We couldn't reach {displayName}. Review and edit the email below, then send it to ask for their availability.
                </Typography>
                <Stack spacing={1.5}>
                  <Typography variant="body2" color="text.secondary">
                    Optionally include a proposed date and time in the email:
                  </Typography>
                  <Stack direction="row" spacing={1.5}>
                    <DatePicker
                      label="Proposed date"
                      value={proposedEmailDate}
                      onChange={(v) => setProposedEmailDate(v)}
                      slotProps={{ textField: { size: 'small', fullWidth: true } }}
                      disablePast
                    />
                    <TimePicker
                      label="Proposed time"
                      value={proposedEmailTime}
                      onChange={(v) => setProposedEmailTime(v)}
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
                      id="av-email-subject"
                      label="Subject"
                      value={emailSubject}
                      onChange={e => setEmailSubject(e.target.value)}
                      fullWidth
                      size="small"
                    />
                    <TextField
                      id="av-email-body"
                      label="Email body"
                      value={emailBody}
                      onChange={e => setEmailBody(e.target.value)}
                      fullWidth
                      multiline
                      minRows={8}
                      size="small"
                    />
                  </>
                )}
                {actionError && (
                  actionError === 'GOOGLE_AUTH'
                    ? <GoogleAuthAlert />
                    : <Alert severity="error">{actionError}</Alert>
                )}
              </Stack>
        )}
      </FullScreenModal>

      <DiscardConfirmDialog
        open={confirmDiscardOpen}
        onKeepEditing={handleKeepEditing}
        onDiscard={handleDiscard}
      />
    </LocalizationProvider>
  );
}

function _findCalendarHandler(): CardActionHandlerData | null {
  try {
    const w = window as unknown as {
      cardActionHandlerFor?: (
        stageKey: string,
        leadStatusKey: string | undefined,
      ) => CardActionHandlerData | null;
    };
    if (typeof w.cardActionHandlerFor !== 'function') return null;
    return null;
  } catch {
    return null;
  }
}
