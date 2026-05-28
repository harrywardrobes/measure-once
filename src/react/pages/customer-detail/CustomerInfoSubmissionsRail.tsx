import React, { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import Alert from '@mui/material/Alert';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HomeIcon from '@mui/icons-material/Home';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HourglassBottomIcon from '@mui/icons-material/HourglassBottom';
import SendIcon from '@mui/icons-material/Send';
import { usePrivilege } from '../../hooks/usePrivilege';
import { useToast } from '../../contexts/ToastContext';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Submission {
  id: number;
  created_at: string;
  submitted_at: string | null;
  expires_at: string;
  contact_name: string | null;
  contact_email: string | null;
  corrected_email: string | null;
  corrected_mobile: string | null;
  address_line1: string | null;
  city: string | null;
  postcode: string | null;
  room_count: string | null;
  room_notes: string | null;
  photo_keys: string[];
  photoUrls: string[];
  email_skipped_count: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
  } catch { return iso; }
}

function roomLabel(count: string | null): string {
  if (!count) return '—';
  if (count === '1') return '1 room';
  if (count === '2') return '2 rooms';
  return '3+ rooms';
}

// ── Resend button ─────────────────────────────────────────────────────────────

type ResendState = 'idle' | 'loading' | 'sent' | 'error';

function ResendButton({
  contactId,
  onSuccess,
}: {
  contactId: string;
  onSuccess: () => void;
}) {
  const [state, setState] = useState<ResendState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const showToast = useToast();

  async function handleResend() {
    setState('loading');
    setErrorMsg('');
    try {
      const r = await fetch(
        `/api/customer-info/by-contact/${encodeURIComponent(contactId)}/resend`,
        { method: 'POST' }
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${r.status}`);
      }
      setState('sent');
      showToast('A fresh link has been sent to the customer');
      onSuccess();
    } catch (e) {
      const msg = (e as Error).message;
      setErrorMsg(msg);
      setState('error');
      showToast(msg, true);
    }
  }

  if (state === 'sent') {
    return (
      <Chip
        icon={<CheckCircleIcon />}
        label="Link sent"
        size="small"
        color="success"
        variant="outlined"
      />
    );
  }

  return (
    <Tooltip
      title={state === 'error' ? errorMsg : ''}
      placement="top"
      arrow
    >
      <span>
        <Button
          size="small"
          variant="outlined"
          color={state === 'error' ? 'error' : 'primary'}
          startIcon={state === 'loading'
            ? <CircularProgress size={13} color="inherit" />
            : <SendIcon fontSize="small" />
          }
          disabled={state === 'loading'}
          onClick={handleResend}
          sx={{ fontSize: '0.75rem', py: 0.4 }}
          data-testid="resend-link-btn"
        >
          {state === 'error' ? 'Retry' : 'Resend link'}
        </Button>
      </span>
    </Tooltip>
  );
}

// ── Submission card ───────────────────────────────────────────────────────────

function SubmissionCard({ sub, contactId, canResend, onResendSuccess }: {
  sub: Submission;
  contactId: string;
  canResend: boolean;
  onResendSuccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isPending = !sub.submitted_at;
  const isExpired = isPending && new Date(sub.expires_at) < new Date();

  const statusChip = isPending ? (
    isExpired
      ? <Chip icon={<HourglassBottomIcon />} label="Link expired" size="small" color="warning" variant="outlined" />
      : <Chip icon={<HourglassBottomIcon />} label="Awaiting submission" size="small" color="default" variant="outlined" />
  ) : (
    <Chip icon={<CheckCircleIcon />} label="Submitted" size="small" color="success" variant="outlined" />
  );

  const address = [sub.address_line1, sub.city, sub.postcode].filter(Boolean).join(', ');

  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        overflow: 'hidden',
        bgcolor: '#fff',
      }}
    >
      {/* Header row */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 2,
          py: 1.5,
          gap: 1,
        }}
      >
        <Box
          onClick={() => setOpen(v => !v)}
          sx={{
            display: 'flex',
            alignItems: 'center',
            flex: 1,
            cursor: 'pointer',
            gap: 1,
            minWidth: 0,
            '&:hover .expand-icon': { color: 'text.secondary' },
          }}
        >
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              Sent {fmtDate(sub.created_at)}
            </Typography>
            {statusChip}
          </Stack>
          {open
            ? <ExpandLessIcon className="expand-icon" fontSize="small" sx={{ color: 'text.disabled', ml: 'auto', flexShrink: 0 }} />
            : <ExpandMoreIcon className="expand-icon" fontSize="small" sx={{ color: 'text.disabled', ml: 'auto', flexShrink: 0 }} />
          }
        </Box>

        {/* Resend button — only for non-viewer roles */}
        {canResend && (
          <Box sx={{ flexShrink: 0 }}>
            <ResendButton contactId={contactId} onSuccess={onResendSuccess} />
          </Box>
        )}
      </Box>

      {/* Expanded detail */}
      <Collapse in={open}>
        <Divider />
        <Box sx={{ px: 2, py: 2 }}>
          {isPending ? (
            <Typography variant="body2" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
              {isExpired
                ? 'The customer did not complete this form before the link expired.'
                : 'Waiting for the customer to complete the form.'}
            </Typography>
          ) : (
            <Stack spacing={2}>
              {sub.submitted_at && (
                <Typography variant="caption" color="text.secondary">
                  Submitted {fmtDate(sub.submitted_at)}
                  {(sub.corrected_email || sub.corrected_mobile) && ' · Customer provided corrections'}
                </Typography>
              )}

              {/* Address */}
              {address && (
                <Box>
                  <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', display: 'block', mb: 0.25 }}>
                    Address
                  </Typography>
                  <Typography variant="body2">{address}</Typography>
                </Box>
              )}

              {/* Corrections */}
              {(sub.corrected_email || sub.corrected_mobile) && (
                <Box>
                  <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', display: 'block', mb: 0.25 }}>
                    Contact corrections
                  </Typography>
                  {sub.corrected_email  && <Typography variant="body2">Email: {sub.corrected_email}</Typography>}
                  {sub.corrected_mobile && <Typography variant="body2">Mobile: {sub.corrected_mobile}</Typography>}
                </Box>
              )}

              {/* Rooms */}
              {sub.room_count && (
                <Box>
                  <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', display: 'block', mb: 0.25 }}>
                    Rooms
                  </Typography>
                  <Typography variant="body2">{roomLabel(sub.room_count)}</Typography>
                </Box>
              )}

              {/* Notes */}
              {sub.room_notes && (
                <Box>
                  <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', display: 'block', mb: 0.25 }}>
                    Notes
                  </Typography>
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                    {sub.room_notes}
                  </Typography>
                </Box>
              )}

              {/* Photos */}
              {sub.photoUrls && sub.photoUrls.length > 0 && (
                <Box>
                  <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', display: 'block', mb: 0.75 }}>
                    Photos ({sub.photoUrls.length})
                  </Typography>
                  {sub.email_skipped_count > 0 && (
                    <Alert severity="warning" sx={{ mb: 1, py: 0.5, fontSize: '0.75rem' }}>
                      {sub.email_skipped_count} photo{sub.email_skipped_count === 1 ? ' was' : 's were'} too large to attach to the admin email — {sub.email_skipped_count === 1 ? 'it is' : 'they are'} still viewable here.
                    </Alert>
                  )}
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
                      gap: 1,
                    }}
                  >
                    {sub.photoUrls.map((url, i) => (
                      <Box
                        key={i}
                        component="a"
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        sx={{
                          display: 'block',
                          borderRadius: 1.5,
                          overflow: 'hidden',
                          aspectRatio: '1',
                          bgcolor: 'grey.100',
                          border: '1px solid',
                          borderColor: 'divider',
                        }}
                      >
                        <Box
                          component="img"
                          src={url}
                          alt={`Photo ${i + 1}`}
                          sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                          loading="lazy"
                        />
                      </Box>
                    ))}
                  </Box>
                </Box>
              )}
              {(!sub.photoUrls || sub.photoUrls.length === 0) && (
                <Typography variant="body2" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
                  No photos uploaded.
                </Typography>
              )}
            </Stack>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}

// ── Rail ──────────────────────────────────────────────────────────────────────

interface Props {
  contactId: string;
}

export function CustomerInfoSubmissionsRail({ contactId }: Props) {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [open, setOpen]               = useState(true);
  const { isViewer }                  = usePrivilege();

  const loadSubmissions = useCallback(() => {
    if (!contactId) return;
    setLoading(true);
    setError('');
    fetch(`/api/customer-info/by-contact/${encodeURIComponent(contactId)}`, { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json() as Submission[];
        setSubmissions(d);
      })
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [contactId]);

  useEffect(() => {
    loadSubmissions();
  }, [loadSubmissions]);

  if (!loading && !error && submissions.length === 0) return null;

  return (
    <Box
      id="customer-info-submissions-section"
      sx={{ mb: 3 }}
    >
      {/* Section header */}
      <Box
        onClick={() => setOpen(v => !v)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          mb: open ? 1.5 : 0,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <HomeIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
        <Typography variant="subtitle2" sx={{ fontWeight: 600, flex: 1 }}>
          Customer Info
          {submissions.length > 0 && (
            <Typography component="span" variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>
              ({submissions.length})
            </Typography>
          )}
        </Typography>
        {open
          ? <ExpandLessIcon fontSize="small" sx={{ color: 'text.disabled' }} />
          : <ExpandMoreIcon fontSize="small" sx={{ color: 'text.disabled' }} />
        }
      </Box>

      <Collapse in={open}>
        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={20} />
          </Box>
        )}
        {error && (
          <Typography variant="caption" color="error">
            Could not load submissions: {error}
          </Typography>
        )}
        {!loading && !error && (
          <Stack spacing={1.5}>
            {submissions.map(sub => (
              <SubmissionCard
                key={sub.id}
                sub={sub}
                contactId={contactId}
                canResend={!isViewer}
                onResendSuccess={loadSubmissions}
              />
            ))}
          </Stack>
        )}
      </Collapse>
    </Box>
  );
}
