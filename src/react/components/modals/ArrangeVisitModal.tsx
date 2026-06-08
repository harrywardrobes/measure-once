import React, { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';
import { POST, ApiError, isGoogleAuthError } from '../../utils/api';
import { GoogleAuthAlert } from '../GoogleAuthAlert';
import { useToast } from '../../contexts/ToastContext';

interface Props {
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
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
  contactWhatsAppPhone: string;
  contactEmail: string;
  contactAddress: string;
}

interface DraftState {
  step: Step;
  address: string;
  bookedSlotIso: string | null;
  emailSubject: string;
  emailBody: string;
}

function draftKey(contactId: string): string {
  return `mo-arrange-visit-draft-${contactId}`;
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

export function ArrangeVisitModal({ handler, ctx, open, onClose }: Props) {
  const key = draftKey(ctx.contactId);
  const draft = loadDraft(key);

  const showToast = useToast();

  const [step, setStep] = useState<Step>('loading');
  const [contactInfo, setContactInfo] = useState<ContactInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');

  const [address, setAddress]       = useState(draft.address ?? '');
  const [bookedSlot, setBookedSlot] = useState<Dayjs | null>(
    draft.bookedSlotIso ? dayjs(draft.bookedSlotIso) : null,
  );

  const [emailSubject, setEmailSubject] = useState(draft.emailSubject ?? '');
  const [emailBody, setEmailBody]       = useState(draft.emailBody ?? '');

  // Pre-fetched no-answer template from the server (admin-editable). Populated
  // alongside the contact-info load so clicking "No answer" has no extra delay.
  const [noAnswerTemplate, setNoAnswerTemplate] = useState<{ subject: string; body_text: string } | null>(null);

  useEffect(() => {
    if (!open) return;

    setLoadError('');
    setActionError('');
    setNoAnswerTemplate(null);

    const hasDraft = draft.step && draft.step !== 'loading' && draft.step !== 'done';
    if (hasDraft) {
      setStep(draft.step as Step);
      if (draft.address) setAddress(draft.address);
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
        if (!hasDraft) {
          // Fresh open: initialise address and step from the API response.
          // Use functional update so a stale response from a rapid reopen
          // never clobbers a step that has already advanced past 'loading'.
          setAddress(d.contactAddress || '');
          setStep(prev => prev === 'loading' ? 'call' : prev);
          saveDraft(key, { step: 'call', address: d.contactAddress || '', bookedSlotIso: null, emailSubject: '', emailBody: '' });
        }

        // Pre-fetch the no-answer email template using the actual contact name
        // and visit type so it reflects any admin edits to the template.
        const firstName = (d.contactName || '').split(' ')[0] || 'there';
        const vLabel = visitLabel(d.visitType ?? 'design');
        POST('/api/email-templates/render', {
          key: 'arrange_visit_no_answer',
          vars: { firstName, visitLabel: vLabel },
        })
          .then((t: unknown) => setNoAnswerTemplate(t as { subject: string; body_text: string }))
          .catch(() => { /* silently ignore — buildNoAnswerEmail fallback used */ });
      })
      .catch((e: Error) => {
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
    if (step === 'loading' || step === 'done') return;
    saveDraft(key, {
      step,
      address,
      bookedSlotIso: bookedSlot?.toISOString() ?? null,
      emailSubject,
      emailBody,
    });
  }, [key, step, address, bookedSlot, emailSubject, emailBody]);

  function handleClose() {
    setActionError('');
    onClose();
  }

  async function handleOutcome(outcome: 'not_proceeding' | 'call_back_later') {
    if (outcome === 'call_back_later') {
      clearDraft(key);
      onClose();
      return;
    }
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
          outcome: 'not_proceeding',
          visitType: contactInfo?.visitType ?? 'design',
        },
      });
      if (!res.queued && !res.ok) throw new Error((res.data as { error?: string })?.error || 'Could not update status.');
      clearDraft(key);
      showToast(res.queued ? 'Saved offline — status will update when you reconnect' : 'Status updated to Not Suitable', false);
      setStep('done');
      onClose();
    } catch (e) {
      setActionError((e as Error).message || 'Could not update status.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleBooked() {
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
      const { sendOrQueue } = await import('../../lib/offlineQueue');
      const res = await sendOrQueue({
        area: 'visit',
        label: 'Visit booked',
        method: 'POST',
        url: '/api/card-actions/arrange-visit/outcome',
        body: {
          contactId: ctx.contactId,
          outcome: 'booked',
          visitType: contactInfo?.visitType ?? 'design',
          slot: bookedSlot.toISOString(),
          address: address.trim(),
        },
      });
      if (!res.queued && !res.ok) throw new Error((res.data as { error?: string })?.error || 'Could not update status.');
      clearDraft(key);
      showToast(res.queued ? 'Booking saved offline — it will sync when you reconnect' : 'Visit booked and status updated', false);

      if (!res.queued) {
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

  async function handleEmailSent() {
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
      await POST('/api/card-actions/arrange-visit/outcome', {
        contactId: ctx.contactId,
        outcome: 'email_sent',
        visitType,
      });
      clearDraft(key);
      showToast('Email sent and status updated', false);
      setStep('done');
      onClose();
    } catch (e) {
      if (isGoogleAuthError(e)) {
        setActionError('GOOGLE_AUTH');
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
  const whatsapp = contactInfo?.contactWhatsAppPhone || '';

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
        {step === 'loading' && (
          <>
            <DialogTitle>Arrange {label}</DialogTitle>
            <DialogContent>
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress size={36} />
              </Box>
              {loadError && (
                <Alert severity="error" sx={{ mt: 1 }}>{loadError}</Alert>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={handleClose}>Cancel</Button>
            </DialogActions>
          </>
        )}

        {step === 'call' && (
          <>
            <DialogTitle>Call {displayName}</DialogTitle>
            <DialogContent>
              <Stack spacing={2} sx={{ mt: 0.5 }}>
                {(landline || mobile || whatsapp) ? (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {landline && (
                      <Box>
                        <Typography variant="body2" color="text.secondary">Phone</Typography>
                        <Typography variant="h6" sx={{ fontWeight: 600 }}>{landline}</Typography>
                      </Box>
                    )}
                    {mobile && (
                      <Box>
                        <Typography variant="body2" color="text.secondary">Mobile</Typography>
                        <Typography variant="h6" sx={{ fontWeight: 600 }}>{mobile}</Typography>
                      </Box>
                    )}
                    {whatsapp && (
                      <Box>
                        <Typography variant="body2" color="text.secondary">WhatsApp</Typography>
                        <Typography variant="h6" sx={{ fontWeight: 600 }}>{whatsapp}</Typography>
                      </Box>
                    )}
                  </Box>
                ) : (
                  <Alert severity="warning">No phone number on record for this contact.</Alert>
                )}
                <Typography variant="body2">
                  Call {displayName} to book their {label}. What was the outcome?
                </Typography>
                <Divider />
                {actionError && (
                  <Alert severity="error">{actionError}</Alert>
                )}
              </Stack>
            </DialogContent>
            <DialogActions sx={{ flexWrap: 'wrap', gap: 1, justifyContent: 'flex-end', pb: 2, px: 2 }}>
              <Button
                disabled={submitting}
                onClick={() => { setActionError(''); setStep('booked'); }}
                variant="contained"
                color="success"
                data-testid="av-outcome-booked"
              >
                Booked
              </Button>
              <Button
                disabled={submitting}
                onClick={() => {
                  setActionError('');
                  if (!emailSubject && !emailBody) {
                    if (noAnswerTemplate) {
                      setEmailSubject(noAnswerTemplate.subject);
                      setEmailBody(noAnswerTemplate.body_text);
                    } else {
                      const name = contactInfo?.contactName || ctx.contactName || 'there';
                      const vLabel = visitLabel(contactInfo?.visitType ?? 'design');
                      const { subject, body } = buildNoAnswerEmail(name, vLabel);
                      setEmailSubject(subject);
                      setEmailBody(body);
                    }
                  }
                  setStep('email');
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
              <Button
                disabled={submitting}
                onClick={() => handleOutcome('not_proceeding')}
                color="error"
                variant="outlined"
                data-testid="av-outcome-not-proceeding"
              >
                {submitting ? <CircularProgress size={18} /> : 'Not proceeding'}
              </Button>
            </DialogActions>
          </>
        )}

        {step === 'booked' && (
          <>
            <DialogTitle>Book {label} for {displayName}</DialogTitle>
            <DialogContent>
              <Stack spacing={2} sx={{ mt: 0.5 }}>
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
                <TextField
                  id="av-booked-address"
                  label="Address"
                  value={address}
                  onChange={e => setAddress(e.target.value)}
                  slotProps={{ htmlInput: { maxLength: 300 } }}
                  placeholder="Customer address"
                  fullWidth
                  size="small"
                />
                {actionError && (
                  <Alert severity="error">{actionError}</Alert>
                )}
              </Stack>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => { setActionError(''); setStep('call'); }} disabled={submitting}>Back</Button>
              <Button
                variant="contained"
                onClick={handleBooked}
                disabled={submitting}
                data-testid="av-booked-confirm"
              >
                {submitting ? <CircularProgress size={18} color="inherit" /> : 'Confirm booking'}
              </Button>
            </DialogActions>
          </>
        )}

        {step === 'email' && (
          <>
            <DialogTitle>Ask {displayName} for availability</DialogTitle>
            <DialogContent>
              <Stack spacing={2} sx={{ mt: 0.5 }}>
                <Typography variant="body2" color="text.secondary">
                  We couldn't reach {displayName}. Review and edit the email below, then send it to ask for their availability.
                </Typography>
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
                {actionError && (
                  actionError === 'GOOGLE_AUTH'
                    ? <GoogleAuthAlert />
                    : <Alert severity="error">{actionError}</Alert>
                )}
              </Stack>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => { setActionError(''); setStep('call'); }} disabled={submitting}>Back</Button>
              <Button
                variant="contained"
                onClick={handleEmailSent}
                disabled={submitting}
                data-testid="av-email-send"
              >
                {submitting ? <CircularProgress size={18} color="inherit" /> : 'Send email'}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </LocalizationProvider>
  );
}

function _findCalendarHandler(): CardActionHandlerData | null {
  try {
    const w = window as unknown as {
      cardActionHandlerFor?: (
        stageKey: string,
        leadStatusKey: string | undefined,
        hwSubstatusValue: string | undefined,
      ) => CardActionHandlerData | null;
    };
    if (typeof w.cardActionHandlerFor !== 'function') return null;
    return null;
  } catch {
    return null;
  }
}
