import React, { useEffect, useRef, useState } from 'react';
import { DEPOSIT_INVOICE_DRAFT_PREFIX } from '../../constants/localStorageKeys';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import CallIcon from '@mui/icons-material/Call';
import EditIcon from '@mui/icons-material/Edit';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import SendIcon from '@mui/icons-material/Send';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import { POST, isGoogleAuthError } from '../../utils/api';
import { STAFF_EMAIL_TEMPLATE_KEY } from '../../utils/handlerMeta';
import { GoogleAuthAlert } from '../GoogleAuthAlert';
import { PaymentHistory } from '../PaymentHistory';
import { dispatchCardActionHandler } from '../../utils/dispatchCardActionHandler';
import { broadcastLeadStatusChange } from '../../utils/broadcastLeadStatus';
import { leadStatusConfirmationMessage } from '../../utils/leadStatusConfirmation';
import { useToast } from '../../contexts/ToastContext';
import { ModalContactHeader } from './ModalContactHeader';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';

interface Props {
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
}


type Step =
  | 'loading'
  | 'hub'
  | 'resend'
  | 'resend_submitting'
  | 'reminder'
  | 'reminder_submitting'
  | 'not_proceeding_confirm'
  | 'not_proceeding_submitting'
  | 'not_proceeding_email'
  | 'done';

interface LoaderData {
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  contactMobile: string;
  contactAddress: string;
  qbConnected: boolean;
  invoiceId: string | null;
  invoiceDocNum: string | null;
  invoiceTotalAmt: number;
  invoiceBalance: number;
  invoiceTxnDate: string | null;
  invoiceLink: string | null;
  qbEstimateId: string | null;
}

interface DraftState {
  step: Step;
  recipientEmail: string;
  reminderSubject: string;
  reminderBody: string;
  voidInvoice: boolean;
  notProceedingConfirmed: boolean;
  declineEmailSubject: string;
  declineEmailBody: string;
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
}

function draftKey(contactId: string): string {
  return DEPOSIT_INVOICE_DRAFT_PREFIX + contactId;
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
  } catch {}
}

function clearDraft(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {}
}

export function DepositInvoiceModal({ handler, ctx, open, onClose }: Props) {
  const { contactId, contactName: ctxContactName } = ctx;
  const key = draftKey(contactId);
  const showToast = useToast();

  const [step, setStep] = useState<Step>('loading');
  const [loaderData, setLoaderData] = useState<LoaderData | null>(null);
  const [loadError, setLoadError] = useState('');

  const [recipientEmail, setRecipientEmail] = useState('');
  const [resendError, setResendError] = useState('');

  const [reminderSubject, setReminderSubject] = useState('');
  const [reminderBody, setReminderBody] = useState('');
  const [reminderLoading, setReminderLoading] = useState(false);
  const [reminderError, setReminderError] = useState('');

  const [voidInvoice, setVoidInvoice] = useState(false);
  const [notProceedingConfirmed, setNotProceedingConfirmed] = useState(false);
  const [notProceedingError, setNotProceedingError] = useState('');

  const [declineEmailSubject, setDeclineEmailSubject] = useState('');
  const [declineEmailBody, setDeclineEmailBody] = useState('');
  const [declineEmailLoading, setDeclineEmailLoading] = useState(false);
  const [declineEmailFetchError, setDeclineEmailFetchError] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [doneMessage, setDoneMessage] = useState('');

  // Paid state is provided by the PaymentHistory banner via onPaidStateChange.
  // This avoids a second QB fetch — the banner fetches once and surfaces the result.
  const [isPaid, setIsPaid] = useState<boolean | null>(null);

  // Staff can explicitly acknowledge the paid warning and send anyway.
  const [sendAnywayOverride, setSendAnywayOverride] = useState(false);

  const hasMounted = useRef(false);

  useEffect(() => {
    if (step !== 'done') return;
    const t = setTimeout(() => handleClose(), 3000);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function saveDraftMerge(updates: Partial<DraftState>) {
    try {
      const existing: DraftState = JSON.parse(sessionStorage.getItem(key) || '{}') as DraftState;
      sessionStorage.setItem(key, JSON.stringify({ ...existing, ...updates }));
    } catch {}
  }

  function navigateTo(s: Step) {
    setStep(s);
    saveDraftMerge({ step: s });
    if (s !== 'resend' && s !== 'reminder') setSendAnywayOverride(false);
  }

  function handleClose() {
    clearDraft(key);
    onClose();
  }

  useEffect(() => {
    if (!open) return;
    hasMounted.current = true;
    setLoadError('');
    setResendError('');
    setReminderError('');
    setNotProceedingError('');

    const draft = loadDraft(key);

    let cancelled = false;
    POST<LoaderData>('/api/card-actions/deposit-invoice', { contactId })
      .then(data => {
        if (cancelled) return;
        setLoaderData(data);
        setRecipientEmail(draft.recipientEmail || data.contactEmail || '');
        if (draft.reminderSubject) setReminderSubject(draft.reminderSubject);
        if (draft.reminderBody) setReminderBody(draft.reminderBody);
        if (draft.voidInvoice !== undefined) setVoidInvoice(draft.voidInvoice);
        if (draft.notProceedingConfirmed !== undefined) setNotProceedingConfirmed(draft.notProceedingConfirmed);
        if (draft.declineEmailSubject) setDeclineEmailSubject(draft.declineEmailSubject);
        if (draft.declineEmailBody) setDeclineEmailBody(draft.declineEmailBody);

        if (draft.step && draft.step !== 'loading' && draft.step !== 'resend_submitting'
            && draft.step !== 'reminder_submitting' && draft.step !== 'not_proceeding_submitting') {
          setStep(draft.step);
        } else {
          setStep('hub');
        }
      })
      .catch(err => {
        if (cancelled) return;
        setLoadError(String(err?.message || 'Could not load contact data.'));
        setStep('hub');
      });

    return () => { cancelled = true; };
  }, [open, contactId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!hasMounted.current) return;
    saveDraftMerge({ step, recipientEmail, reminderSubject, reminderBody, voidInvoice, notProceedingConfirmed, declineEmailSubject, declineEmailBody });
  }, [step, recipientEmail, reminderSubject, reminderBody, voidInvoice, notProceedingConfirmed, declineEmailSubject, declineEmailBody]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (step !== 'not_proceeding_email') return;
    if (declineEmailSubject || declineEmailBody) return;
    let cancelled = false;
    const firstName = loaderData?.contactName?.split(' ')[0] || '';
    setDeclineEmailLoading(true);
    setDeclineEmailFetchError(false);
    POST<{ subject: string; body_text: string }>('/api/email-templates/render', {
      key: STAFF_EMAIL_TEMPLATE_KEY.open_deal_declined_thank_you,
      vars: { firstName },
    })
      .then(data => {
        if (cancelled) return;
        setDeclineEmailSubject(data.subject);
        setDeclineEmailBody(data.body_text);
        setDeclineEmailLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setDeclineEmailFetchError(true);
        setDeclineEmailLoading(false);
      });
    return () => { cancelled = true; };
  }, [step, loaderData]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (step !== 'reminder') return;
    if (reminderSubject || reminderBody) return;
    fetchReminderTemplate();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  function fetchReminderTemplate() {
    setReminderLoading(true);
    const firstName   = loaderData?.contactName?.split(' ')[0] || '';
    const docNum      = loaderData?.invoiceDocNum ? ` #${loaderData.invoiceDocNum}` : '';
    const totalAmt    = loaderData?.invoiceTotalAmt ?? 0;
    const balance     = loaderData?.invoiceBalance  ?? 0;
    const invoiceLink = loaderData?.invoiceLink     || '';
    POST<{ subject: string; body_text: string }>('/api/email-templates/render', {
      key: STAFF_EMAIL_TEMPLATE_KEY.deposit_invoice_payment_reminder,
      vars: {
        firstName,
        invoiceDocNum: docNum,
        depositAmount: formatCurrency(totalAmt),
        balanceAmount: formatCurrency(balance),
        invoiceLink,
      },
    })
      .then(data => {
        setReminderSubject(data.subject);
        setReminderBody(data.body_text);
      })
      .catch(() => {})
      .finally(() => setReminderLoading(false));
  }

  async function handleResend() {
    if (!loaderData?.invoiceId) return;
    setSubmitting(true);
    setResendError('');
    try {
      await POST('/api/card-actions/deposit-invoice/resend', {
        contactId,
        invoiceId: loaderData.invoiceId,
        recipientEmail: recipientEmail.trim(),
      });
      clearDraft(key);
      setDoneMessage('Deposit invoice re-sent successfully.');
      navigateTo('done');
    } catch (err) {
      setResendError((err as Error).message || 'Could not re-send invoice.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSendReminder() {
    if (!reminderBody.trim()) {
      setReminderError('Email body cannot be empty.');
      return;
    }
    setSubmitting(true);
    setReminderError('');
    navigateTo('reminder_submitting');
    try {
      await POST('/api/emails/send', {
        to: loaderData?.contactEmail || ctx.contactEmail,
        subject: reminderSubject,
        body: reminderBody,
      });
      clearDraft(key);
      setDoneMessage('Payment reminder sent.');
      setStep('done');
    } catch (err) {
      if (isGoogleAuthError(err)) {
        setReminderError('GOOGLE_AUTH');
      } else {
        setReminderError((err as Error).message || 'Could not send reminder.');
      }
      navigateTo('reminder');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleNotProceeding(shouldSendThankYou: boolean) {
    navigateTo('not_proceeding_submitting');
    try {
      const result = await POST<{ ok: boolean; hs_lead_status: string; setsLeadStatus?: string | null }>(
        '/api/card-actions/deposit-invoice/not-proceeding',
        {
          contactId,
          voidInvoice: voidInvoice && !!loaderData?.invoiceId,
          invoiceId: loaderData?.invoiceId ?? null,
          contactEmail: loaderData?.contactEmail || '',
          contactName: loaderData?.contactName || ctxContactName || '',
          sendThankYou: shouldSendThankYou,
          emailSubject: shouldSendThankYou ? declineEmailSubject : undefined,
          emailBody:    shouldSendThankYou ? declineEmailBody    : undefined,
        }
      );
      broadcastLeadStatusChange(contactId, { hs_lead_status: result.hs_lead_status });
      clearDraft(key);
      showToast(leadStatusConfirmationMessage(result.setsLeadStatus) || 'Marked as not proceeding', false);
      handleClose();
    } catch (err) {
      setNotProceedingError((err as Error).message || 'Something went wrong.');
      navigateTo('not_proceeding_confirm');
    }
  }

  function openArrangeSurvey() {
    dispatchCardActionHandler({ id: handler.id, type: 'arrange_visit', config: {} }, ctx);
  }

  function openLogCall() {
    dispatchCardActionHandler({ id: handler.id, type: 'contact_customer', config: {} }, ctx);
  }

  function openUploadPhotos() {
    dispatchCardActionHandler({ id: handler.id, type: 'upload_photos_and_info', config: {} }, ctx);
  }

  function openDesignVisit() {
    dispatchCardActionHandler({ id: handler.id, type: 'start_design_visit', config: {} }, ctx);
  }

  function getTitle(): string {
    switch (step) {
      case 'resend':                  return 'Re-send deposit invoice';
      case 'resend_submitting':       return 'Sending…';
      case 'reminder':                return 'Send payment reminder';
      case 'reminder_submitting':     return 'Sending…';
      case 'not_proceeding_confirm':  return 'Not proceeding — Step 1 of 2';
      case 'not_proceeding_submitting': return 'Updating…';
      case 'not_proceeding_email':    return 'Not proceeding — Step 2 of 2';
      case 'done':                    return 'Done';
      default:                        return 'Deposit invoice follow-up';
    }
  }

  const displayName = loaderData?.contactName || ctxContactName || '';
  const isLoading   = step === 'loading';
  const isSubmittingStep = step === 'resend_submitting' || step === 'reminder_submitting' || step === 'not_proceeding_submitting';

  function renderContactHeader(opts?: { loading?: boolean }) {
    return (
      <ModalContactHeader
        name={displayName}
        phone={loaderData?.contactPhone}
        mobile={loaderData?.contactMobile}
        email={loaderData?.contactEmail}
        address={loaderData?.contactAddress}
        loading={opts?.loading || isLoading || (step !== 'hub' && !loaderData)}
      />
    );
  }

  function renderHub() {
    const qbOk       = loaderData?.qbConnected ?? false;
    const hasInvoice = !!(loaderData?.invoiceId);

    return (
      <Stack spacing={2}>
        {renderContactHeader()}
        {loadError && <Alert severity="warning">{loadError}</Alert>}
        <PaymentHistory
          variant="banner"
          contactId={contactId}
          invoiceId={loaderData?.invoiceId ?? null}
          onPaidStateChange={setIsPaid}
        />
        <Stack spacing={1.5}>
          <Button
            variant={isPaid ? 'contained' : 'outlined'}
            color={isPaid ? 'success' : 'inherit'}
            fullWidth
            sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1.5 }}
            startIcon={<CalendarMonthIcon />}
            onClick={openArrangeSurvey}
          >
            <Box>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>Arrange survey</Typography>
              <Typography variant="caption" color={isPaid ? 'inherit' : 'text.secondary'} sx={{ opacity: 0.85 }}>
                Call → booked / no-answer / call-back
              </Typography>
            </Box>
          </Button>

          <Button
            variant={(!isPaid && qbOk && hasInvoice) ? 'contained' : 'outlined'}
            color={(!isPaid && qbOk && hasInvoice) ? 'primary' : 'inherit'}
            fullWidth
            disabled={!qbOk || !hasInvoice}
            sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1.5 }}
            startIcon={<SendIcon />}
            onClick={() => {
              setRecipientEmail(loaderData?.contactEmail || '');
              navigateTo('resend');
            }}
          >
            <Box>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>Re-send deposit invoice</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ opacity: 0.85 }}>
                {!qbOk ? 'Requires QuickBooks connection' : !hasInvoice ? 'No invoice found' : 'Resend via QuickBooks email'}
              </Typography>
            </Box>
          </Button>

          <Button
            variant={(!isPaid && qbOk && hasInvoice) ? 'contained' : 'outlined'}
            color={(!isPaid && qbOk && hasInvoice) ? 'primary' : 'inherit'}
            fullWidth
            disabled={!qbOk || !hasInvoice}
            sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1.5 }}
            startIcon={<NotificationsActiveIcon />}
            onClick={() => {
              setReminderSubject('');
              setReminderBody('');
              navigateTo('reminder');
            }}
          >
            <Box>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>Send payment reminder</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ opacity: 0.85 }}>
                {!qbOk ? 'Requires QuickBooks connection' : !hasInvoice ? 'No invoice found' : 'Send a chaser email via Gmail'}
              </Typography>
            </Box>
          </Button>

          <Divider />

          <Button
            variant="outlined"
            color="error"
            fullWidth
            sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1.5 }}
            startIcon={<ThumbDownIcon />}
            onClick={() => navigateTo('not_proceeding_confirm')}
          >
            <Box>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>Not proceeding</Typography>
              <Typography variant="caption" color="text.secondary">
                Void invoice, decline estimates → DECLINED_DEAL
              </Typography>
            </Box>
          </Button>

          <Button
            variant="outlined"
            fullWidth
            sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1.5 }}
            startIcon={<CallIcon />}
            onClick={openLogCall}
          >
            <Box>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>Log a call</Typography>
              <Typography variant="caption" color="text.secondary">
                Record a contact attempt
              </Typography>
            </Box>
          </Button>

          <Button
            variant="outlined"
            fullWidth
            sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1.5 }}
            startIcon={<EditIcon />}
            onClick={() => {
              navigateTo('hub');
              handleClose();
            }}
          >
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>Amend the deal</Typography>
              <Stack sx={{ flexDirection: 'row', gap: 1, mt: 0.25 }}>
                <Chip
                  label="Upload photos"
                  size="small"
                  icon={<PhotoCameraIcon />}
                  variant="outlined"
                  onClick={e => { e.stopPropagation(); openUploadPhotos(); }}
                  sx={{ cursor: 'pointer' }}
                />
                <Chip
                  label="Amend design visit"
                  size="small"
                  icon={<AutoFixHighIcon />}
                  variant="outlined"
                  onClick={e => { e.stopPropagation(); openDesignVisit(); }}
                  sx={{ cursor: 'pointer' }}
                />
              </Stack>
            </Box>
          </Button>
        </Stack>
      </Stack>
    );
  }

  function renderResend() {
    const { invoiceDocNum } = loaderData ?? {};
    return (
      <Stack spacing={2}>
        {renderContactHeader()}
        {isPaid && (
          <Alert
            severity="warning"
            action={
              !sendAnywayOverride ? (
                <Button color="inherit" size="small" onClick={() => setSendAnywayOverride(true)}>
                  Send anyway
                </Button>
              ) : undefined
            }
          >
            {sendAnywayOverride
              ? 'Paid-invoice warning acknowledged — you can now re-send.'
              : 'This invoice appears to have been paid — double-check before sending.'}
          </Alert>
        )}
        {resendError && (
          <Alert severity="error" onClose={() => setResendError('')}>{resendError}</Alert>
        )}
        <Typography variant="body2" color="text.secondary">
          Re-send{invoiceDocNum ? ` invoice #${invoiceDocNum}` : ' the deposit invoice'} via QuickBooks email.
          CC/BCC from admin QuickBooks settings will be applied automatically.
        </Typography>
        <TextField
          label="Recipient email"
          value={recipientEmail}
          onChange={e => setRecipientEmail(e.target.value)}
          fullWidth
          size="small"
          type="email"
          helperText="Pre-filled from contact data — edit if needed."
        />
      </Stack>
    );
  }

  function renderReminder() {
    return (
      <Stack spacing={2}>
        {renderContactHeader()}
        {isPaid && (
          <Alert
            severity="warning"
            action={
              !sendAnywayOverride ? (
                <Button color="inherit" size="small" onClick={() => setSendAnywayOverride(true)}>
                  Send anyway
                </Button>
              ) : undefined
            }
          >
            {sendAnywayOverride
              ? 'Paid-invoice warning acknowledged — you can now send the reminder.'
              : 'This invoice appears to have been paid — double-check before sending.'}
          </Alert>
        )}
        {reminderError && reminderError !== 'GOOGLE_AUTH' && (
          <Alert severity="error" onClose={() => setReminderError('')}>{reminderError}</Alert>
        )}
        {reminderError === 'GOOGLE_AUTH' && (
          <GoogleAuthAlert />
        )}
        {reminderLoading ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CircularProgress size={16} />
            <Typography variant="body2" color="text.secondary">Loading template…</Typography>
          </Box>
        ) : (
          <>
            <TextField
              label="Subject"
              value={reminderSubject}
              onChange={e => setReminderSubject(e.target.value)}
              fullWidth
              size="small"
            />
            <TextField
              label="Body"
              value={reminderBody}
              onChange={e => setReminderBody(e.target.value)}
              fullWidth
              multiline
              minRows={6}
              size="small"
            />
          </>
        )}
        <Typography variant="caption" color="text.secondary">
          Sending to: <strong>{loaderData?.contactEmail || ctx.contactEmail}</strong>
        </Typography>
      </Stack>
    );
  }

  function renderNotProceedingConfirm() {
    const qbOk      = loaderData?.qbConnected ?? false;
    const hasInvoice = !!(loaderData?.invoiceId);
    const unpaid    = isPaid !== true;

    return (
      <Stack spacing={2}>
        {renderContactHeader()}
        {notProceedingError && (
          <Alert severity="error" onClose={() => setNotProceedingError('')}>{notProceedingError}</Alert>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ pt: 0.5 }}>
          This will mark this deal as <strong>DECLINED_DEAL</strong> and reject any pending estimates in QuickBooks.
        </Typography>
        {qbOk && hasInvoice && unpaid && (
          <FormControlLabel
            control={
              <Checkbox
                checked={voidInvoice}
                onChange={(_e, c) => setVoidInvoice(c)}
                size="small"
              />
            }
            label={
              <Typography variant="body2">
                Also void the unpaid deposit invoice{loaderData?.invoiceDocNum ? ` (#${loaderData.invoiceDocNum})` : ''} in QuickBooks
              </Typography>
            }
          />
        )}
        {!qbOk && (
          <Alert severity="info" sx={{ py: 0.25 }}>
            QuickBooks is not connected — estimates and invoice will not be updated in QB.
          </Alert>
        )}
        <FormControlLabel
          control={
            <Checkbox
              checked={notProceedingConfirmed}
              onChange={(_e, c) => setNotProceedingConfirmed(c)}
              size="small"
            />
          }
          label={
            <Typography variant="body2">I confirm I want to mark this deal as not proceeding.</Typography>
          }
        />
      </Stack>
    );
  }

  function renderNotProceedingEmail() {
    return (
      <Stack spacing={2}>
        {renderContactHeader()}
        <Typography variant="body2" color="text.secondary" sx={{ pt: 0.5 }}>
          Would you like to send the customer a brief thank-you email? Edit the message below or skip.
        </Typography>
        {declineEmailLoading ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CircularProgress size={16} />
            <Typography variant="body2" color="text.secondary">Loading template…</Typography>
          </Box>
        ) : (
          <>
            {declineEmailFetchError && (
              <Alert severity="warning" sx={{ py: 0.25 }}>
                Could not load template — enter the email text manually.
              </Alert>
            )}
            <TextField
              label="Subject"
              value={declineEmailSubject}
              onChange={e => setDeclineEmailSubject(e.target.value)}
              fullWidth
              size="small"
              slotProps={{ htmlInput: { maxLength: 300 } }}
            />
            <TextField
              label="Body"
              value={declineEmailBody}
              onChange={e => setDeclineEmailBody(e.target.value)}
              fullWidth
              multiline
              minRows={6}
              size="small"
              slotProps={{ htmlInput: { maxLength: 8000 } }}
            />
          </>
        )}
        <Alert severity="info" sx={{ py: 0.25 }}>
          Sending to: <strong>{loaderData?.contactEmail || '(no email on record)'}</strong>
        </Alert>
      </Stack>
    );
  }

  function renderDone() {
    return (
      <Stack spacing={2} sx={{ alignItems: 'center', py: 1 }}>
        <CheckCircleIcon sx={{ fontSize: 48, color: 'success.main' }} />
        <Typography variant="h6" sx={{ fontWeight: 700 }}>Done</Typography>
        {doneMessage && (
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
            {doneMessage}
          </Typography>
        )}
      </Stack>
    );
  }

  function renderContent() {
    if (step === 'loading' || isSubmittingStep) {
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 140 }}>
          <CircularProgress size={36} />
        </Box>
      );
    }
    switch (step) {
      case 'hub':                     return renderHub();
      case 'resend':                  return renderResend();
      case 'reminder':                return renderReminder();
      case 'not_proceeding_confirm':  return renderNotProceedingConfirm();
      case 'not_proceeding_email':    return renderNotProceedingEmail();
      case 'done':                    return renderDone();
      default:                        return null;
    }
  }

  function renderActions() {
    if (step === 'loading' || isSubmittingStep) return null;

    if (step === 'hub') {
      return <Button onClick={handleClose}>Close</Button>;
    }

    if (step === 'resend') {
      return (
        <>
          <Button onClick={() => navigateTo('hub')} startIcon={<ArrowBackIcon />}>Back</Button>
          <Box sx={{ flex: 1 }} />
          <Button
            variant="contained"
            disabled={submitting || !loaderData?.invoiceId || (!!isPaid && !sendAnywayOverride)}
            onClick={handleResend}
          >
            Re-send Invoice
          </Button>
        </>
      );
    }

    if (step === 'reminder') {
      return (
        <>
          <Button onClick={() => navigateTo('hub')} startIcon={<ArrowBackIcon />}>Back</Button>
          <Box sx={{ flex: 1 }} />
          <Button
            variant="contained"
            disabled={submitting || reminderLoading || !reminderBody.trim() || (!!isPaid && !sendAnywayOverride)}
            onClick={handleSendReminder}
          >
            Send Reminder
          </Button>
        </>
      );
    }

    if (step === 'not_proceeding_confirm') {
      return (
        <>
          <Button onClick={() => navigateTo('hub')} startIcon={<ArrowBackIcon />}>Back</Button>
          <Box sx={{ flex: 1 }} />
          <Button
            variant="contained"
            color="error"
            disabled={!notProceedingConfirmed}
            onClick={() => navigateTo('not_proceeding_email')}
          >
            Continue
          </Button>
        </>
      );
    }

    if (step === 'not_proceeding_email') {
      return (
        <>
          <Button onClick={() => navigateTo('not_proceeding_confirm')} startIcon={<ArrowBackIcon />}>Back</Button>
          <Box sx={{ flex: 1 }} />
          <Button onClick={() => handleNotProceeding(false)} sx={{ mr: 1 }}>Skip</Button>
          <Button
            variant="contained"
            disabled={!loaderData?.contactEmail || declineEmailLoading || !declineEmailBody.trim()}
            onClick={() => handleNotProceeding(true)}
          >
            Send &amp; Close
          </Button>
        </>
      );
    }

    if (step === 'done') {
      return <Button variant="contained" onClick={handleClose}>Close</Button>;
    }

    return null;
  }

  const showBackInTitle = ['resend', 'reminder', 'not_proceeding_confirm', 'not_proceeding_email'].includes(step);
  const actions = renderActions();

  return (
    <Dialog open={open} onClose={isSubmittingStep ? undefined : handleClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 1 }}>
        {showBackInTitle && (
          <IconButton size="small" onClick={() => {
            if (step === 'resend')                  navigateTo('hub');
            else if (step === 'reminder')           navigateTo('hub');
            else if (step === 'not_proceeding_confirm') navigateTo('hub');
            else if (step === 'not_proceeding_email')   navigateTo('not_proceeding_confirm');
          }} sx={{ mr: 0.5 }}>
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        )}
        {getTitle()}
      </DialogTitle>
      <DialogContent dividers>
        {renderContent()}
      </DialogContent>
      {actions && (
        <DialogActions sx={{ display: 'flex', px: 2, py: 1.5 }}>
          {actions}
        </DialogActions>
      )}
    </Dialog>
  );
}
