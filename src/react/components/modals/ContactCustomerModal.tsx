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

interface Props {
  contactId: string;
  contactName: string;
  contactEmail: string;
  onClose: () => void;
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

export function ContactCustomerModal({ contactId, contactName, contactEmail, onClose }: Props) {
  const { user: currentUser } = useAuth();

  const [phase, setPhase] = useState<Phase>('loading');
  const [contactData, setContactData] = useState<ContactData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [advanceError, setAdvanceError] = useState('');

  const [callAttempted, setCallAttempted] = useState(false);
  const [emailSent, setEmailSent]         = useState(false);
  const [whatsappSent, setWhatsappSent]   = useState(false);

  const [attemptLog, setAttemptLog] = useState<AttemptLogEntry[]>([]);

  const [lastAttemptAt, setLastAttemptAt] = useState<string | null>(null);
  const [lastAttemptBy, setLastAttemptBy] = useState<string | null>(null);

  const [callInFlight,     setCallInFlight]     = useState(false);
  const [emailInFlight,    setEmailInFlight]     = useState(false);
  const [whatsappInFlight, setWhatsappInFlight] = useState(false);

  const [callError,     setCallError]     = useState('');
  const [emailError,    setEmailError]    = useState('');
  const [whatsappError, setWhatsappError] = useState('');

  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
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
          <DialogTitle>Contact Customer</DialogTitle>
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
          <DialogTitle>Call {displayName}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 0.5 }}>
              {loadError && (
                <Alert severity="warning">{loadError}</Alert>
              )}
              {(phone || mobile || whatsapp) ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  {phone && (
                    <Box>
                      <Typography variant="body2" color="text.secondary">Phone</Typography>
                      <Typography variant="h6" sx={{ fontWeight: 600 }}>{phone}</Typography>
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
              ) : !loadError ? (
                <Alert severity="warning">No phone number on record for this contact.</Alert>
              ) : null}

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

              {attemptLog.length > 0 && (
                <Box>
                  <Divider sx={{ mb: 1 }} />
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Contact history
                  </Typography>
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
            <Button
              onClick={handleSendUploadLink}
              variant="outlined"
              data-testid="cc-send-upload-link"
            >
              Send Upload Link
            </Button>
            <Button
              onClick={() => { setAdvanceError(''); setPhase('no_response_confirm'); }}
              variant="outlined"
              color="warning"
              data-testid="cc-no-response"
            >
              No Response
            </Button>
            <Button
              onClick={handleDone}
              variant="contained"
              data-testid="cc-done"
            >
              Done
            </Button>
          </DialogActions>
        </>
      )}

      {phase === 'no_response_confirm' && (
        <>
          <DialogTitle>Mark as No Response?</DialogTitle>
          <DialogContent>
            <Stack spacing={1.5} sx={{ mt: 0.5 }}>
              <Typography variant="body2">
                This will advance the lead status to <strong>No Response</strong>.
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Contact methods tried:
              </Typography>
              {(callAttempted || emailSent || whatsappSent) ? (
                <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap' }}>
                  <Typography variant="body2">
                    Called {callAttempted ? '✓' : '✗'}
                  </Typography>
                  <Typography variant="body2">
                    Emailed {emailSent ? '✓' : '✗'}
                  </Typography>
                  <Typography variant="body2">
                    WhatsApp {whatsappSent ? '✓' : '✗'}
                  </Typography>
                </Stack>
              ) : (
                <Alert severity="warning" sx={{ py: 0 }}>
                  No contact methods have been recorded. You can cancel and tick the boxes before continuing.
                </Alert>
              )}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setPhase('contact')}>Cancel</Button>
            <Button
              onClick={handleConfirmNoResponse}
              variant="contained"
              color="warning"
              data-testid="cc-confirm-no-response"
            >
              Confirm
            </Button>
          </DialogActions>
        </>
      )}

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
