import React, { useCallback, useEffect, useRef, useState } from 'react';
import { OPEN_DEAL_DRAFT_PREFIX } from '../../constants/localStorageKeys';
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
import FormGroup from '@mui/material/FormGroup';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import EditIcon from '@mui/icons-material/Edit';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { POST } from '../../utils/api';
import { dispatchCardActionHandler } from '../../utils/dispatchCardActionHandler';
import { LEAD_STATUS_REMOVED_MESSAGE } from '../../utils/api';
import { broadcastLeadStatusChange } from '../../utils/broadcastLeadStatus';
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
  | 'amend_hub'
  | 'accept_pick'
  | 'accept_confirm'
  | 'accept_submitting'
  | 'decline_confirm'
  | 'decline_email'
  | 'decline_submitting'
  | 'done';

interface QbEstimate {
  id: string;
  docNumber: string | null;
  txnDate: string | null;
  totalAmt: number;
  txnStatus: string;
  billEmail: string | null;
  customerRef: string | null;
}

interface ContactData {
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  contactMobile: string;
  contactAddress: string;
  depositPercent: number;
  qbConnected: boolean;
  estimates: QbEstimate[];
}

interface DraftState {
  step: Step;
  selectedEstimateId: string | null;
  otherEstimateIdsToDecline: string[];
  estimateIdsToDeclineOnDecline: string[];
  sendThankYou: boolean;
}

interface AcceptResult {
  ok?: boolean;
  error?: string;
  invoiceId?: string;
  invoiceDocNum?: string | null;
  hs_lead_status?: string;
  steps?: Record<string, boolean>;
  code?: string;
  removedKey?: string;
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
}

function EstimateTxnStatusChip({ status }: { status: string }) {
  const lower = (status || '').toLowerCase();
  const color =
    lower === 'accepted' ? 'success'
    : lower === 'rejected' || lower === 'closed' ? 'error'
    : 'default';
  return (
    <Chip
      label={status || 'Pending'}
      size="small"
      color={color as 'success' | 'error' | 'default'}
      variant="outlined"
      sx={{ ml: 1, textTransform: 'capitalize' }}
    />
  );
}

const PENDING_STATUSES = new Set(['', 'pending']);

function isPending(status: string) {
  return PENDING_STATUSES.has((status || '').toLowerCase());
}

export function OpenDealActionModal({ handler, ctx, open, onClose }: Props) {
  const { contactId, contactName: ctxContactName } = ctx;
  const draftKey = `${OPEN_DEAL_DRAFT_PREFIX}${contactId}`;

  const [step, setStep] = useState<Step>('loading');
  const [contactData, setContactData] = useState<ContactData | null>(null);
  const [loadError, setLoadError] = useState('');

  // Accept-path state
  const [selectedEstimateId, setSelectedEstimateId] = useState<string | null>(null);
  const [otherEstimateIdsToDecline, setOtherEstimateIdsToDecline] = useState<string[]>([]);
  const [acceptConfirmed, setAcceptConfirmed] = useState(false);
  const [acceptResult, setAcceptResult] = useState<AcceptResult | null>(null);
  const [acceptError, setAcceptError] = useState('');

  // Decline-path state
  const [estimateIdsToDeclineOnDecline, setEstimateIdsToDeclineOnDecline] = useState<string[]>([]);
  const [declineConfirmed, setDeclineConfirmed] = useState(false);
  const [sendThankYou, setSendThankYou] = useState(false);
  const [declineError, setDeclineError] = useState('');

  // Decline email preview state
  const [declineEmailPreview, setDeclineEmailPreview] = useState<{
    subject: string;
    bodyText: string;
    loading: boolean;
    error: boolean;
  }>({ subject: '', bodyText: '', loading: false, error: false });

  const hasMounted = useRef(false);

  // ── Draft persistence ───────────────────────────────────────────────────────
  function saveDraft(updates: Partial<DraftState>) {
    try {
      const existing: DraftState = JSON.parse(sessionStorage.getItem(draftKey) || '{}') as DraftState;
      sessionStorage.setItem(draftKey, JSON.stringify({ ...existing, ...updates }));
    } catch {}
  }

  function clearDraft() {
    try { sessionStorage.removeItem(draftKey); } catch {}
  }

  function loadDraft(): DraftState | null {
    try {
      const raw = sessionStorage.getItem(draftKey);
      return raw ? JSON.parse(raw) as DraftState : null;
    } catch { return null; }
  }

  // Save step/selections to draft whenever they change
  useEffect(() => {
    if (!hasMounted.current) return;
    saveDraft({ step, selectedEstimateId, otherEstimateIdsToDecline, estimateIdsToDeclineOnDecline, sendThankYou });
  }, [step, selectedEstimateId, otherEstimateIdsToDecline, estimateIdsToDeclineOnDecline, sendThankYou]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch live decline email preview when the step becomes visible
  useEffect(() => {
    if (step !== 'decline_email') return;
    let cancelled = false;
    const firstName = contactData?.contactName?.split(' ')[0] || '';
    setDeclineEmailPreview({ subject: '', bodyText: '', loading: true, error: false });
    POST<{ subject: string; body_text: string }>('/api/email-templates/render', {
      key: 'open_deal_declined_thank_you',
      vars: { firstName },
    })
      .then(data => {
        if (cancelled) return;
        setDeclineEmailPreview({ subject: data.subject, bodyText: data.body_text, loading: false, error: false });
      })
      .catch(() => {
        if (cancelled) return;
        setDeclineEmailPreview({ subject: '', bodyText: '', loading: false, error: true });
      });
    return () => { cancelled = true; };
  }, [step, contactData]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load data on open ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    hasMounted.current = true;

    const draft = loadDraft();
    if (draft?.step && draft.step !== 'loading' && draft.step !== 'accept_submitting' && draft.step !== 'decline_submitting') {
      // Restore draft but still load data in background
      if (draft.selectedEstimateId !== undefined) setSelectedEstimateId(draft.selectedEstimateId);
      if (draft.otherEstimateIdsToDecline) setOtherEstimateIdsToDecline(draft.otherEstimateIdsToDecline);
      if (draft.estimateIdsToDeclineOnDecline) setEstimateIdsToDeclineOnDecline(draft.estimateIdsToDeclineOnDecline);
      if (draft.sendThankYou !== undefined) setSendThankYou(draft.sendThankYou);
    }

    let cancelled = false;
    POST<ContactData>('/api/card-actions/open-deal', { contactId })
      .then(data => {
        if (cancelled) return;
        setContactData(data);
        // Pre-populate pending estimates for decline
        const pending = (data.estimates || []).filter(e => isPending(e.txnStatus)).map(e => e.id);
        setEstimateIdsToDeclineOnDecline(draft?.estimateIdsToDeclineOnDecline ?? pending);

        if (draft?.step && draft.step !== 'loading' && draft.step !== 'accept_submitting' && draft.step !== 'decline_submitting') {
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

  function navigateTo(s: Step) {
    setStep(s);
    saveDraft({ step: s });
  }

  function handleClose() {
    clearDraft();
    onClose();
  }

  // ── Option 1: open existing flows ──────────────────────────────────────────
  function openUploadPhotos() {
    dispatchCardActionHandler({ id: handler.id, type: 'upload_photos_and_info', config: {} }, ctx);
  }
  function openDesignVisit() {
    dispatchCardActionHandler({ id: handler.id, type: 'start_design_visit', config: {} }, ctx);
  }

  // ── Option 2: accept ───────────────────────────────────────────────────────
  const selectedEstimate = contactData?.estimates.find(e => e.id === selectedEstimateId) ?? null;
  const depositAmt = selectedEstimate
    ? Math.round(selectedEstimate.totalAmt * ((contactData?.depositPercent ?? 10) / 100) * 100) / 100
    : 0;
  const emailMismatch =
    selectedEstimate?.billEmail &&
    contactData?.contactEmail &&
    selectedEstimate.billEmail.toLowerCase() !== contactData.contactEmail.toLowerCase();

  async function handleAccept() {
    if (!selectedEstimateId || !acceptConfirmed) return;
    navigateTo('accept_submitting');
    try {
      const result = await POST<AcceptResult>(
        `/api/quickbooks/contacts/${contactId}/accept-deal`,
        {
          estimateId: selectedEstimateId,
          otherEstimateIdsToDecline,
          contactEmail: contactData?.contactEmail || '',
          contactName:  contactData?.contactName || ctxContactName || '',
        }
      );
      setAcceptResult(result);
      if (result.hs_lead_status) {
        broadcastLeadStatusChange(contactId, { hs_lead_status: result.hs_lead_status });
      }
      clearDraft();
      navigateTo('done');
    } catch (err: unknown) {
      const e = err as { message?: string; body?: AcceptResult };
      const body = e?.body as AcceptResult | undefined;
      if (body?.code === 'LEAD_STATUS_REMOVED') {
        setAcceptError(LEAD_STATUS_REMOVED_MESSAGE);
      } else {
        setAcceptError(body?.error || String(e?.message || 'Something went wrong.'));
        if (body?.steps) {
          setAcceptResult(body);
        }
      }
      navigateTo('accept_confirm');
    }
  }

  // ── Option 3: decline ──────────────────────────────────────────────────────
  async function handleDecline(shouldSendThankYou: boolean) {
    if (!declineConfirmed) return;
    navigateTo('decline_submitting');
    try {
      const result = await POST<{ ok: boolean; hs_lead_status: string; steps: Record<string, boolean> }>(
        `/api/quickbooks/contacts/${contactId}/decline-deal`,
        {
          estimateIds:   estimateIdsToDeclineOnDecline,
          sendThankYou:  shouldSendThankYou,
          contactEmail:  contactData?.contactEmail || '',
          contactName:   contactData?.contactName || ctxContactName || '',
        }
      );
      broadcastLeadStatusChange(contactId, { hs_lead_status: result.hs_lead_status });
      clearDraft();
      handleClose();
    } catch (err: unknown) {
      const e = err as { message?: string; body?: { error?: string; code?: string } };
      const body = e?.body;
      if (body?.code === 'LEAD_STATUS_REMOVED') {
        setDeclineError(LEAD_STATUS_REMOVED_MESSAGE);
      } else {
        setDeclineError(body?.error || String(e?.message || 'Something went wrong.'));
      }
      navigateTo('decline_confirm');
    }
  }

  // ── Title helper ───────────────────────────────────────────────────────────
  function getTitle() {
    switch (step) {
      case 'amend_hub':         return 'Make amendments';
      case 'accept_pick':       return 'Accept deal — Step 1 of 2';
      case 'accept_confirm':    return 'Accept deal — Step 2 of 2';
      case 'accept_submitting': return 'Accepting deal…';
      case 'decline_confirm':   return 'Decline deal — Step 1 of 2';
      case 'decline_email':     return 'Decline deal — Step 2 of 2';
      case 'decline_submitting':return 'Declining deal…';
      case 'done':              return 'Deal accepted';
      default:                  return 'Open deal';
    }
  }

  const displayName = contactData?.contactName || ctxContactName || '';

  // ── Render helpers ─────────────────────────────────────────────────────────
  function renderContactHeader(opts?: { loading?: boolean }) {
    return (
      <ModalContactHeader
        name={displayName}
        phone={contactData?.contactPhone}
        mobile={contactData?.contactMobile}
        email={contactData?.contactEmail}
        address={contactData?.contactAddress}
        loading={opts?.loading || step === 'loading' || (step !== 'hub' && !contactData)}
      />
    );
  }

  function renderStepLoading() {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 140 }}>
        <CircularProgress size={36} />
      </Box>
    );
  }

  function renderHub() {
    return (
      <Stack spacing={2}>
        {renderContactHeader()}
        {loadError && <Alert severity="warning" sx={{ mt: 1 }}>{loadError}</Alert>}
        {!contactData?.qbConnected && (
          <Alert severity="info" sx={{ mt: 0 }}>
            QuickBooks is not connected — the accept deal flow requires a QuickBooks connection.
          </Alert>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ pt: 0.5 }}>
          What would you like to do with this deal?
        </Typography>
        <Stack spacing={1.5}>
          <Button
            variant="outlined"
            fullWidth
            sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1.5 }}
            startIcon={<EditIcon />}
            onClick={() => navigateTo('amend_hub')}
          >
            <Box>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>Make amendments</Typography>
              <Typography variant="caption" color="text.secondary">
                Upload photos, revise the design or the estimate
              </Typography>
            </Box>
          </Button>
          <Tooltip
            title={!contactData?.qbConnected ? 'QuickBooks must be connected to accept a deal' : ''}
            disableHoverListener={contactData?.qbConnected}
          >
            <span style={{ width: '100%' }}>
              <Button
                variant="contained"
                color="success"
                fullWidth
                disabled={!contactData?.qbConnected}
                sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1.5 }}
                startIcon={<ThumbUpIcon />}
                onClick={() => navigateTo('accept_pick')}
              >
                <Box>
                  <Typography variant="body1" sx={{ fontWeight: 600 }}>Accept deal</Typography>
                  <Typography variant="caption" sx={{ opacity: 0.85 }}>
                    Create & send a deposit invoice → lead moves to DEPOSIT_INVOICE
                  </Typography>
                </Box>
              </Button>
            </span>
          </Tooltip>
          <Button
            variant="outlined"
            color="error"
            fullWidth
            sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1.5 }}
            startIcon={<ThumbDownIcon />}
            onClick={() => navigateTo('decline_confirm')}
          >
            <Box>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>Not interested</Typography>
              <Typography variant="caption" color="text.secondary">
                Decline open estimates → lead moves to DECLINED_DEAL
              </Typography>
            </Box>
          </Button>
        </Stack>
      </Stack>
    );
  }

  function renderAmendHub() {
    return (
      <Stack spacing={2}>
        {renderContactHeader()}
        <Typography variant="body2" color="text.secondary" sx={{ pt: 0.5 }}>
          Choose what to amend:
        </Typography>
        <Stack spacing={1.5}>
          <Button
            variant="outlined"
            fullWidth
            sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1.5 }}
            startIcon={<PhotoCameraIcon />}
            onClick={openUploadPhotos}
          >
            <Box>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>Upload new photos</Typography>
              <Typography variant="caption" color="text.secondary">
                Email customer a new photo upload link
              </Typography>
            </Box>
          </Button>
          <Button
            variant="outlined"
            fullWidth
            sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1.5 }}
            startIcon={<AutoFixHighIcon />}
            onClick={openDesignVisit}
          >
            <Box>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>Amend the design visit</Typography>
              <Typography variant="caption" color="text.secondary">
                Re-opens the design visit wizard
              </Typography>
            </Box>
          </Button>
          <Button
            variant="outlined"
            fullWidth
            component={Link}
            href="/invoices"
            sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1.5 }}
            startIcon={<OpenInNewIcon />}
          >
            <Box>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>Amend estimate in QuickBooks</Typography>
              <Typography variant="caption" color="text.secondary">
                Opens the QuickBooks estimates &amp; invoices page
              </Typography>
            </Box>
          </Button>
        </Stack>
      </Stack>
    );
  }

  function renderAcceptPick() {
    const estimates = contactData?.estimates ?? [];
    const pendingEstimates = estimates.filter(e => isPending(e.txnStatus));
    const otherPending = estimates.filter(e => isPending(e.txnStatus) && e.id !== selectedEstimateId);

    return (
      <Stack spacing={2}>
        {renderContactHeader()}
        <Typography variant="subtitle2" color="text.secondary" sx={{ pt: 0.5 }}>
          Select which estimate is being accepted:
        </Typography>
        {estimates.length === 0 ? (
          <Alert severity="info">No estimates found in QuickBooks for this contact.</Alert>
        ) : (
          <RadioGroup
            value={selectedEstimateId ?? ''}
            onChange={(_e, val) => {
              setSelectedEstimateId(val);
              // Remove newly-selected from "decline others" list
              setOtherEstimateIdsToDecline(prev => prev.filter(id => id !== val));
            }}
          >
            <Stack spacing={0.5}>
              {estimates.map(est => (
                <Box
                  key={est.id}
                  sx={{
                    border: 1,
                    borderColor: selectedEstimateId === est.id ? 'primary.main' : 'divider',
                    borderRadius: 1,
                    px: 1.5,
                    py: 1,
                    cursor: isPending(est.txnStatus) ? 'pointer' : 'not-allowed',
                    opacity: isPending(est.txnStatus) ? 1 : 0.55,
                    bgcolor: selectedEstimateId === est.id ? 'primary.50' : 'transparent',
                  }}
                  onClick={() => isPending(est.txnStatus) && setSelectedEstimateId(est.id)}
                >
                  <FormControlLabel
                    value={est.id}
                    control={<Radio size="small" disabled={!isPending(est.txnStatus)} />}
                    label={
                      <Stack sx={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 0.5 }}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {est.docNumber ? `Estimate #${est.docNumber}` : `ID ${est.id}`}
                        </Typography>
                        {est.txnDate && (
                          <Typography variant="caption" color="text.secondary">
                            · {new Date(est.txnDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </Typography>
                        )}
                        <Typography variant="body2" sx={{ fontWeight: 500, ml: 'auto' }}>
                          {formatCurrency(est.totalAmt)}
                        </Typography>
                        <EstimateTxnStatusChip status={est.txnStatus} />
                      </Stack>
                    }
                    sx={{ m: 0, width: '100%' }}
                  />
                </Box>
              ))}
            </Stack>
          </RadioGroup>
        )}

        {selectedEstimateId && otherPending.length > 0 && (
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
              Also decline these other pending estimates?
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              Confirm with the customer first — this marks them as Rejected in QuickBooks.
            </Typography>
            <FormGroup>
              {otherPending.map(est => (
                <FormControlLabel
                  key={est.id}
                  control={
                    <Checkbox
                      size="small"
                      checked={otherEstimateIdsToDecline.includes(est.id)}
                      onChange={(_e, checked) => {
                        setOtherEstimateIdsToDecline(prev =>
                          checked ? [...prev, est.id] : prev.filter(id => id !== est.id)
                        );
                      }}
                    />
                  }
                  label={
                    <Typography variant="body2">
                      {est.docNumber ? `Estimate #${est.docNumber}` : `ID ${est.id}`}
                      {' '}— {formatCurrency(est.totalAmt)}
                    </Typography>
                  }
                />
              ))}
            </FormGroup>
          </Box>
        )}
      </Stack>
    );
  }

  function renderAcceptConfirm() {
    const pct = contactData?.depositPercent ?? 10;
    return (
      <Stack spacing={2}>
        {renderContactHeader()}
        <Typography variant="subtitle2" color="text.secondary" sx={{ pt: 0.5 }}>
          Review before sending the deposit invoice:
        </Typography>
        {acceptError && (
          <Alert severity="error" onClose={() => setAcceptError('')}>
            {acceptError}
            {acceptResult?.steps && (
              <Box sx={{ mt: 0.75 }}>
                <Typography variant="caption">Completed steps: {
                  Object.entries(acceptResult.steps)
                    .filter(([, v]) => v)
                    .map(([k]) => k)
                    .join(', ') || 'none'
                }</Typography>
              </Box>
            )}
          </Alert>
        )}
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}>
          <Stack spacing={1}>
            <Stack sx={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Typography variant="body2" color="text.secondary">Customer</Typography>
              <Typography variant="body2">{displayName || '—'}</Typography>
            </Stack>
            <Stack sx={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Typography variant="body2" color="text.secondary">Contact email</Typography>
              <Typography variant="body2">{contactData?.contactEmail || '—'}</Typography>
            </Stack>
            {emailMismatch && (
              <Alert severity="warning" icon={<WarningAmberIcon fontSize="small" />} sx={{ py: 0.25 }}>
                The contact email above differs from the QuickBooks estimate email (<strong>{selectedEstimate?.billEmail}</strong>).
                Please confirm this is correct before sending.
              </Alert>
            )}
            <Divider />
            <Stack sx={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Typography variant="body2" color="text.secondary">Estimate</Typography>
              <Typography variant="body2">
                {selectedEstimate?.docNumber ? `#${selectedEstimate.docNumber}` : `ID ${selectedEstimateId}`}
              </Typography>
            </Stack>
            <Stack sx={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Typography variant="body2" color="text.secondary">Estimate total (VAT inc.)</Typography>
              <Typography variant="body2">{formatCurrency(selectedEstimate?.totalAmt ?? 0)}</Typography>
            </Stack>
            <Stack sx={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>Deposit ({pct}%)</Typography>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{formatCurrency(depositAmt)}</Typography>
            </Stack>
          </Stack>
        </Box>
        {otherEstimateIdsToDecline.length > 0 && (
          <Alert severity="info" sx={{ py: 0.25 }}>
            {otherEstimateIdsToDecline.length} other estimate{otherEstimateIdsToDecline.length > 1 ? 's' : ''} will be marked
            as Rejected in QuickBooks.
          </Alert>
        )}
        <FormControlLabel
          control={
            <Checkbox
              checked={acceptConfirmed}
              onChange={(_e, c) => setAcceptConfirmed(c)}
            />
          }
          label={
            <Typography variant="body2">
              I have confirmed this is the correct customer and estimate, and I am ready to send the deposit invoice.
            </Typography>
          }
        />
      </Stack>
    );
  }

  function renderAcceptSubmitting() {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, py: 2 }}>
        <CircularProgress size={40} />
        <Typography variant="body2" color="text.secondary">
          Creating invoice, sending to customer, and updating lead status…
        </Typography>
      </Box>
    );
  }

  function renderDeclineConfirm() {
    const estimates = contactData?.estimates ?? [];
    const pendingEstimates = estimates.filter(e => isPending(e.txnStatus));
    return (
      <Stack spacing={2}>
        {renderContactHeader()}
        {declineError && (
          <Alert severity="error" onClose={() => setDeclineError('')}>{declineError}</Alert>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ pt: 0.5 }}>
          This will move the lead status to <strong>DECLINED_DEAL</strong>.
        </Typography>
        {contactData?.qbConnected && pendingEstimates.length > 0 && (
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.75 }}>
              Mark these estimates as Rejected in QuickBooks:
            </Typography>
            <FormGroup>
              {pendingEstimates.map(est => (
                <FormControlLabel
                  key={est.id}
                  control={
                    <Checkbox
                      size="small"
                      checked={estimateIdsToDeclineOnDecline.includes(est.id)}
                      onChange={(_e, checked) => {
                        setEstimateIdsToDeclineOnDecline(prev =>
                          checked ? [...prev, est.id] : prev.filter(id => id !== est.id)
                        );
                      }}
                    />
                  }
                  label={
                    <Typography variant="body2">
                      {est.docNumber ? `Estimate #${est.docNumber}` : `ID ${est.id}`}
                      {' '}— {formatCurrency(est.totalAmt)}
                    </Typography>
                  }
                />
              ))}
            </FormGroup>
          </Box>
        )}
        {!contactData?.qbConnected && (
          <Alert severity="info" sx={{ py: 0.25 }}>
            QuickBooks is not connected — estimates will not be updated.
          </Alert>
        )}
        <FormControlLabel
          control={
            <Checkbox
              checked={declineConfirmed}
              onChange={(_e, c) => setDeclineConfirmed(c)}
            />
          }
          label={
            <Typography variant="body2">
              I confirm I want to mark this deal as declined.
            </Typography>
          }
        />
      </Stack>
    );
  }

  function renderDeclineEmail() {
    const { subject, bodyText, loading: previewLoading, error: previewError } = declineEmailPreview;
    return (
      <Stack spacing={2}>
        {renderContactHeader()}
        <Typography variant="body2" color="text.secondary" sx={{ pt: 0.5 }}>
          Would you like to send the customer a brief thank-you email?
        </Typography>
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2, bgcolor: 'background.default' }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            Template: <em>open_deal_declined_thank_you</em>
            {subject ? <> — <strong>{subject}</strong></> : null}
          </Typography>
          {previewLoading && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5 }}>
              <CircularProgress size={14} />
              <Typography variant="body2" color="text.secondary">Loading preview…</Typography>
            </Box>
          )}
          {!previewLoading && previewError && (
            <Typography variant="body2" color="text.secondary">
              A brief thank-you note will be sent to the customer.
            </Typography>
          )}
          {!previewLoading && !previewError && bodyText && (
            bodyText.split('\n').map((line, i) => (
              <Typography key={i} variant="body2" sx={{ mt: i === 0 ? 0 : 0.5 }}>
                {line || <>&nbsp;</>}
              </Typography>
            ))
          )}
        </Box>
        <Alert severity="info" sx={{ py: 0.25 }}>
          Sending to: <strong>{contactData?.contactEmail || '(no email on record)'}</strong>
        </Alert>
      </Stack>
    );
  }

  function renderDeclineSubmitting() {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, py: 2 }}>
        <CircularProgress size={40} />
        <Typography variant="body2" color="text.secondary">
          Declining deal and updating lead status…
        </Typography>
      </Box>
    );
  }

  function renderDone() {
    return (
      <Stack spacing={2} sx={{ alignItems: 'center', py: 1 }}>
        <CheckCircleIcon sx={{ fontSize: 48, color: 'success.main' }} />
        <Typography variant="h6" sx={{ fontWeight: 700 }}>Deposit invoice sent</Typography>
        {acceptResult?.invoiceDocNum && (
          <Typography variant="body2" color="text.secondary">
            Invoice #{acceptResult.invoiceDocNum} created and sent to customer.
          </Typography>
        )}
        <Typography variant="body2" color="text.secondary">
          Lead status has been updated to <strong>DEPOSIT_INVOICE</strong>.
        </Typography>
      </Stack>
    );
  }

  // ── Actions per step ───────────────────────────────────────────────────────
  function renderActions() {
    const submitting = step === 'accept_submitting' || step === 'decline_submitting';
    if (submitting || step === 'loading') return null;

    if (step === 'done') {
      return <Button variant="contained" onClick={handleClose}>Close</Button>;
    }

    if (step === 'hub' || step === 'amend_hub') {
      return <Button onClick={handleClose}>Close</Button>;
    }

    if (step === 'accept_pick') {
      return (
        <>
          <Button onClick={() => navigateTo('hub')} startIcon={<ArrowBackIcon />}>Back</Button>
          <Box sx={{ flex: 1 }} />
          <Button
            variant="contained"
            disabled={!selectedEstimateId}
            onClick={() => navigateTo('accept_confirm')}
          >
            Next
          </Button>
        </>
      );
    }

    if (step === 'accept_confirm') {
      return (
        <>
          <Button onClick={() => navigateTo('accept_pick')} startIcon={<ArrowBackIcon />}>Back</Button>
          <Box sx={{ flex: 1 }} />
          <Button
            variant="contained"
            color="success"
            disabled={!acceptConfirmed}
            onClick={handleAccept}
          >
            Confirm & Send Invoice
          </Button>
        </>
      );
    }

    if (step === 'decline_confirm') {
      return (
        <>
          <Button onClick={() => navigateTo('hub')} startIcon={<ArrowBackIcon />}>Back</Button>
          <Box sx={{ flex: 1 }} />
          <Button
            variant="contained"
            color="error"
            disabled={!declineConfirmed}
            onClick={() => navigateTo('decline_email')}
          >
            Continue
          </Button>
        </>
      );
    }

    if (step === 'decline_email') {
      return (
        <>
          <Button onClick={() => navigateTo('decline_confirm')} startIcon={<ArrowBackIcon />}>Back</Button>
          <Box sx={{ flex: 1 }} />
          <Button
            onClick={() => handleDecline(false)}
            sx={{ mr: 1 }}
          >
            Skip
          </Button>
          <Button
            variant="contained"
            disabled={!contactData?.contactEmail}
            onClick={() => handleDecline(true)}
          >
            Send &amp; Close
          </Button>
        </>
      );
    }

    return null;
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function renderContent() {
    switch (step) {
      case 'loading':          return renderStepLoading();
      case 'hub':              return renderHub();
      case 'amend_hub':        return renderAmendHub();
      case 'accept_pick':      return renderAcceptPick();
      case 'accept_confirm':   return renderAcceptConfirm();
      case 'accept_submitting':return renderAcceptSubmitting();
      case 'decline_confirm':  return renderDeclineConfirm();
      case 'decline_email':    return renderDeclineEmail();
      case 'decline_submitting':return renderDeclineSubmitting();
      case 'done':             return renderDone();
      default:                 return null;
    }
  }

  const showBackHeader = ['amend_hub', 'accept_pick', 'accept_confirm', 'decline_confirm', 'decline_email'].includes(step);
  const isSubmitting   = step === 'accept_submitting' || step === 'decline_submitting';
  const actions        = renderActions();

  return (
    <Dialog open={open} onClose={isSubmitting ? undefined : handleClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 1 }}>
        {showBackHeader && (
          <IconButton size="small" onClick={() => {
            if (step === 'amend_hub')       navigateTo('hub');
            else if (step === 'accept_pick')     navigateTo('hub');
            else if (step === 'accept_confirm')  navigateTo('accept_pick');
            else if (step === 'decline_confirm') navigateTo('hub');
            else if (step === 'decline_email')   navigateTo('decline_confirm');
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
