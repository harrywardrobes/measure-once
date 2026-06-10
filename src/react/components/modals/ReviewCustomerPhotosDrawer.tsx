import React, { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';
import { cacheRecord, readRecord } from '../../lib/offlineDb';
import { LEAD_STATUS_REMOVED_MESSAGE } from '../../utils/api';
import { useDiscardGuard } from '../../hooks/useDiscardGuard';
import { DiscardConfirmDialog } from './DiscardConfirmDialog';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Submission {
  id: number;
  contactId: string;
  contactName: string | null;
  contactEmail: string | null;
  maskedEmail: string | null;
  addressLine1: string | null;
  city: string | null;
  postcode: string | null;
  roomCount: string | null;
  roomNotes: string | null;
  correctedEmail: string | null;
  correctedMobile: string | null;
  submittedAt: string | null;
  emailSkippedCount: number;
  photoUrls: string[];
  /** Sync-readiness fields used to conflict-check an offline-queued review. */
  version?: number | null;
  updatedAt?: string | null;
}

type Step = 'loading' | 'no_submission' | 'review' | 'not_suitable' | 'rough_estimate' | 'done';

interface Props {
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
}

// ── Email template defaults ───────────────────────────────────────────────────

function defaultNotSuitableSubject() {
  return 'Regarding your enquiry';
}

function defaultNotSuitableBody(contactName: string | null): string {
  const firstName = contactName ? contactName.split(' ')[0] : '';
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  return [
    greeting,
    '',
    'Thank you so much for getting in touch with us and sharing details about your home.',
    '',
    "Unfortunately, after reviewing your enquiry, we don't think this is a project we'd be able to help with at this time.",
    '',
    "We're sorry we can't be of more help on this occasion, and we wish you all the best in finding the right team for your project.",
    '',
    'Warm regards,',
    'The team',
  ].join('\n');
}

function defaultRoughEstimateSubject() {
  return 'Your rough estimate';
}

function defaultRoughEstimateBody(contactName: string | null, priceRange: string): string {
  const firstName = contactName ? contactName.split(' ')[0] : '';
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const rangeStr = priceRange.trim() || '—';
  return [
    greeting,
    '',
    "Thank you for sharing details about your home — we really appreciate it.",
    '',
    "Based on the information you've provided, our rough estimate for the work is:",
    '',
    `  ${rangeStr}`,
    '',
    'Please note that this is a rough guide only and is subject to change once we have had a chance to see your space in person.',
    '',
    "One of our team will be in touch shortly to arrange a design visit, where we can discuss your project in detail, take accurate measurements, and give you a precise quote.",
    '',
    "We're looking forward to helping you create your dream space!",
    '',
    'Warm regards,',
    'The team',
  ].join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function roomCountLabel(rc: string | null): string {
  if (rc === '1') return '1 room';
  if (rc === '2') return '2 rooms';
  if (rc === '3+') return '3+ rooms';
  return rc || '—';
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <Box sx={{ display: 'flex', gap: 1.5, mb: 1 }}>
      <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.secondary', minWidth: 100, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.primary', wordBreak: 'break-word' }}>
        {value || '—'}
      </Typography>
    </Box>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ReviewCustomerPhotosDrawer({ handler: _handler, ctx, open, onClose }: Props) {
  const [step, setStep] = useState<Step>('loading');
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [fetchError, setFetchError] = useState('');
  // True when the submission is rendered from the offline IndexedDB cache
  // because the network fetch failed (e.g. the device is offline).
  const [fromCache, setFromCache] = useState(false);

  const [priceRange, setPriceRange] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const hasUnsavedChanges =
    step !== 'done' &&
    step !== 'loading' &&
    (emailSubject.trim() !== '' || emailBody.trim() !== '' || priceRange.trim() !== '');

  // Fetch submission when drawer opens
  useEffect(() => {
    if (!open) return;
    setStep('loading');
    setSubmission(null);
    setFetchError('');
    setFromCache(false);
    setSubmitError('');
    setPriceRange('');
    setEmailSubject('');
    setEmailBody('');

    fetch(`/api/card-actions/review-customer-photos/${encodeURIComponent(ctx.contactId)}`)
      .then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || d.message || 'Failed to fetch');
        return d;
      })
      .then(d => {
        if (!d.submission) {
          setStep('no_submission');
          return;
        }
        setSubmission(d.submission);
        // Write-through to the offline store (best-effort, never blocks the UI).
        void cacheRecord('photos', ctx.contactId, d.submission);
        setStep('review');
      })
      .catch(async e => {
        // Offline fallback: render the saved submission from IndexedDB instead
        // of an error state when the network fetch fails.
        const cached = await readRecord<Submission>('photos', ctx.contactId);
        if (cached) {
          setSubmission(cached);
          setFromCache(true);
          setStep('review');
          return;
        }
        setFetchError((e as Error).message);
        setStep('loading');
      });
  }, [open, ctx.contactId]);

  function handleNotSuitableClick() {
    setEmailSubject(defaultNotSuitableSubject());
    setEmailBody(defaultNotSuitableBody(submission?.contactName ?? null));
    setSubmitError('');
    setStep('not_suitable');
  }

  function handleRoughEstimateClick() {
    setPriceRange('');
    setEmailSubject(defaultRoughEstimateSubject());
    setEmailBody(defaultRoughEstimateBody(submission?.contactName ?? null, ''));
    setSubmitError('');
    setStep('rough_estimate');
  }

  // Update body when price range changes (only if body is still the default)
  function handlePriceRangeChange(val: string) {
    setPriceRange(val);
    const currentDefault = defaultRoughEstimateBody(submission?.contactName ?? null, priceRange);
    if (emailBody === currentDefault || emailBody === defaultRoughEstimateBody(submission?.contactName ?? null, '')) {
      setEmailBody(defaultRoughEstimateBody(submission?.contactName ?? null, val));
    }
  }

  async function handleConfirm(outcome: 'not_suitable' | 'rough_estimate_sent') {
    setSubmitError('');
    if (!emailSubject.trim()) {
      setSubmitError('Email subject is required.');
      return;
    }
    if (!emailBody.trim()) {
      setSubmitError('Email body is required.');
      return;
    }
    if (outcome === 'rough_estimate_sent' && !priceRange.trim()) {
      setSubmitError('Price range is required.');
      return;
    }

    setSubmitting(true);
    try {
      // Offline-aware write: sent immediately when online, otherwise parked in
      // the offline queue (area 'photo') and replayed on reconnect. The queued
      // entry carries `submissionId`/`contactId` in the body and a
      // `customer-info:<id>` recordKey so a resulting conflict's "Open record"
      // link resolves to the right submission. A `conflictCheckUrl` + base
      // version/updated_at let the sync engine flag the case where the
      // submission changed on the server before this review replayed.
      const { sendOrQueue } = await import('../../lib/offlineQueue');
      const res = await sendOrQueue({
        area: 'photo',
        label: outcome === 'not_suitable'
          ? `Photo review → not suitable (${contactDisplay})`
          : `Photo review → rough estimate (${contactDisplay})`,
        method: 'POST',
        url: '/api/card-actions/review-customer-photos',
        body: {
          contactId:    ctx.contactId,
          submissionId: submission!.id,
          outcome,
          priceRange:   priceRange.trim() || undefined,
          emailSubject: emailSubject.trim(),
          emailBody:    emailBody.trim(),
        },
        recordKey: `customer-info:${submission!.id}`,
        conflictCheckUrl: `/api/card-actions/review-customer-photos/${encodeURIComponent(ctx.contactId)}`,
        baseVersion: submission!.version ?? null,
        baseUpdatedAt: submission!.updatedAt ?? null,
      });

      // Surface only genuine server rejections (4xx). A queued write is success
      // from the user's perspective — it will replay on reconnect.
      if (!res.queued && !res.ok) {
        const d = res.data as { error?: string; message?: string; code?: string } | undefined;
        if (d?.code === 'LEAD_STATUS_REMOVED') {
          throw new Error(LEAD_STATUS_REMOVED_MESSAGE);
        }
        throw new Error(d?.error || d?.message || 'Failed');
      }

      setStep('done');

      // Notify other tabs that lead status changed
      if (typeof BroadcastChannel !== 'undefined') {
        try {
          const bc = new BroadcastChannel('hs_lead_status_changed');
          bc.postMessage({ contactIds: [ctx.contactId] });
          bc.close();
        } catch { /* ignore */ }
      }
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose() {
    setStep('loading');
    setSubmission(null);
    setFetchError('');
    setSubmitError('');
    onClose();
  }

  const { confirmOpen: confirmDiscardOpen, handleRequestClose, setConfirmOpen: setConfirmDiscardOpen } = useDiscardGuard(
    hasUnsavedChanges,
    handleClose,
    submitting,
  );

  const contactDisplay  = ctx.contactName || submission?.contactName || 'Customer';
  // Show masked email in the UI; the actual send target is resolved server-side from the submission record
  const emailDisplay    = submission?.maskedEmail || ctx.contactEmail || '';

  return (
    <>
    <Drawer
      anchor="right"
      open={open}
      onClose={handleRequestClose}
      slotProps={{ paper: { sx: { width: { xs: '100%', sm: 480 }, p: 0 } } }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

        {/* Header */}
        <Box sx={{ px: 3, pt: 3, pb: 2, borderBottom: '1px solid', borderColor: 'divider', flexShrink: 0 }}>
          {(step === 'not_suitable' || step === 'rough_estimate') ? (
            <Button
              size="small"
              startIcon={<ArrowBackIcon />}
              onClick={() => { setStep('review'); setSubmitError(''); }}
              sx={{ mb: 1, ml: -0.5, color: 'text.secondary' }}
            >
              Back
            </Button>
          ) : null}
          <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.3 }}>
            {step === 'not_suitable'   ? 'Not Suitable — confirm email' :
             step === 'rough_estimate' ? 'Send Rough Estimate' :
             step === 'done'           ? 'Review sent' :
             'Review customer photos'}
          </Typography>
          {step === 'review' && submission && (
            <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.25 }}>
              {contactDisplay}
              {emailDisplay ? ` · ${emailDisplay}` : ''}
            </Typography>
          )}
        </Box>

        {/* Body */}
        <Box sx={{ flex: 1, overflowY: 'auto', px: 3, py: 2.5 }}>

          {/* Loading / fetch error */}
          {step === 'loading' && (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', py: 6, gap: 2 }}>
              {fetchError ? (
                <Alert severity="error" sx={{ width: '100%' }}>{fetchError}</Alert>
              ) : (
                <>
                  <CircularProgress size={28} />
                  <Typography variant="body2" color="text.secondary">Loading submission…</Typography>
                </>
              )}
            </Box>
          )}

          {/* No submission */}
          {step === 'no_submission' && (
            <Alert severity="info" sx={{ mt: 1 }}>
              No submitted information found for this customer yet. Use the{' '}
              <strong>Upload photos &amp; info</strong> action to send them the form first.
            </Alert>
          )}

          {/* Done */}
          {step === 'done' && (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', py: 6, gap: 2, textAlign: 'center' }}>
              <CheckCircleOutlinedIcon sx={{ fontSize: 48, color: 'success.main' }} />
              <Typography variant="h6">Email sent</Typography>
              <Typography variant="body2" color="text.secondary">
                The customer has been emailed and the card status has been updated.
              </Typography>
            </Box>
          )}

          {/* Review step */}
          {step === 'review' && submission && (
            <Stack spacing={2.5}>
              {fromCache && (
                <Alert severity="info" data-testid="review-photos-offline-banner">
                  You&apos;re offline — showing saved data from your last visit. This submission may be out of date.
                </Alert>
              )}
              <Box>
                <Typography variant="overline" color="text.disabled" sx={{ display: 'block', mb: 1 }}>
                  Submitted details
                </Typography>
                <DetailRow label="Address" value={[submission.addressLine1, submission.city, submission.postcode].filter(Boolean).join(', ')} />
                <DetailRow label="Rooms" value={roomCountLabel(submission.roomCount)} />
                {submission.correctedEmail && (
                  <DetailRow label="Email (corrected)" value={submission.correctedEmail} />
                )}
                {submission.correctedMobile && (
                  <DetailRow label="Mobile (corrected)" value={submission.correctedMobile} />
                )}
              </Box>

              {submission.roomNotes && (
                <>
                  <Divider />
                  <Box>
                    <Typography variant="overline" color="text.disabled" sx={{ display: 'block', mb: 1 }}>
                      Notes
                    </Typography>
                    <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', color: 'text.primary' }}>
                      {submission.roomNotes}
                    </Typography>
                  </Box>
                </>
              )}

              {submission.photoUrls.length > 0 && (
                <>
                  <Divider />
                  <Box>
                    <Typography variant="overline" color="text.disabled" sx={{ display: 'block', mb: 1.5 }}>
                      Photos ({submission.photoUrls.length})
                    </Typography>
                    {submission.emailSkippedCount > 0 && (
                      <Alert severity="warning" sx={{ mb: 1.5 }}>
                        {submission.emailSkippedCount} photo{submission.emailSkippedCount === 1 ? ' was' : 's were'} too large to attach to the admin email —{' '}
                        {submission.emailSkippedCount === 1 ? 'it is' : 'they are'}{' '}
                        <a
                          href={submission.photoUrls[0]}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid="skipped-photo-link"
                        >
                          still viewable here
                        </a>.
                      </Alert>
                    )}
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
                        gap: 1,
                      }}
                    >
                      {submission.photoUrls.map((url, i) => (
                        <Box
                          key={i}
                          component="a"
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          sx={{
                            display: 'block',
                            aspectRatio: '1',
                            overflow: 'hidden',
                            borderRadius: 1,
                            border: '1px solid',
                            borderColor: 'divider',
                            bgcolor: 'grey.100',
                          }}
                        >
                          <Box
                            component="img"
                            src={url}
                            alt={`Photo ${i + 1}`}
                            sx={{
                              width: '100%',
                              height: '100%',
                              objectFit: 'cover',
                              display: 'block',
                            }}
                          />
                        </Box>
                      ))}
                    </Box>
                  </Box>
                </>
              )}

              {submission.photoUrls.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                  No photos were uploaded.
                </Typography>
              )}
            </Stack>
          )}

          {/* Not Suitable — confirmation step */}
          {step === 'not_suitable' && (
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary">
                Review and edit the email below before sending. The email will be sent to{' '}
                <strong>{emailDisplay || 'the customer'}</strong>.
              </Typography>
              <TextField
                label="Subject"
                value={emailSubject}
                onChange={e => setEmailSubject(e.target.value)}
                size="small"
                fullWidth
                slotProps={{ htmlInput: { maxLength: 500 } }}
              />
              <TextField
                label="Message"
                value={emailBody}
                onChange={e => setEmailBody(e.target.value)}
                multiline
                minRows={8}
                fullWidth
                slotProps={{ htmlInput: { maxLength: 5000 } }}
              />
              {submitError && (
                <Alert severity="error">{submitError}</Alert>
              )}
            </Stack>
          )}

          {/* Rough Estimate — confirmation step */}
          {step === 'rough_estimate' && (
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary">
                Enter a price range and review the email below before sending. The email will be sent to{' '}
                <strong>{emailDisplay || 'the customer'}</strong>.
              </Typography>
              <TextField
                label="Price range (e.g. £2,500–£3,500)"
                value={priceRange}
                onChange={e => handlePriceRangeChange(e.target.value)}
                size="small"
                fullWidth
                required
                slotProps={{ htmlInput: { maxLength: 200 } }}
                helperText="This will appear in the email body above."
              />
              <TextField
                label="Subject"
                value={emailSubject}
                onChange={e => setEmailSubject(e.target.value)}
                size="small"
                fullWidth
                slotProps={{ htmlInput: { maxLength: 500 } }}
              />
              <TextField
                label="Message"
                value={emailBody}
                onChange={e => setEmailBody(e.target.value)}
                multiline
                minRows={8}
                fullWidth
                slotProps={{ htmlInput: { maxLength: 5000 } }}
              />
              {submitError && (
                <Alert severity="error">{submitError}</Alert>
              )}
            </Stack>
          )}
        </Box>

        {/* Footer actions */}
        {(step === 'review' || step === 'not_suitable' || step === 'rough_estimate' || step === 'done') && (
          <Box
            sx={{
              px: 3,
              py: 2,
              borderTop: '1px solid',
              borderColor: 'divider',
              flexShrink: 0,
              bgcolor: 'background.paper',
            }}
          >
            {step === 'review' && (
              <Stack direction="row" spacing={1.5} sx={{ justifyContent: 'flex-end' }}>
                <Button onClick={handleRequestClose} color="inherit">
                  Cancel
                </Button>
                <Button
                  variant="outlined"
                  color="error"
                  onClick={handleNotSuitableClick}
                  data-testid="cah-not-suitable"
                >
                  Not Suitable
                </Button>
                <Button
                  variant="contained"
                  onClick={handleRoughEstimateClick}
                  data-testid="cah-rough-estimate"
                >
                  Send Rough Estimate
                </Button>
              </Stack>
            )}

            {step === 'not_suitable' && (
              <Stack direction="row" spacing={1.5} sx={{ justifyContent: 'flex-end' }}>
                <Button onClick={() => { setStep('review'); setSubmitError(''); }} disabled={submitting}>
                  Cancel
                </Button>
                <Button
                  variant="contained"
                  color="error"
                  onClick={() => handleConfirm('not_suitable')}
                  disabled={submitting}
                  startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : undefined}
                  data-testid="cah-primary"
                >
                  {submitting ? 'Sending…' : 'Confirm & Send'}
                </Button>
              </Stack>
            )}

            {step === 'rough_estimate' && (
              <Stack direction="row" spacing={1.5} sx={{ justifyContent: 'flex-end' }}>
                <Button onClick={() => { setStep('review'); setSubmitError(''); }} disabled={submitting}>
                  Cancel
                </Button>
                <Button
                  variant="contained"
                  onClick={() => handleConfirm('rough_estimate_sent')}
                  disabled={submitting}
                  startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : undefined}
                  data-testid="cah-primary"
                >
                  {submitting ? 'Sending…' : 'Confirm & Send'}
                </Button>
              </Stack>
            )}

            {step === 'done' && (
              <Stack direction="row" sx={{ justifyContent: 'flex-end' }}>
                <Button variant="contained" onClick={handleClose}>
                  Done
                </Button>
              </Stack>
            )}
          </Box>
        )}
      </Box>
    </Drawer>

    <DiscardConfirmDialog
      open={confirmDiscardOpen}
      onKeepEditing={() => setConfirmDiscardOpen(false)}
      onDiscard={handleClose}
    />
    </>
  );
}
