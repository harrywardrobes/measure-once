import React, { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { POST, PATCH } from '../../utils/api';
import { dispatchCardActionHandler } from '../../utils/dispatchCardActionHandler';
import { LEAD_STATUS_REMOVED_MESSAGE } from '../../utils/api';
import { useAuth } from '../../contexts/AuthContext';
import { ContactInfoHeader } from './ContactInfoHeader';
import { DemoDialogTitle, DemoActionTooltip } from './demoMode';
import { DEMO_CONTACT } from './demoData';

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

interface AttemptLogEntry {
  method: 'call' | 'email' | 'whatsapp';
  attemptedAt: string;
  attemptedBy: string | null;
}

interface HistorySessionEntry {
  attemptedAt: string;
  attemptedBy: string | null;
  callAttempted: boolean;
  emailSent: boolean;
  whatsappSent: boolean;
}

interface ContactData {
  contactName: string;
  contactEmail: string;
  phone: string;
  mobile: string;
  whatsapp: string;
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

const METHOD_LABEL: Record<AttemptLogEntry['method'], string> = {
  call:     'Called',
  email:    'Emailed',
  whatsapp: 'WhatsApp',
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(diff / 86400000);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

const DEMO_CONTACT_DATA: ContactData = {
  contactName: DEMO_CONTACT.name,
  contactEmail: DEMO_CONTACT.email,
  phone: DEMO_CONTACT.phone,
  mobile: DEMO_CONTACT.mobile,
  whatsapp: DEMO_CONTACT.whatsapp,
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

  const [callInFlight,     setCallInFlight]     = useState(false);
  const [emailInFlight,    setEmailInFlight]     = useState(false);
  const [whatsappInFlight, setWhatsappInFlight] = useState(false);

  const [callError,     setCallError]     = useState('');
  const [emailError,    setEmailError]    = useState('');
  const [whatsappError, setWhatsappError] = useState('');

  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (demo) {
      setContactData(DEMO_CONTACT_DATA);
      setPhase('contact');
      return;
    }
    setPhase('loading');
    setLoadError('');
    setAdvanceError('');
    setCallError('');
    setEmailError('');
    setWhatsappError('');

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
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  const anyTicked = callAttempted || emailSent || whatsappSent;

  async function toggleAttempt(
    field: 'call_attempted' | 'email_sent' | 'whatsapp_sent',
    currentValue: boolean,
    setInFlight: (v: boolean) => void,
    setValue: (v: boolean) => void,
    setError: (v: string) => void,
  ) {
    const newValue = !currentValue;
    setValue(newValue);
    if (demo) return;
    setInFlight(true);
    setError('');
    try {
      const result = await PATCH(
        `/api/card-actions/contact-customer/${encodeURIComponent(contactId)}/attempts`,
        { [field]: newValue },
      ) as {
        call_attempted: boolean;
        email_sent: boolean;
        whatsapp_sent: boolean;
        attempted_at?: string | null;
        attemptLog?: AttemptLogEntry[];
      };
      setCallAttempted(result.call_attempted);
      setEmailSent(result.email_sent);
      setWhatsappSent(result.whatsapp_sent);
      if (result.attemptLog) {
        setAttemptLog(result.attemptLog);
      }
      if (newValue && result.attempted_at) {
        setLastAttemptAt(result.attempted_at);
        const fullName = [currentUser?.first_name, currentUser?.last_name].filter(Boolean).join(' ').trim();
        setLastAttemptBy(fullName || null);
      }
    } catch (e) {
      setValue(currentValue);
      setError((e as Error).message || 'Could not save change.');
    } finally {
      setInFlight(false);
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
        await POST(
          `/api/card-actions/contact-customer/${encodeURIComponent(contactId)}/advance-status`,
          { currentLeadStatus, target: 'attempted_to_contact' },
        );
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
      await POST(
        `/api/card-actions/contact-customer/${encodeURIComponent(contactId)}/advance-status`,
        { currentLeadStatus, target: 'no_response' },
      );
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
    };
    onClose();
    setTimeout(() => {
      dispatchCardActionHandler({ id: 0, type: 'upload_photos_and_info', config: {} }, ctx);
    }, 0);
  }

  const displayName = contactData?.contactName || contactName || 'the customer';
  const phone   = contactData?.phone    || '';
  const mobile  = contactData?.mobile   || '';
  const whatsapp = contactData?.whatsapp || '';

  return (
    <Dialog open onClose={() => { if (phase !== 'advancing') onClose(); }} maxWidth="xs" fullWidth>
      {phase === 'loading' && (
        <>
          <DemoDialogTitle demo={demo}>Contact Customer</DemoDialogTitle>
          <DialogContent>
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress size={36} />
            </Box>
            {loadError && (
              <Alert severity="error" sx={{ mt: 1 }}>{loadError}</Alert>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Cancel</Button>
          </DialogActions>
        </>
      )}

      {phase === 'contact' && (
        <>
          <DemoDialogTitle demo={demo}>Call {displayName}</DemoDialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 0.5 }}>
              {loadError && (
                <Alert severity="warning">{loadError}</Alert>
              )}
              {!loadError && (
                <ContactInfoHeader
                  name={displayName}
                  phone={phone}
                  mobile={mobile}
                  whatsapp={whatsapp}
                  email={contactData?.contactEmail || contactEmail}
                />
              )}

              <Box>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                  Contact methods tried:
                </Typography>
                <Stack spacing={0}>
                  <Box>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={callAttempted}
                          disabled={callInFlight}
                          onChange={() =>
                            toggleAttempt('call_attempted', callAttempted, setCallInFlight, setCallAttempted, setCallError)
                          }
                          size="small"
                        />
                      }
                      label={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <Typography variant="body2">Called</Typography>
                          {callInFlight && <CircularProgress size={14} />}
                        </Box>
                      }
                    />
                    {callError && (
                      <Typography variant="caption" color="error" sx={{ ml: 4, display: 'block' }}>
                        {callError}
                      </Typography>
                    )}
                  </Box>

                  <Box>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={emailSent}
                          disabled={emailInFlight}
                          onChange={() =>
                            toggleAttempt('email_sent', emailSent, setEmailInFlight, setEmailSent, setEmailError)
                          }
                          size="small"
                        />
                      }
                      label={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <Typography variant="body2">Emailed</Typography>
                          {emailInFlight && <CircularProgress size={14} />}
                        </Box>
                      }
                    />
                    {emailError && (
                      <Typography variant="caption" color="error" sx={{ ml: 4, display: 'block' }}>
                        {emailError}
                      </Typography>
                    )}
                  </Box>

                  <Box>
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={whatsappSent}
                          disabled={whatsappInFlight}
                          onChange={() =>
                            toggleAttempt('whatsapp_sent', whatsappSent, setWhatsappInFlight, setWhatsappSent, setWhatsappError)
                          }
                          size="small"
                        />
                      }
                      label={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <Typography variant="body2">WhatsApp</Typography>
                          {whatsappInFlight && <CircularProgress size={14} />}
                        </Box>
                      }
                    />
                    {whatsappError && (
                      <Typography variant="caption" color="error" sx={{ ml: 4, display: 'block' }}>
                        {whatsappError}
                      </Typography>
                    )}
                  </Box>
                </Stack>
              </Box>

              {(attemptLog.length > 0 || historySessionCount > 0) && (
                <Box>
                  <Divider sx={{ mb: 1 }} />
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Contact history
                  </Typography>
                  {attemptLog.length > 0 && (() => {
                    const methodOrder: Array<AttemptLogEntry['method']> = ['call', 'email', 'whatsapp'];
                    const methodLabels: Record<AttemptLogEntry['method'], (n: number) => string> = {
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
                      ...Object.keys(mc).filter((m) => !methodOrder.includes(m as AttemptLogEntry['method']) && mc[m] > 0).map((m) => `${mc[m]} ${m}`),
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
                                          display: 'flex',
                                          alignItems: 'baseline',
                                          gap: 0.75,
                                          px: 1,
                                          py: 0.375,
                                          borderRadius: 1,
                                          bgcolor: 'grey.50',
                                          opacity: 0.85,
                                        }}
                                      >
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
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  )}
                </Box>
              )}

              {attemptLog.length === 0 && lastAttemptAt && (
                <Box
                  sx={{
                    px: 1.5,
                    py: 1,
                    bgcolor: 'grey.50',
                    borderRadius: 1,
                    border: '1px solid',
                    borderColor: 'divider',
                  }}
                >
                  <Typography variant="caption" color="text.secondary">
                    Last contacted {relativeTime(lastAttemptAt)}
                    {lastAttemptBy ? ` · ${lastAttemptBy}` : ''}
                  </Typography>
                </Box>
              )}

              {advanceError && (
                <Alert severity="error">{advanceError}</Alert>
              )}
            </Stack>
          </DialogContent>
          <DialogActions sx={{ flexWrap: 'wrap', gap: 1, justifyContent: 'flex-end', pb: 2, px: 2 }}>
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
          </DialogActions>
        </>
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
          <>
            <DemoDialogTitle demo={demo}>Mark as No Response?</DemoDialogTitle>
            <DialogContent>
              <Stack spacing={1.5} sx={{ mt: 0.5 }}>
                {!loadError && (
                  <ContactInfoHeader
                    name={displayName}
                    phone={phone}
                    mobile={mobile}
                    whatsapp={whatsapp}
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
            </DialogContent>
          <DialogActions>
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
          </DialogActions>
        </>
        );
      })()}

      {phase === 'advancing' && (
        <>
          <DialogTitle>Updating status…</DialogTitle>
          <DialogContent>
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress size={36} />
            </Box>
          </DialogContent>
        </>
      )}

      {phase === 'done' && (
        <>
          <DialogTitle>Done</DialogTitle>
          <DialogContent>
            <Typography variant="body2" color="text.secondary">
              Contact record updated.
            </Typography>
          </DialogContent>
        </>
      )}
    </Dialog>
  );
}
