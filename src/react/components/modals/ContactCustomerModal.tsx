import React, { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { ApiError, POST, LEAD_STATUS_REMOVED_MESSAGE } from '../../utils/api';
import { relativeTime } from '../../utils/formatters';
import { buildActivityTooltipContent, type LastAttempt } from '../../utils/activityTooltip';
import { dispatchCardActionHandler } from '../../utils/dispatchCardActionHandler';
import { CONTACT_CUSTOMER_KEY } from '../../utils/handlerMeta';
import { leadStatusConfirmationMessage } from '../../utils/leadStatusConfirmation';
import { useAuth } from '../../contexts/AuthContext';
import { ModalContactHeader } from './ModalContactHeader';
import { DemoActionTooltip } from './demoMode';
import { FullScreenModal } from './FullScreenModal';
import { DEMO_CONTACT } from './demoData';
import { broadcastContactAttemptLogged } from '../../utils/broadcastContactAttempt';

interface Props {
  contactId: string;
  contactName: string;
  contactEmail: string;
  onClose: () => void;
  demo?: boolean;
}

type Phase =
  | 'loading'
  | 'contact'
  | 'no_response_confirm'
  | 'advancing'
  | 'done';

type Method = 'call' | 'email' | 'whatsapp';

interface AttemptLogEntry {
  method: Method;
  attemptedAt: string;
  attemptedBy: string | null;
  note: string | null;
}

interface HistoryNoteEntry {
  method: Method;
  note: string;
  attemptedAt: string;
}

interface HistorySessionEntry {
  attemptedAt: string;
  attemptedBy: string | null;
  callAttempted: boolean;
  emailSent: boolean;
  whatsappSent: boolean;
  notes: HistoryNoteEntry[];
}

interface ContactData {
  contactName: string;
  contactEmail: string;
  phone: string;
  mobile: string;
  leadStatus: string | null;
  callAttempted: boolean;
  emailSent: boolean;
  whatsappSent: boolean;
  lastAttemptAt: string | null;
  lastAttemptBy: string | null;
  attemptLog: AttemptLogEntry[];
  historySessionCount: number;
  historyTotalAttempts: number;
  historyEverCalled: boolean;
  historyEverEmailed: boolean;
  historyEverWhatsapped: boolean;
  historyAttemptLog: HistorySessionEntry[];
}

/** Body text colour for the email preview iframe (kept out of React style props). */
const IFRAME_BODY_COLOR = '#111';

/**
 * Convert plain-text email body to HTML the way the server does:
 * each non-blank line becomes a <p> element, HTML-escaped.
 * Matches the send-path logic in server.js.
 */
function bodyTextToHtml(text: string): string {
  return text
    .split('\n')
    .map(l => {
      if (l.trim() === '') return '';
      return `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</p>`;
    })
    .join('');
}

const METHOD_LABEL: Record<Method, string> = {
  call:     'Called',
  email:    'Emailed',
  whatsapp: 'WhatsApp',
};

const METHOD_BUTTON_LABEL: Record<Method, string> = {
  call:     'Log Call',
  email:    'Send Email',
  whatsapp: 'Log WhatsApp',
};

const METHODS: Method[] = ['call', 'email', 'whatsapp'];

const DEMO_CONTACT_DATA: ContactData = {
  contactName: DEMO_CONTACT.name,
  contactEmail: DEMO_CONTACT.email,
  phone: DEMO_CONTACT.phone,
  mobile: DEMO_CONTACT.mobile,
  leadStatus: null,
  callAttempted: false,
  emailSent: false,
  whatsappSent: false,
  lastAttemptAt: null,
  lastAttemptBy: null,
  attemptLog: [],
  historySessionCount: 0,
  historyTotalAttempts: 0,
  historyEverCalled: false,
  historyEverEmailed: false,
  historyEverWhatsapped: false,
  historyAttemptLog: [],
};

export function ContactCustomerModal({ contactId, contactName, contactEmail, onClose, demo }: Props) {
  const { user: currentUser } = useAuth();

  const [phase, setPhase] = useState<Phase>(demo ? 'contact' : 'loading');
  const [contactData, setContactData] = useState<ContactData | null>(demo ? DEMO_CONTACT_DATA : null);
  const [loadError, setLoadError] = useState('');
  const [advanceError, setAdvanceError] = useState('');
  const [confirmMessage, setConfirmMessage] = useState('');

  const [callAttempted, setCallAttempted] = useState(false);
  const [emailSent, setEmailSent]         = useState(false);
  const [whatsappSent, setWhatsappSent]   = useState(false);

  const [attemptLog, setAttemptLog] = useState<AttemptLogEntry[]>([]);

  const [lastAttemptAt, setLastAttemptAt] = useState<string | null>(null);
  const [lastAttemptBy, setLastAttemptBy] = useState<string | null>(null);

  const [historySessionCount,   setHistorySessionCount]   = useState(0);
  const [historyTotalAttempts,  setHistoryTotalAttempts]  = useState(0);
  const [historyEverCalled,     setHistoryEverCalled]     = useState(false);
  const [historyEverEmailed,    setHistoryEverEmailed]    = useState(false);
  const [historyEverWhatsapped, setHistoryEverWhatsapped] = useState(false);
  const [historyAttemptLog,     setHistoryAttemptLog]     = useState<HistorySessionEntry[]>([]);
  const [showHiddenSessions,    setShowHiddenSessions]    = useState(false);

  // Note panel state — one panel open at a time
  const [openPanel,          setOpenPanel]          = useState<Method | null>(null);
  const [noteText,           setNoteText]           = useState('');
  const [submitting,         setSubmitting]         = useState(false);
  const [submitError,        setSubmitError]        = useState('');
  const [submitErrorRetry,   setSubmitErrorRetry]   = useState(false);

  // Email flow state
  const [emailFlow,           setEmailFlow]           = useState<'idle' | 'preview' | 'sending'>('idle');
  const [emailSubject,        setEmailSubject]        = useState('');
  const [emailBody,           setEmailBody]           = useState('');
  const [emailViewMode,       setEmailViewMode]       = useState<'edit' | 'preview'>('edit');
  const [emailPreviewLoading, setEmailPreviewLoading] = useState(false);
  const [emailPreviewError,   setEmailPreviewError]   = useState('');
  const [emailPreviewHtml,    setEmailPreviewHtml]    = useState('');
  const [emailFetchedBody,    setEmailFetchedBody]    = useState('');
  const [emailFetchedSubject, setEmailFetchedSubject] = useState('');
  const [emailSubmitError,    setEmailSubmitError]    = useState('');
  const [emailSubmitRetry,    setEmailSubmitRetry]    = useState(false);
  const [emailSentConfirm,    setEmailSentConfirm]    = useState('');
  const [logConfirm,          setLogConfirm]          = useState('');

  const autoCloseTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emailConfirmTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logConfirmTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (demo) {
      setContactData(DEMO_CONTACT_DATA);
      setPhase('contact');
      return;
    }
    setPhase('loading');
    setLoadError('');
    setAdvanceError('');

    POST('/api/card-actions/contact-customer', { contactId })
      .then((data: unknown) => {
        const d = data as ContactData;
        setContactData(d);
        setCallAttempted(d.callAttempted);
        setEmailSent(d.emailSent);
        setWhatsappSent(d.whatsappSent);
        setLastAttemptAt(d.lastAttemptAt);
        setLastAttemptBy(d.lastAttemptBy);
        setAttemptLog(d.attemptLog || []);
        setHistorySessionCount(d.historySessionCount   ?? 0);
        setHistoryTotalAttempts(d.historyTotalAttempts ?? 0);
        setHistoryEverCalled(d.historyEverCalled       ?? false);
        setHistoryEverEmailed(d.historyEverEmailed     ?? false);
        setHistoryEverWhatsapped(d.historyEverWhatsapped ?? false);
        setHistoryAttemptLog(d.historyAttemptLog       ?? []);
        setPhase('contact');
      })
      .catch((e: Error) => {
        setLoadError(e.message || 'Could not load contact info.');
        setPhase('contact');
      });

    return () => {
      if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current);
      if (emailConfirmTimerRef.current) clearTimeout(emailConfirmTimerRef.current);
      if (logConfirmTimerRef.current) clearTimeout(logConfirmTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  const anyTicked = callAttempted || emailSent || whatsappSent;

  function openNotePanel(method: Method) {
    closeEmailFlow();
    setOpenPanel(method);
    setNoteText('');
    setSubmitError('');
    setSubmitErrorRetry(false);
  }

  function closeNotePanel() {
    setOpenPanel(null);
    setNoteText('');
    setSubmitError('');
    setSubmitErrorRetry(false);
  }

  function closeEmailFlow() {
    setEmailFlow('idle');
    setEmailSubject('');
    setEmailBody('');
    setEmailViewMode('edit');
    setEmailPreviewError('');
    setEmailPreviewHtml('');
    setEmailFetchedBody('');
    setEmailFetchedSubject('');
    setEmailSubmitError('');
    setEmailSubmitRetry(false);
    setEmailPreviewLoading(false);
  }

  async function openEmailPreview() {
    closeNotePanel();
    setEmailFlow('preview');
    setEmailPreviewError('');
    setEmailSubmitError('');
    setEmailSubmitRetry(false);
    setEmailSentConfirm('');
    if (emailConfirmTimerRef.current) {
      clearTimeout(emailConfirmTimerRef.current);
      emailConfirmTimerRef.current = null;
    }

    if (demo) {
      setEmailSubject('Getting in touch');
      setEmailBody(
        "Hi there,\n\nI hope you're doing well. I wanted to reach out and follow up on your enquiry with us.\n\nPlease don't hesitate to get in touch if you have any questions — we're happy to help.\n\nKind regards,\nThe team",
      );
      return;
    }

    setEmailPreviewLoading(true);
    try {
      const result = await POST(
        `/api/card-actions/contact-customer/${encodeURIComponent(contactId)}/email-preview`,
        {},
      ) as { subject: string; text: string; html: string };
      setEmailSubject(result.subject || '');
      setEmailBody(result.text || '');
      setEmailPreviewHtml(result.html || '');
      setEmailFetchedBody(result.text || '');
      setEmailFetchedSubject(result.subject || '');
    } catch (e) {
      const err = e as ApiError;
      setEmailPreviewError(err.message || 'Could not load email preview.');
    } finally {
      setEmailPreviewLoading(false);
    }
  }


  async function refetchEmailHtml(subject: string, body: string) {
    if (demo) return;
    setEmailPreviewLoading(true);
    setEmailPreviewError('');
    try {
      const result = await POST(
        `/api/card-actions/contact-customer/${encodeURIComponent(contactId)}/email-preview`,
        { subject, body },
      ) as { subject: string; text: string; html: string };
      setEmailPreviewHtml(result.html || '');
      setEmailFetchedBody(body);
      setEmailFetchedSubject(subject);
    } catch (e) {
      const err = e as ApiError;
      setEmailPreviewError(err.message || 'Could not refresh email preview.');
    } finally {
      setEmailPreviewLoading(false);
    }
  }

  async function handleSendEmail() {
    if (demo) {
      closeEmailFlow();
      return;
    }
    if (!emailSubject.trim() || !emailBody.trim()) return;
    setEmailFlow('sending');
    setEmailSubmitError('');
    setEmailSubmitRetry(false);
    try {
      const result = await POST(
        `/api/card-actions/contact-customer/${encodeURIComponent(contactId)}/send-email`,
        { subject: emailSubject.trim(), body: emailBody.trim() },
      ) as {
        call_attempted: boolean;
        email_sent: boolean;
        whatsapp_sent: boolean;
        attempted_at: string;
        attemptLog: AttemptLogEntry[];
      };
      setCallAttempted(result.call_attempted);
      setEmailSent(result.email_sent);
      setWhatsappSent(result.whatsapp_sent);
      setAttemptLog(result.attemptLog);
      if (result.attempted_at) {
        setLastAttemptAt(result.attempted_at);
        const fullName = [currentUser?.first_name, currentUser?.last_name].filter(Boolean).join(' ').trim();
        setLastAttemptBy(fullName || null);
      }
      const sentSubject = emailSubject.trim();
      closeEmailFlow();
      setEmailSentConfirm(sentSubject);
      if (emailConfirmTimerRef.current) clearTimeout(emailConfirmTimerRef.current);
      emailConfirmTimerRef.current = setTimeout(() => setEmailSentConfirm(''), 3000);
      broadcastContactAttemptLogged(contactId);
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 400) {
        setEmailSubmitError(err.message || 'Please check your input and try again.');
        setEmailSubmitRetry(false);
      } else if (err.status != null && err.status >= 500) {
        setEmailSubmitError('Something went wrong on our end.');
        setEmailSubmitRetry(true);
      } else {
        setEmailSubmitError(err.message || 'Could not send the email. Please try again.');
        setEmailSubmitRetry(false);
      }
      setEmailFlow('preview');
    }
  }

  async function handleConfirmAttempt(method: Method) {
    if (demo) {
      closeNotePanel();
      return;
    }
    if (!noteText.trim()) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const result = await POST(
        `/api/card-actions/contact-customer/${encodeURIComponent(contactId)}/attempts`,
        { method, note: noteText.trim() },
      ) as {
        call_attempted: boolean;
        email_sent: boolean;
        whatsapp_sent: boolean;
        attempted_at: string;
        attemptLog: AttemptLogEntry[];
      };
      setCallAttempted(result.call_attempted);
      setEmailSent(result.email_sent);
      setWhatsappSent(result.whatsapp_sent);
      setAttemptLog(result.attemptLog);
      if (result.attempted_at) {
        setLastAttemptAt(result.attempted_at);
        const fullName = [currentUser?.first_name, currentUser?.last_name].filter(Boolean).join(' ').trim();
        setLastAttemptBy(fullName || null);
      }
      const label = method === 'call' ? 'Call logged' : 'WhatsApp logged';
      closeNotePanel();
      setLogConfirm(label);
      if (logConfirmTimerRef.current) clearTimeout(logConfirmTimerRef.current);
      logConfirmTimerRef.current = setTimeout(() => setLogConfirm(''), 3000);
      broadcastContactAttemptLogged(contactId);
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 400) {
        setSubmitError(err.message || 'Please check your input and try again.');
        setSubmitErrorRetry(false);
      } else if (err.status != null && err.status >= 500) {
        setSubmitError('Something went wrong on our end.');
        setSubmitErrorRetry(true);
      } else {
        setSubmitError(err.message || 'Could not save this attempt. Please try again.');
        setSubmitErrorRetry(false);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDone() {
    if (demo) return;
    const currentLeadStatus = contactData?.leadStatus || null;
    const isNullStatus =
      !currentLeadStatus ||
      currentLeadStatus === '' ||
      currentLeadStatus.toUpperCase() === '__NULL__';

    if (isNullStatus && anyTicked) {
      setPhase('advancing');
      setAdvanceError('');
      try {
        const res = await POST(
          `/api/card-actions/contact-customer/${encodeURIComponent(contactId)}/advance-status`,
          { currentLeadStatus, target: CONTACT_CUSTOMER_KEY.attempted_to_contact },
        ) as { setsLeadStatus?: string | null } | undefined;
        setConfirmMessage(leadStatusConfirmationMessage(res?.setsLeadStatus));
      } catch (e) {
        const err = e as Error & { code?: string };
        if (err.code === 'LEAD_STATUS_REMOVED') {
          setAdvanceError(LEAD_STATUS_REMOVED_MESSAGE);
        } else {
          setAdvanceError(err.message || 'Could not update status.');
        }
        setPhase('contact');
        return;
      }
    }
    setPhase('done');
    autoCloseTimerRef.current = setTimeout(() => onClose(), 1500);
  }

  async function handleConfirmNoResponse() {
    if (demo) return;
    const currentLeadStatus = contactData?.leadStatus || null;
    setPhase('advancing');
    setAdvanceError('');
    try {
      const res = await POST(
        `/api/card-actions/contact-customer/${encodeURIComponent(contactId)}/advance-status`,
        { currentLeadStatus, target: CONTACT_CUSTOMER_KEY.no_response },
      ) as { setsLeadStatus?: string | null } | undefined;
      setConfirmMessage(leadStatusConfirmationMessage(res?.setsLeadStatus));
      setPhase('done');
      autoCloseTimerRef.current = setTimeout(() => onClose(), 1500);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === 'LEAD_STATUS_REMOVED') {
        setAdvanceError(LEAD_STATUS_REMOVED_MESSAGE);
      } else {
        setAdvanceError(err.message || 'Could not update status.');
      }
      setPhase('contact');
    }
  }

  function handleSendUploadLink() {
    if (demo) return;
    const ctx = {
      contactId,
      contactName: contactData?.contactName || contactName,
      contactEmail: contactData?.contactEmail || contactEmail,
      contactPhone: contactData?.phone || '',
      contactMobile: contactData?.mobile || '',
    };
    onClose();
    setTimeout(() => {
      dispatchCardActionHandler({ id: 0, type: 'upload_photos_and_info', config: {} }, ctx);
    }, 0);
  }

  const displayName = contactData?.contactName || contactName || 'the customer';
  const phone  = contactData?.phone  || '';
  const mobile = contactData?.mobile || '';

  const methodLogged: Record<Method, boolean> = {
    call:     callAttempted,
    email:    emailSent,
    whatsapp: whatsappSent,
  };

  const titleStr =
    phase === 'loading' ? 'Contact Customer'
    : phase === 'contact' ? `Contact ${displayName}`
    : phase === 'no_response_confirm' ? 'Mark as No Response?'
    : phase === 'advancing' ? 'Updating status…'
    : 'Done';

  let footerNode: React.ReactNode = null;
  if (phase === 'loading') {
    footerNode = <Button onClick={onClose}>Cancel</Button>;
  } else if (phase === 'contact') {
    footerNode = (
      <>
        <DemoActionTooltip demo={demo}>
          <Button
            onClick={handleSendUploadLink}
            variant="outlined"
            disabled={demo}
            data-testid="cc-send-upload-link"
          >
            Send Upload Link
          </Button>
        </DemoActionTooltip>
        <Button
          onClick={() => { setAdvanceError(''); setPhase('no_response_confirm'); }}
          variant="outlined"
          color="warning"
          data-testid="cc-no-response"
        >
          No Response
        </Button>
        <DemoActionTooltip demo={demo}>
          <Button
            onClick={handleDone}
            variant="contained"
            disabled={demo}
            data-testid="cc-done"
          >
            Done
          </Button>
        </DemoActionTooltip>
      </>
    );
  } else if (phase === 'no_response_confirm') {
    footerNode = (
      <>
        <Button onClick={() => setPhase('contact')}>Cancel</Button>
        <DemoActionTooltip demo={demo}>
          <Button
            onClick={handleConfirmNoResponse}
            variant="contained"
            color="warning"
            disabled={demo}
            data-testid="cc-confirm-no-response"
          >
            Confirm
          </Button>
        </DemoActionTooltip>
      </>
    );
  }

  return (
    <FullScreenModal
      open
      onClose={onClose}
      disableClose={phase === 'advancing'}
      title={titleStr}
      headerActions={
        demo ? <Chip label="Demo preview" size="small" color="info" variant="outlined" /> : undefined
      }
      footer={footerNode || undefined}
    >
      {phase === 'loading' && (
        <>
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={36} />
          </Box>
          {loadError && (
            <Alert severity="error" sx={{ mt: 1 }}>{loadError}</Alert>
          )}
        </>
      )}

      {phase === 'contact' && (
            <Stack spacing={2} sx={{ mt: 0.5 }}>
              {loadError && (
                <Alert severity="warning">{loadError}</Alert>
              )}
              {!loadError && (
                <ModalContactHeader
                  name={displayName}
                  phone={phone}
                  mobile={mobile}
                  email={contactData?.contactEmail || contactEmail}
                />
              )}

              <Box>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  Contact methods tried:
                </Typography>
                {emailSentConfirm && (
                  <Alert
                    severity="success"
                    data-testid="email-sent-confirm"
                    onClose={() => setEmailSentConfirm('')}
                    sx={{ mb: 1, py: 0.25 }}
                  >
                    Email sent: <strong>{emailSentConfirm}</strong>
                  </Alert>
                )}
                {logConfirm && (
                  <Alert
                    severity="success"
                    data-testid="log-confirm"
                    onClose={() => {
                      if (logConfirmTimerRef.current) clearTimeout(logConfirmTimerRef.current);
                      setLogConfirm('');
                    }}
                    sx={{ mb: 1, py: 0.25 }}
                  >
                    {logConfirm}
                  </Alert>
                )}
                <Stack spacing={1}>
                  {METHODS.map((method) => {
                    const logged   = methodLogged[method];
                    const isEmail  = method === 'email';
                    const isOpen   = isEmail ? emailFlow !== 'idle' : openPanel === method;
                    const contactEmailAddr = contactData?.contactEmail || contactEmail;
                    return (
                      <Box key={method}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Button
                            data-testid={`contact-method-${method}-btn`}
                            variant="outlined"
                            size="small"
                            onClick={() => {
                              if (isEmail) {
                                if (isOpen) { closeEmailFlow(); }
                                else { void openEmailPreview(); }
                              } else {
                                if (isOpen) { closeNotePanel(); }
                                else { openNotePanel(method); }
                              }
                            }}
                            disabled={submitting || emailFlow === 'sending'}
                            sx={logged ? {
                              borderColor: 'grey.400',
                              color: 'text.secondary',
                              bgcolor: 'grey.100',
                              '&:hover': { bgcolor: 'grey.200', borderColor: 'grey.500' },
                            } : {}}
                          >
                            {logged ? `✓ ${METHOD_BUTTON_LABEL[method]}` : METHOD_BUTTON_LABEL[method]}
                          </Button>
                          {logged && !isOpen && (
                            <Typography
                              component="button"
                              variant="caption"
                              onClick={() => isEmail ? void openEmailPreview() : openNotePanel(method)}
                              sx={{
                                color: 'primary.main',
                                cursor: 'pointer',
                                background: 'none',
                                border: 'none',
                                padding: 0,
                                textDecoration: 'underline',
                                '&:hover': { color: 'primary.dark' },
                              }}
                            >
                              + log another
                            </Typography>
                          )}
                        </Box>

                        {isOpen && isEmail && (
                          <Box
                            data-testid="email-preview-panel"
                            sx={{
                              mt: 1,
                              pl: 1.5,
                              borderLeft: '2px solid',
                              borderColor: 'primary.main',
                            }}
                          >
                            {!contactEmailAddr ? (
                              <Typography variant="body2" color="text.secondary" sx={{ py: 0.5 }}>
                                No email address is on record for this contact. Add one in HubSpot before sending.
                              </Typography>
                            ) : emailPreviewLoading ? (
                              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5 }}>
                                <CircularProgress size={16} />
                                <Typography variant="caption" color="text.secondary">Loading preview…</Typography>
                              </Box>
                            ) : (
                              <>
                                {/* To: header + Edit/Preview toggle on the same row */}
                                <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', mb: 0.5, gap: 1 }}>
                                  <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                                    To:{' '}
                                    <strong>
                                      {(contactData?.contactName || contactName)
                                        ? `${contactData?.contactName || contactName} <${contactEmailAddr}>`
                                        : contactEmailAddr}
                                    </strong>
                                  </Typography>
                                  <ToggleButtonGroup
                                    size="small"
                                    exclusive
                                    value={emailViewMode}
                                    onChange={(_, v) => {
                                      if (!v) return;
                                      const next = v as 'edit' | 'preview';
                                      setEmailViewMode(next);
                                      if (next === 'preview' && !demo) {
                                        const bodyDirty    = emailBody.trim()    !== emailFetchedBody.trim();
                                        const subjectDirty = emailSubject.trim() !== emailFetchedSubject.trim();
                                        if (bodyDirty || subjectDirty) {
                                          void refetchEmailHtml(emailSubject.trim(), emailBody.trim());
                                        }
                                      }
                                    }}
                                    disabled={emailFlow === 'sending'}
                                  >
                                    <ToggleButton value="edit" sx={{ px: 1.25, py: 0.25, fontSize: '0.7rem' }}>
                                      Edit
                                    </ToggleButton>
                                    <ToggleButton
                                      value="preview"
                                      data-testid="email-html-preview-toggle"
                                      sx={{ px: 1.25, py: 0.25, fontSize: '0.7rem' }}
                                    >
                                      Preview
                                    </ToggleButton>
                                  </ToggleButtonGroup>
                                </Box>

                                {emailViewMode === 'edit' ? (
                                  <>
                                    <TextField
                                      data-testid="email-preview-subject"
                                      label="Subject"
                                      size="small"
                                      fullWidth
                                      value={emailSubject}
                                      onChange={(e) => setEmailSubject(e.target.value)}
                                      disabled={emailFlow === 'sending'}
                                      sx={{ mb: 1 }}
                                    />
                                    <TextField
                                      data-testid="email-preview-body"
                                      label="Body"
                                      size="small"
                                      multiline
                                      minRows={4}
                                      fullWidth
                                      value={emailBody}
                                      onChange={(e) => setEmailBody(e.target.value)}
                                      disabled={emailFlow === 'sending'}
                                      sx={{ mb: 0.75 }}
                                    />
                                  </>
                                ) : (
                                  /* HTML preview — mirrors what the recipient will see */
                                  <Box sx={{ mb: 0.75 }}>
                                    {/* Subject preview */}
                                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>
                                      Subject
                                    </Typography>
                                    <Box sx={{
                                      px: 1.5, py: 0.75,
                                      border: '1px solid',
                                      borderColor: 'divider',
                                      borderRadius: 1,
                                      bgcolor: 'background.paper',
                                      mb: 1,
                                    }}>
                                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                                        {emailSubject.trim() || <em style={{ opacity: 0.5 }}>empty subject</em>}
                                      </Typography>
                                    </Box>
                                    {/* Body HTML preview in sandboxed iframe */}
                                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>
                                      Body
                                    </Typography>
                                    <Box sx={{
                                      border: '1px solid',
                                      borderColor: 'divider',
                                      borderRadius: 1,
                                      overflow: 'hidden',
                                      bgcolor: 'common.white',
                                      position: 'relative',
                                    }}>
                                      {emailPreviewLoading && (
                                        <Box sx={{
                                          position: 'absolute', inset: 0,
                                          display: 'flex', alignItems: 'center', gap: 1,
                                          px: 2, py: 1.5,
                                          bgcolor: 'rgba(255,255,255,0.75)',
                                          zIndex: 1,
                                        }}>
                                          <CircularProgress size={16} />
                                          <Typography variant="caption" color="text.secondary">Refreshing preview…</Typography>
                                        </Box>
                                      )}
                                      <iframe
                                        data-testid="email-html-preview-iframe"
                                        title="Email HTML preview"
                                        sandbox="allow-same-origin"
                                        srcDoc={emailPreviewHtml || `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;font-size:14px;color:${IFRAME_BODY_COLOR};padding:12px 16px;margin:0;}p{margin:0 0 0.6em;}</style></head><body>${bodyTextToHtml(emailBody)}</body></html>`}
                                        style={{ width: '100%', minHeight: 120, border: 'none', display: 'block' }}
                                        onLoad={(e) => {
                                          const iframe = e.currentTarget;
                                          try {
                                            const h = iframe.contentDocument?.body?.scrollHeight;
                                            if (h && h > 0) iframe.style.height = `${h + 24}px`;
                                          } catch (_) { /* cross-origin guard */ }
                                        }}
                                      />
                                    </Box>
                                    {/* Send / Cancel inline below the iframe so staff don't need to scroll */}
                                    <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                                      <Button
                                        data-testid="email-preview-send-btn-inline"
                                        size="small"
                                        variant="contained"
                                        disabled={emailFlow === 'sending' || !emailSubject.trim() || !emailBody.trim()}
                                        onClick={() => void handleSendEmail()}
                                        startIcon={emailFlow === 'sending' ? <CircularProgress size={14} color="inherit" /> : undefined}
                                      >
                                        Send Email
                                      </Button>
                                      <Button
                                        size="small"
                                        variant="text"
                                        onClick={closeEmailFlow}
                                        disabled={emailFlow === 'sending'}
                                      >
                                        Cancel
                                      </Button>
                                    </Box>
                                  </Box>
                                )}

                                {emailPreviewError && (
                                  <Alert severity="error" sx={{ mb: 0.75, py: 0 }}>{emailPreviewError}</Alert>
                                )}
                                {emailSubmitError && (
                                  <Typography variant="caption" color="error" sx={{ display: 'block', mb: 0.5 }}>
                                    {emailSubmitError}
                                    {emailSubmitRetry && (
                                      <>
                                        {' '}
                                        <Box
                                          component="button"
                                          onClick={() => void handleSendEmail()}
                                          disabled={emailFlow === 'sending'}
                                          sx={{
                                            background: 'none',
                                            border: 'none',
                                            padding: 0,
                                            cursor: 'pointer',
                                            color: 'error.main',
                                            fontWeight: 600,
                                            fontSize: 'inherit',
                                            textDecoration: 'underline',
                                            '&:hover': { color: 'error.dark' },
                                            '&:disabled': { opacity: 0.5, cursor: 'default' },
                                          }}
                                        >
                                          Try again
                                        </Box>
                                      </>
                                    )}
                                  </Typography>
                                )}
                                <Box sx={{ display: 'flex', gap: 1 }}>
                                  <Button
                                    data-testid="email-preview-send-btn"
                                    size="small"
                                    variant="contained"
                                    disabled={emailFlow === 'sending' || !emailSubject.trim() || !emailBody.trim()}
                                    onClick={() => void handleSendEmail()}
                                    startIcon={emailFlow === 'sending' ? <CircularProgress size={14} color="inherit" /> : undefined}
                                  >
                                    Send Email
                                  </Button>
                                  <Button
                                    size="small"
                                    variant="text"
                                    onClick={closeEmailFlow}
                                    disabled={emailFlow === 'sending'}
                                  >
                                    Cancel
                                  </Button>
                                </Box>
                              </>
                            )}
                          </Box>
                        )}

                        {isOpen && !isEmail && (
                          <Box
                            sx={{
                              mt: 1,
                              pl: 1.5,
                              borderLeft: '2px solid',
                              borderColor: 'primary.main',
                            }}
                          >
                            <TextField
                              data-testid="contact-attempt-note-field"
                              size="small"
                              multiline
                              minRows={2}
                              fullWidth
                              placeholder="Add a note about this attempt…"
                              value={noteText}
                              onChange={(e) => setNoteText(e.target.value)}
                              disabled={submitting}
                            />
                            {submitError && (
                              <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.5 }}>
                                {submitError}
                                {submitErrorRetry && (
                                  <>
                                    {' '}
                                    <Box
                                      component="button"
                                      onClick={() => handleConfirmAttempt(method)}
                                      disabled={submitting}
                                      sx={{
                                        background: 'none',
                                        border: 'none',
                                        padding: 0,
                                        cursor: 'pointer',
                                        color: 'error.main',
                                        fontWeight: 600,
                                        fontSize: 'inherit',
                                        textDecoration: 'underline',
                                        '&:hover': { color: 'error.dark' },
                                        '&:disabled': { opacity: 0.5, cursor: 'default' },
                                      }}
                                    >
                                      Try again
                                    </Box>
                                  </>
                                )}
                              </Typography>
                            )}
                            <Box sx={{ display: 'flex', gap: 1, mt: 0.75 }}>
                              <Button
                                data-testid="contact-attempt-confirm-btn"
                                size="small"
                                variant="contained"
                                disabled={!noteText.trim() || submitting}
                                onClick={() => handleConfirmAttempt(method)}
                                startIcon={submitting ? <CircularProgress size={14} color="inherit" /> : undefined}
                              >
                                Confirm
                              </Button>
                              <Button
                                size="small"
                                variant="text"
                                onClick={closeNotePanel}
                                disabled={submitting}
                              >
                                Cancel
                              </Button>
                            </Box>
                          </Box>
                        )}
                      </Box>
                    );
                  })}
                </Stack>
              </Box>

              {(attemptLog.length > 0 || historySessionCount > 0) && (
                <Box>
                  <Divider sx={{ mb: 1 }} />
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Contact history
                  </Typography>
                  {attemptLog.length > 0 && (() => {
                    const methodOrder: Array<Method> = ['call', 'email', 'whatsapp'];
                    const methodLabels: Record<Method, (n: number) => string> = {
                      call:     (n) => `${n} ${n === 1 ? 'call' : 'calls'}`,
                      email:    (n) => `${n} ${n === 1 ? 'email' : 'emails'}`,
                      whatsapp: (n) => `${n} WhatsApp`,
                    };
                    const mc = attemptLog.reduce<Record<string, number>>((acc, e) => {
                      acc[e.method] = (acc[e.method] ?? 0) + 1;
                      return acc;
                    }, {});
                    const breakdown = [
                      ...methodOrder.filter((m) => (mc[m] ?? 0) > 0).map((m) => methodLabels[m](mc[m])),
                      ...Object.keys(mc).filter((m) => !methodOrder.includes(m as Method) && mc[m] > 0).map((m) => `${mc[m]} ${m}`),
                    ].join(', ');
                    const total = attemptLog.length;
                    return (
                      <Box
                        sx={{
                          px: 1,
                          py: 0.5,
                          mb: 0.75,
                          bgcolor: 'grey.100',
                          borderRadius: 1,
                          border: '1px solid',
                          borderColor: 'divider',
                        }}
                      >
                        <Typography variant="caption" color="text.secondary">
                          <strong>{total} {total === 1 ? 'attempt' : 'attempts'}</strong>
                          {breakdown ? ` · ${breakdown}` : ''}
                        </Typography>
                      </Box>
                    );
                  })()}
                  {historySessionCount > 0 && (() => {
                    const historyMethods = [
                      historyEverCalled      && 'calls',
                      historyEverEmailed     && 'emails',
                      historyEverWhatsapped  && 'WhatsApp',
                    ].filter(Boolean).join(', ');
                    return (
                      <>
                        <Box
                          sx={{
                            px: 1,
                            py: 0.5,
                            mb: historyAttemptLog.length > 0 ? 0.5 : 0.75,
                            bgcolor: 'grey.50',
                            borderRadius: 1,
                            border: '1px solid',
                            borderColor: 'divider',
                          }}
                        >
                          <Typography variant="caption" color="text.secondary">
                            <strong>Across all sessions · {historyTotalAttempts} {historyTotalAttempts === 1 ? 'attempt' : 'attempts'}</strong>
                            {historyMethods ? ` · ${historyMethods}` : ''}
                            {' '}
                            <Box component="span" sx={{ color: 'text.disabled' }}>
                              ({historySessionCount} prior {historySessionCount === 1 ? 'session' : 'sessions'})
                            </Box>
                          </Typography>
                        </Box>
                        {historyAttemptLog.length > 0 && (() => {
                          const visibleEntries = historyAttemptLog.filter(
                            e => e.callAttempted || e.emailSent || e.whatsappSent,
                          );
                          const hiddenCount = historyAttemptLog.length - visibleEntries.length;
                          return (
                            <>
                              {visibleEntries.length > 0 && (
                                <Box
                                  sx={{
                                    maxHeight: 120,
                                    overflowY: 'auto',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 0.5,
                                    mb: hiddenCount > 0 ? 0.25 : 0.75,
                                    pl: 1,
                                    borderLeft: '2px solid',
                                    borderColor: 'divider',
                                  }}
                                >
                                  {visibleEntries.map((entry, i) => {
                                    const sessionMethods = [
                                      entry.callAttempted  && METHOD_LABEL['call'],
                                      entry.emailSent      && METHOD_LABEL['email'],
                                      entry.whatsappSent   && METHOD_LABEL['whatsapp'],
                                    ].filter(Boolean).join(', ');
                                    return (
                                      <Box
                                        key={i}
                                        sx={{
                                          px: 1,
                                          py: 0.375,
                                          borderRadius: 1,
                                          bgcolor: 'grey.50',
                                          opacity: 0.85,
                                        }}
                                      >
                                        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
                                          <Typography
                                            variant="caption"
                                            sx={{
                                              fontWeight: 600,
                                              minWidth: 56,
                                            }}
                                          >
                                            {sessionMethods}
                                          </Typography>
                                          <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                                            {relativeTime(entry.attemptedAt)}
                                            {entry.attemptedBy ? ` · ${entry.attemptedBy}` : ''}
                                          </Typography>
                                        </Box>
                                        {entry.notes.length > 0 && (
                                          <Box sx={{ mt: 0.25, pl: '56px', display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                                            {entry.notes.map((n, ni) => (
                                              <Typography
                                                key={ni}
                                                variant="caption"
                                                color="text.secondary"
                                                sx={{ display: 'block', fontStyle: 'italic' }}
                                              >
                                                {METHOD_LABEL[n.method]}: {n.note}
                                              </Typography>
                                            ))}
                                          </Box>
                                        )}
                                      </Box>
                                    );
                                  })}
                                </Box>
                              )}
                              {hiddenCount > 0 && (
                                <>
                                  <Typography
                                    component="button"
                                    variant="caption"
                                    onClick={() => setShowHiddenSessions(v => !v)}
                                    sx={{
                                      display: 'block',
                                      fontStyle: 'italic',
                                      mb: showHiddenSessions ? 0.25 : 0.75,
                                      pl: 1,
                                      background: 'none',
                                      border: 'none',
                                      padding: 0,
                                      cursor: 'pointer',
                                      color: 'text.secondary',
                                      textAlign: 'left',
                                      textDecoration: 'underline',
                                      textDecorationStyle: 'dotted',
                                      '&:hover': { color: 'text.primary' },
                                    }}
                                  >
                                    {hiddenCount} {hiddenCount === 1 ? 'session' : 'sessions'} with no methods recorded{' '}
                                    {showHiddenSessions ? '▲ hide' : '▼ show'}
                                  </Typography>
                                  {showHiddenSessions && (
                                    <Box
                                      sx={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 0.5,
                                        mb: 0.75,
                                        pl: 1,
                                        borderLeft: '2px solid',
                                        borderColor: 'divider',
                                      }}
                                    >
                                      {historyAttemptLog
                                        .filter(e => !e.callAttempted && !e.emailSent && !e.whatsappSent)
                                        .map((entry, i) => (
                                          <Box
                                            key={i}
                                            sx={{
                                              display: 'flex',
                                              alignItems: 'baseline',
                                              gap: 0.75,
                                              px: 1,
                                              py: 0.375,
                                              borderRadius: 1,
                                              bgcolor: 'grey.50',
                                              opacity: 0.75,
                                            }}
                                          >
                                            <Typography
                                              variant="caption"
                                              sx={{
                                                fontStyle: 'italic',
                                                color: 'text.disabled',
                                                minWidth: 56,
                                              }}
                                            >
                                              No contact logged
                                            </Typography>
                                            <Typography variant="caption" color="text.disabled" sx={{ flex: 1 }}>
                                              {relativeTime(entry.attemptedAt)}
                                              {entry.attemptedBy ? ` · ${entry.attemptedBy}` : ''}
                                            </Typography>
                                          </Box>
                                        ))
                                      }
                                    </Box>
                                  )}
                                </>
                              )}
                            </>
                          );
                        })()}
                      </>
                    );
                  })()}
                  {attemptLog.length > 0 && (
                    <Box
                      sx={{
                        maxHeight: 140,
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 0.5,
                      }}
                    >
                      {attemptLog.map((entry, i) => (
                        <Box
                          key={i}
                          sx={{
                            display: 'flex',
                            alignItems: 'baseline',
                            gap: 0.75,
                            px: 1,
                            py: 0.5,
                            borderRadius: 1,
                            bgcolor: 'grey.50',
                          }}
                        >
                          <Typography variant="caption" sx={{ fontWeight: 600, minWidth: 56 }}>
                            {METHOD_LABEL[entry.method]}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                            {relativeTime(entry.attemptedAt)}
                            {entry.attemptedBy ? ` · ${entry.attemptedBy}` : ''}
                            {entry.note ? ` | Note: ${entry.note}` : ''}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  )}
                </Box>
              )}

              {attemptLog.length === 0 && lastAttemptAt && (
                <Tooltip
                  title={buildActivityTooltipContent(
                    {
                      at: lastAttemptAt,
                      by: lastAttemptBy,
                      count: historyTotalAttempts,
                      method: null,
                      methodCounts: null,
                    } satisfies LastAttempt,
                    lastAttemptAt,
                  )}
                  arrow
                  placement="top"
                  enterDelay={200}
                >
                  <Box
                    sx={{
                      px: 1.5,
                      py: 1,
                      bgcolor: 'grey.50',
                      borderRadius: 1,
                      border: '1px solid',
                      borderColor: 'divider',
                      cursor: 'default',
                    }}
                  >
                    <Typography variant="caption" color="text.secondary">
                      Last contacted {relativeTime(lastAttemptAt)}
                      {lastAttemptBy ? ` · ${lastAttemptBy}` : ''}
                    </Typography>
                  </Box>
                </Tooltip>
              )}

              {advanceError && (
                <Alert severity="error">{advanceError}</Alert>
              )}
            </Stack>
      )}

      {phase === 'no_response_confirm' && (() => {
        const currentMethodCount = [callAttempted, emailSent, whatsappSent].filter(Boolean).length;
        const totalSessions  = historySessionCount + 1;
        const totalAttempts  = historyTotalAttempts + currentMethodCount;
        const everCalled     = historyEverCalled     || callAttempted;
        const everEmailed    = historyEverEmailed    || emailSent;
        const everWhatsapped = historyEverWhatsapped || whatsappSent;
        const anyEver        = everCalled || everEmailed || everWhatsapped;
        return (
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {!loadError && (
              <ModalContactHeader
                name={displayName}
                phone={phone}
                mobile={mobile}
                email={contactData?.contactEmail || contactEmail}
              />
            )}
            <Typography variant="body2">
              This will advance the lead status to <strong>No Response</strong>.
            </Typography>
            {anyEver ? (
              <Typography variant="body2" color="text.secondary">
                {totalAttempts} attempt{totalAttempts === 1 ? '' : 's'} recorded across{' '}
                {totalSessions} session{totalSessions === 1 ? '' : 's'} —{' '}
                Called {everCalled ? '✓' : '✗'} · Emailed {everEmailed ? '✓' : '✗'} · WhatsApp {everWhatsapped ? '✓' : '✗'}
              </Typography>
            ) : (
              <Alert severity="warning" sx={{ py: 0 }}>
                No contact methods have been recorded. You can cancel and tick the boxes before continuing.
              </Alert>
            )}
          </Stack>
        );
      })()}

      {phase === 'advancing' && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={36} />
        </Box>
      )}

      {phase === 'done' && (
        <Typography variant="body2" color="text.secondary">
          {confirmMessage || 'Contact record updated.'}
        </Typography>
      )}
    </FullScreenModal>
  );
}
