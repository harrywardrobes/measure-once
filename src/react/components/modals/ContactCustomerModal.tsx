import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { ContactTimelineRow } from '../customer-activity/ContactTimelineRow';
import type { HubspotActivity, ActivityResponse, TimelineItem } from '../customer-activity/timeline';
import { EmailComposer } from './EmailComposer';
import { ApiError, GET, POST, LEAD_STATUS_REMOVED_MESSAGE, isGoogleAuthError, postFormData } from '../../utils/api';
import { GoogleAuthAlert } from '../GoogleAuthAlert';
import { relativeTime } from '../../utils/formatters';
import { buildActivityTooltipContent, type LastAttempt } from '../../utils/activityTooltip';
import { dispatchCardActionHandler } from '../../utils/dispatchCardActionHandler';
import { CONTACT_CUSTOMER_KEY } from '../../utils/handlerMeta';
import { leadStatusConfirmationMessage, leadStatusLabelFor } from '../../utils/leadStatusConfirmation';
import { broadcastLeadStatusChange } from '../../utils/broadcastLeadStatus';
import { sendOrQueue } from '../../lib/offlineQueue';
import { useToastContext } from '../../contexts/ToastContext';
import { usePrivilege } from '../../hooks/usePrivilege';
import { useAuth } from '../../contexts/AuthContext';
import { useDiscardGuard } from '../../hooks/useDiscardGuard';
import { useBeforeUnloadGuard } from '../../hooks/useBeforeUnloadGuard';
import { ModalContactHeader } from './ModalContactHeader';
import { DemoActionTooltip } from './demoMode';
import { DiscardConfirmDialog } from './DiscardConfirmDialog';
import { FullScreenModal } from './FullScreenModal';
import { DEMO_CONTACT } from './demoData';
import { broadcastContactAttemptLogged } from '../../utils/broadcastContactAttempt';
import type { Contact } from '../../pages/customer-detail/types';

const TaskModal = lazy(() =>
  import('./TaskModal').then(m => ({ default: m.TaskModal }))
);

interface Props {
  contactId: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string;
  contactMobile?: string;
  onClose: () => void;
  demo?: boolean;
  /** When true, the email composer opens automatically as soon as contact data loads. */
  openEmail?: boolean;
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

// The unified contact-activity timeline model (HubspotActivity, ActivityResponse,
// TimelineItem) and its row renderer are shared with the customer detail page —
// see src/react/components/customer-activity/.

const CALL_PRESETS = [
  'No answer, voicemail left',
  'No answer, no voicemail',
  'Spoke briefly, will call back',
  'Line busy',
  'No longer interested',
  'Wrong number',
];

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

// "Call Later" deadline slots: the next of 09:00 / 13:00 / 17:00, any day. If
// all of today's slots have passed, fall through to 09:00 the following day.
const CALL_SLOT_HOURS = [9, 13, 17];
function nextCallSlotIso(): string {
  const now = dayjs();
  for (const h of CALL_SLOT_HOURS) {
    const slot = now.hour(h).minute(0).second(0).millisecond(0);
    if (slot.isAfter(now)) return slot.toISOString();
  }
  return now.add(1, 'day').hour(9).minute(0).second(0).millisecond(0).toISOString();
}

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

export function ContactCustomerModal({ contactId, contactName, contactEmail, contactPhone, contactMobile, onClose, demo, openEmail }: Props) {
  const { user: currentUser } = useAuth();
  const { isManager, isAdmin } = usePrivilege();
  const { showToastWithAction } = useToastContext();
  // Lead-status editing (the inline picker on the board) is manager/admin only,
  // so the "Not Suitable" action — which writes hs_lead_status and offers an
  // arbitrary-status Undo via PATCH — is gated the same way.
  const canEditLeadStatus = isManager || isAdmin;

  // Latest known lead status for this contact. Seeded on load and kept current
  // when we auto-advance to ATTEMPTED_TO_CONTACT, so the Not-Suitable Undo
  // reverts to the right prior value.
  const currentLeadStatusRef = useRef<string>('');
  // True once the lead status has been advanced to ATTEMPTED_TO_CONTACT this
  // session (either auto-advanced on the first logged attempt or via Done), so
  // we never issue the advance twice.
  const statusAdvancedRef = useRef(false);
  const [notSuitableSubmitting, setNotSuitableSubmitting] = useState(false);

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

  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [lastAttemptBy, setLastAttemptBy] = useState<string | null>(null);

  const [historySessionCount,   setHistorySessionCount]   = useState(0);
  const [historyTotalAttempts,  setHistoryTotalAttempts]  = useState(0);
  const [historyEverCalled,     setHistoryEverCalled]     = useState(false);
  const [historyEverEmailed,    setHistoryEverEmailed]    = useState(false);
  const [historyEverWhatsapped, setHistoryEverWhatsapped] = useState(false);
  const [historyAttemptLog,     setHistoryAttemptLog]     = useState<HistorySessionEntry[]>([]);

  // Enriched HubSpot activity (lazy-loaded after the modal opens)
  const [activities,          setActivities]          = useState<HubspotActivity[]>([]);
  const [activityLoading,     setActivityLoading]     = useState(false);
  const [activityError,       setActivityError]       = useState(false);
  const [activityUnavailable, setActivityUnavailable] = useState<string[]>([]);
  const [expandedIds,         setExpandedIds]         = useState<Set<string>>(() => new Set());
  const activityFetchedRef = useRef(false);

  // Note panel state — one panel open at a time
  const [openPanel,          setOpenPanel]          = useState<Method | null>(null);
  const [noteText,           setNoteText]           = useState('');
  const [submitting,         setSubmitting]         = useState(false);
  const [submitError,        setSubmitError]        = useState('');
  const [submitErrorRetry,   setSubmitErrorRetry]   = useState(false);

  // Email flow state
  const [emailFlow,            setEmailFlow]            = useState<'idle' | 'preview' | 'sending'>('idle');
  const [emailSubject,         setEmailSubject]         = useState('');
  const [emailBody,            setEmailBody]            = useState('');
  // Stable template baseline — set once on initial load for unsaved-changes detection.
  const [emailTemplateSubject, setEmailTemplateSubject] = useState('');
  const [emailTemplateBody,    setEmailTemplateBody]    = useState('');
  const [emailSubmitError,     setEmailSubmitError]     = useState('');
  const [emailSubmitRetry,     setEmailSubmitRetry]     = useState(false);
  const [emailSentConfirm,     setEmailSentConfirm]     = useState('');
  const [logConfirm,          setLogConfirm]          = useState('');
  const [emailAttachments,     setEmailAttachments]     = useState<File[]>([]);
  const [emailConfirmOpen,     setEmailConfirmOpen]     = useState(false);
  const openEmailTriggeredRef = useRef(false);

  const autoCloseTimerRef         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emailConfirmTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logConfirmTimerRef        = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPostCloseActionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (demo) {
      setContactData(DEMO_CONTACT_DATA);
      currentLeadStatusRef.current = DEMO_CONTACT_DATA.leadStatus || '';
      statusAdvancedRef.current = false;
      setPhase('contact');
      return;
    }
    setPhase('loading');
    setLoadError('');
    setAdvanceError('');
    currentLeadStatusRef.current = '';
    statusAdvancedRef.current = false;

    // Reset enriched-activity state for the new contact.
    activityFetchedRef.current = false;
    setActivities([]);
    setActivityError(false);
    setActivityUnavailable([]);
    setExpandedIds(new Set());

    POST('/api/card-actions/contact-customer', { contactId })
      .then((data: unknown) => {
        const d = data as ContactData;
        setContactData(d);
        currentLeadStatusRef.current = d.leadStatus || '';
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

  // Lazily pull the enriched HubSpot activity feed once the modal has opened.
  // The modal still renders instantly from the main load above; this populates
  // the unified timeline asynchronously with its own spinner. Failures are
  // non-fatal — the internal attempt log still shows.
  useEffect(() => {
    if (demo || phase === 'loading' || activityFetchedRef.current) return;
    activityFetchedRef.current = true;
    setActivityLoading(true);
    setActivityError(false);
    GET<ActivityResponse>(
      `/api/card-actions/contact-customer/${encodeURIComponent(contactId)}/activity`,
    )
      .then((d) => {
        setActivities(Array.isArray(d.activities) ? d.activities : []);
        setActivityUnavailable(Array.isArray(d.unavailable) ? d.unavailable : []);
      })
      .catch(() => { setActivityError(true); })
      .finally(() => { setActivityLoading(false); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, contactId]);

  // Auto-open email composer when the modal is launched via clicking an email chip.
  useEffect(() => {
    if (openEmail && phase === 'contact' && !openEmailTriggeredRef.current) {
      openEmailTriggeredRef.current = true;
      void openEmailPreview();
    }
  // openEmailPreview is stable (defined in function body); phase is the only reactive dep here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const anyTicked = callAttempted || emailSent || whatsappSent;

  // ── Unified timeline: HubSpot activities + internal attempt log ─────────────
  const timeline: TimelineItem[] = useMemo(() => {
    const items: TimelineItem[] = [];

    // HubSpot activities arrive normalised + source-tagged from the server.
    for (const a of activities) items.push({ ...a });

    // Current-session internal attempts (granular log).
    attemptLog.forEach((e, i) => {
      items.push({
        id: `mo-current:${i}:${e.attemptedAt}`,
        source: 'measureonce',
        type: e.method,
        timestamp: e.attemptedAt,
        title: METHOD_LABEL[e.method],
        direction: e.method === 'whatsapp' ? null : 'outgoing',
        actor: e.attemptedBy,
        body: e.note,
        meta: {},
      });
    });

    // Prior-session internal history → one item per method recorded that session.
    historyAttemptLog.forEach((s, si) => {
      const methods: Method[] = [
        ...(s.callAttempted  ? (['call']     as Method[]) : []),
        ...(s.emailSent      ? (['email']    as Method[]) : []),
        ...(s.whatsappSent   ? (['whatsapp'] as Method[]) : []),
      ];
      methods.forEach((m) => {
        const note = s.notes.find((n) => n.method === m)?.note ?? null;
        items.push({
          id: `mo-hist:${si}:${m}:${s.attemptedAt}`,
          source: 'measureonce',
          type: m,
          timestamp: s.attemptedAt,
          title: METHOD_LABEL[m],
          direction: m === 'whatsapp' ? null : 'outgoing',
          actor: s.attemptedBy,
          body: note,
          meta: {},
        });
      });
    });

    return items.sort((x, y) => {
      const tx = x.timestamp ? Date.parse(x.timestamp) : 0;
      const ty = y.timestamp ? Date.parse(y.timestamp) : 0;
      return ty - tx;
    });
  }, [activities, attemptLog, historyAttemptLog]);

  const hasTimeline = timeline.length > 0;
  const showHistorySection =
    hasTimeline || historySessionCount > 0 || activityLoading || activityError || activityUnavailable.length > 0;

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
    setEmailTemplateSubject('');
    setEmailTemplateBody('');
    setEmailSubmitError('');
    setEmailSubmitRetry(false);
    setEmailAttachments([]);
    setEmailConfirmOpen(false);
  }

  async function openEmailPreview() {
    closeNotePanel();
    setEmailFlow('preview');
    setEmailSubmitError('');
    setEmailSubmitRetry(false);
    setEmailSentConfirm('');
    if (emailConfirmTimerRef.current) {
      clearTimeout(emailConfirmTimerRef.current);
      emailConfirmTimerRef.current = null;
    }

    if (demo) {
      const demoSubject = 'Fitted Wardrobes';
      const demoBody    = "Hi there,\n\nI hope you're doing well. I wanted to reach out and follow up on your enquiry with us.\n\nPlease don't hesitate to get in touch if you have any questions — we're happy to help.\n\nKind regards,\nThe team";
      setEmailSubject(demoSubject);
      setEmailBody(demoBody);
      setEmailTemplateSubject(demoSubject);
      setEmailTemplateBody(demoBody);
      return;
    }

    try {
      const result = await POST(
        `/api/card-actions/contact-customer/${encodeURIComponent(contactId)}/email-preview`,
        {},
      ) as { subject: string; text: string };
      setEmailSubject(result.subject || '');
      setEmailBody(result.text || '');
      setEmailTemplateSubject(result.subject || '');
      setEmailTemplateBody(result.text || '');
    } catch (e) {
      const err = e as ApiError;
      setEmailSubmitError(err.message || 'Could not load email preview.');
    }
  }

  async function fetchEmailPreviewHtml(subject: string, body: string): Promise<string> {
    const result = await POST(
      `/api/card-actions/contact-customer/${encodeURIComponent(contactId)}/email-preview`,
      { subject, body },
    ) as { html: string };
    return result.html || '';
  }

  // Advance the lead status to ATTEMPTED_TO_CONTACT as soon as the first
  // attempt is logged, but only when the contact currently has no status.
  // This decouples "status advanced" from the Done button: previously the
  // advance only fired in handleDone, so closing the modal any other way
  // (✕ / Esc / backdrop) left an attempt recorded with the status still empty.
  // Fire-and-forget — failures are non-fatal and retried by Done.
  async function maybeAutoAdvanceAttempted() {
    if (demo || statusAdvancedRef.current) return;
    const cur = currentLeadStatusRef.current;
    const isNullStatus = !cur || cur === '' || cur.toUpperCase() === '__NULL__';
    if (!isNullStatus) return;
    statusAdvancedRef.current = true; // optimistic guard against duplicate fires
    try {
      await POST(
        `/api/card-actions/contact-customer/${encodeURIComponent(contactId)}/advance-status`,
        { currentLeadStatus: cur || null, target: CONTACT_CUSTOMER_KEY.attempted_to_contact },
      );
      currentLeadStatusRef.current = 'ATTEMPTED_TO_CONTACT';
    } catch {
      // Leave the status un-advanced so Done (or the next attempt) can retry.
      statusAdvancedRef.current = false;
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
      const fd = new FormData();
      fd.append('subject', emailSubject.trim());
      fd.append('body', emailBody.trim());
      emailAttachments.forEach(f => fd.append('attachments', f));
      const result = await postFormData(
        `/api/card-actions/contact-customer/${encodeURIComponent(contactId)}/send-email`,
        fd,
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
      void maybeAutoAdvanceAttempted();
    } catch (e) {
      const err = e as ApiError;
      if (isGoogleAuthError(e)) {
        // Surface the disconnect inline (GoogleAuthAlert) — the user reconnects
        // from there or the header icons; we no longer auto-open the modal.
        setEmailSubmitError('GOOGLE_AUTH');
        setEmailSubmitRetry(false);
      } else if (err.status === 400) {
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
      void maybeAutoAdvanceAttempted();
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

    if (statusAdvancedRef.current) {
      // Already advanced to ATTEMPTED_TO_CONTACT when the first attempt was
      // logged — just confirm and close, no second write.
      setConfirmMessage(leadStatusConfirmationMessage('ATTEMPTED_TO_CONTACT'));
    } else if (isNullStatus && anyTicked) {
      setPhase('advancing');
      setAdvanceError('');
      try {
        const res = await POST(
          `/api/card-actions/contact-customer/${encodeURIComponent(contactId)}/advance-status`,
          { currentLeadStatus, target: CONTACT_CUSTOMER_KEY.attempted_to_contact },
        ) as { setsLeadStatus?: string | null } | undefined;
        statusAdvancedRef.current = true;
        currentLeadStatusRef.current = 'ATTEMPTED_TO_CONTACT';
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

  // Mark the lead NOT_SUITABLE and close, surfacing an Undo toast that restores
  // the prior status. Writes via the generic contact PATCH (manager/admin only)
  // so Undo can revert to any prior status — the button is gated on
  // canEditLeadStatus, mirroring the board's inline lead-status picker.
  async function handleNotSuitable() {
    if (demo || notSuitableSubmitting) return;
    const prevStatus = currentLeadStatusRef.current;
    setNotSuitableSubmitting(true);
    setAdvanceError('');
    // Optimistically move the card on the board (other roots / tabs).
    broadcastLeadStatusChange(contactId, { hs_lead_status: 'NOT_SUITABLE' });
    let result: { queued: boolean; ok: boolean; status: number; data?: unknown };
    try {
      result = await sendOrQueue({
        area: 'customer',
        label: 'Lead status → NOT_SUITABLE',
        method: 'PATCH',
        url: `/api/contacts/${encodeURIComponent(contactId)}`,
        body: { hs_lead_status: 'NOT_SUITABLE' },
        dedupeKey: `contact:${contactId}:lead-status`,
      });
    } catch {
      result = { queued: false, ok: false, status: 0 };
    }
    // A permanent client error (4xx) would never succeed on retry — revert the
    // optimistic move, surface the message, and keep the modal open.
    if (!result.queued && !result.ok) {
      broadcastLeadStatusChange(contactId, { hs_lead_status: prevStatus });
      const d = result.data as { code?: string; error?: string; message?: string } | undefined;
      setAdvanceError(
        d?.code === 'LEAD_STATUS_REMOVED'
          ? LEAD_STATUS_REMOVED_MESSAGE
          : (d?.error || d?.message || 'Could not update status.'),
      );
      setNotSuitableSubmitting(false);
      return;
    }
    // Persisted (or safely queued while offline) — confirm with an Undo that
    // restores the prior status, then close.
    const label = leadStatusLabelFor('NOT_SUITABLE') || 'Not Suitable';
    currentLeadStatusRef.current = 'NOT_SUITABLE';
    showToastWithAction(
      `Lead status updated to "${label}"`,
      {
        label: 'Undo',
        onClick: () => {
          broadcastLeadStatusChange(contactId, { hs_lead_status: prevStatus });
          void sendOrQueue({
            area: 'customer',
            label: `Lead status → ${prevStatus || 'clear'} (undo)`,
            method: 'PATCH',
            url: `/api/contacts/${encodeURIComponent(contactId)}`,
            body: { hs_lead_status: prevStatus },
            dedupeKey: `contact:${contactId}:lead-status`,
          }).catch(() => {});
        },
      },
      { duration: 5000 },
    );
    onClose();
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
    pendingPostCloseActionRef.current = () => {
      setTimeout(() => {
        dispatchCardActionHandler({ id: 0, type: 'upload_photos_and_info', config: {} }, ctx);
      }, 0);
    };
    handleRequestClose();
  }

  const isLocked = submitting || emailFlow === 'sending' || phase === 'advancing';
  const hasUnsavedChanges = !isLocked && !demo && (
    (openPanel !== null && noteText.trim() !== '') ||
    (emailFlow !== 'idle' && (
      emailSubject.trim() !== emailTemplateSubject.trim() ||
      emailBody.trim()    !== emailTemplateBody.trim()
    ))
  );

  function handleDiscard() {
    const action = pendingPostCloseActionRef.current;
    pendingPostCloseActionRef.current = null;
    onClose();
    if (action) action();
  }

  const { confirmOpen: confirmDiscardOpen, handleRequestClose, handleKeepEditing: _handleKeepEditing } = useDiscardGuard(
    hasUnsavedChanges,
    handleDiscard,
    isLocked,
  );
  useBeforeUnloadGuard(hasUnsavedChanges);

  function handleKeepEditing() {
    pendingPostCloseActionRef.current = null;
    _handleKeepEditing();
  }

  // Keep the locally-held contact data in sync after an in-header quick edit so
  // the email composer recipient, confirm dialog, and Task modal use fresh values.
  function handleContactSaved(updated: Contact) {
    const p = updated.properties;
    const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim() || p.email || '';
    setContactData(prev => prev ? {
      ...prev,
      contactName:  name,
      contactEmail: p.email || '',
      phone:        p.phone || '',
      mobile:       p.mobilephone || '',
    } : prev);
  }

  const displayName = contactData?.contactName || contactName || 'the customer';
  const phone  = contactData?.phone  || contactPhone  || '';
  const mobile = contactData?.mobile || contactMobile || '';

  // Pre-filled values for the "Call Later" task form: a "CALL - <name>" title, a
  // description seeded with the contact's phone numbers followed by every logged
  // internal attempt (calls/emails/WhatsApp across this and prior sessions,
  // newest first), and a deadline set to the next 9am/1pm/5pm slot.
  const callLaterPrefill = useMemo(() => {
    const headerLines: string[] = [];
    if (phone)  headerLines.push(`Phone: ${phone}`);
    if (mobile) headerLines.push(`Mobile: ${mobile}`);

    const entries: { timestamp: string; method: Method; note: string | null }[] = [];
    attemptLog.forEach((e) => entries.push({ timestamp: e.attemptedAt, method: e.method, note: e.note }));
    historyAttemptLog.forEach((s) => {
      const methods: Method[] = [
        ...(s.callAttempted ? (['call']     as Method[]) : []),
        ...(s.emailSent     ? (['email']    as Method[]) : []),
        ...(s.whatsappSent  ? (['whatsapp'] as Method[]) : []),
      ];
      methods.forEach((m) => {
        const note = s.notes.find((n) => n.method === m)?.note ?? null;
        entries.push({ timestamp: s.attemptedAt, method: m, note });
      });
    });
    entries.sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
      return tb - ta;
    });

    const historyLines = entries.map((e) => {
      const when = e.timestamp ? dayjs(e.timestamp).format('YYYY-MM-DD HH:mm') : '';
      const parts = [when, METHOD_LABEL[e.method]].filter(Boolean);
      if (e.note && e.note.trim()) parts.push(e.note.trim());
      return parts.join(' · ');
    });

    const description = [
      ...headerLines,
      ...(historyLines.length ? ['', ...historyLines] : []),
    ].join('\n');

    return {
      taskName: `CALL - ${displayName}`,
      description,
      deadlineIso: nextCallSlotIso(),
    };
  }, [phone, mobile, attemptLog, historyAttemptLog, displayName]);

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
    footerNode = <Button onClick={handleRequestClose}>Cancel</Button>;
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
        {canEditLeadStatus && (
          <Button
            onClick={() => void handleNotSuitable()}
            variant="outlined"
            color="error"
            disabled={demo || notSuitableSubmitting}
            startIcon={notSuitableSubmitting ? <CircularProgress size={14} color="inherit" /> : undefined}
            data-testid="cc-not-suitable"
          >
            Not Suitable
          </Button>
        )}
        <Button
          onClick={() => setTaskModalOpen(true)}
          variant="outlined"
          color="secondary"
          data-testid="cc-call-later"
        >
          Call Later
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
    <>
    <FullScreenModal
      open
      onClose={handleRequestClose}
      disableClose={phase === 'advancing' || emailFlow === 'sending'}
      title={titleStr}
      headerActions={
        demo ? <Chip label="Demo preview" size="small" color="info" variant="outlined" /> : undefined
      }
      footer={footerNode || undefined}
    >
      {phase === 'loading' && (
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <ModalContactHeader
            name={contactName || 'the customer'}
            phone={contactPhone || ''}
            mobile={contactMobile || ''}
            email={contactEmail}
            contactId={demo ? undefined : contactId}
            onContactSaved={handleContactSaved}
          />
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={36} />
          </Box>
          {loadError && (
            <Alert severity="error" sx={{ mt: 1 }}>{loadError}</Alert>
          )}
        </Stack>
      )}

      {phase === 'contact' && (
            <Stack spacing={2} sx={{ mt: 0.5 }}>
              <ModalContactHeader
                name={displayName}
                phone={phone}
                mobile={mobile}
                email={contactData?.contactEmail || contactEmail}
                contactId={demo ? undefined : contactId}
                onContactSaved={handleContactSaved}
              />
              {loadError && (
                <Alert severity="warning">{loadError}</Alert>
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
                            sx={{ mt: 1, pl: 1.5, borderLeft: '2px solid', borderColor: 'primary.main' }}
                          >
                            {!contactEmailAddr ? (
                              <Typography variant="body2" color="text.secondary" sx={{ py: 0.5 }}>
                                No email address is on record for this contact. Add one in HubSpot before sending.
                              </Typography>
                            ) : emailFlow !== 'idle' && (
                              <>
                                <EmailComposer
                                  subject={emailSubject}
                                  onSubjectChange={setEmailSubject}
                                  body={emailBody}
                                  onBodyChange={setEmailBody}
                                  fetchPreviewHtml={demo ? undefined : fetchEmailPreviewHtml}
                                  disabled={emailFlow === 'sending'}
                                  recipientName={contactData?.contactName || contactName}
                                  recipientEmail={contactEmailAddr}
                                  bodyMinRows={4}
                                  attachments={emailAttachments}
                                  onAttachmentsChange={demo ? undefined : setEmailAttachments}
                                />
                                {emailSubmitError === 'GOOGLE_AUTH' && (
                                  <GoogleAuthAlert sx={{ mt: 1, mb: 0.5, py: 0 }} />
                                )}
                                {emailSubmitError && emailSubmitError !== 'GOOGLE_AUTH' && (
                                  <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.75, mb: 0.5 }}>
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
                                <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                                  <Button
                                    data-testid="email-preview-send-btn"
                                    size="small"
                                    variant="contained"
                                    disabled={emailFlow === 'sending' || !emailSubject.trim() || !emailBody.trim()}
                                    onClick={() => setEmailConfirmOpen(true)}
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
                            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 1 }}>
                              {CALL_PRESETS.map((preset) => (
                                <Chip
                                  key={preset}
                                  label={preset}
                                  size="small"
                                  variant="outlined"
                                  disabled={submitting}
                                  onClick={() => setNoteText(preset)}
                                />
                              ))}
                            </Box>
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

              {showHistorySection && (
                <Box>
                  <Divider sx={{ mb: 1 }} />
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Contact history
                    </Typography>
                    {activityLoading && <CircularProgress size={12} />}
                  </Box>

                  {historySessionCount > 0 && (() => {
                    const historyMethods = [
                      historyEverCalled     && 'calls',
                      historyEverEmailed    && 'emails',
                      historyEverWhatsapped && 'WhatsApp',
                    ].filter(Boolean).join(', ');
                    return (
                      <Box
                        sx={{
                          px: 1, py: 0.5, mb: 0.75,
                          bgcolor: 'grey.50', borderRadius: 1,
                          border: '1px solid', borderColor: 'divider',
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
                    );
                  })()}

                  {hasTimeline && (
                    <Box
                      data-testid="contact-activity-timeline"
                      sx={{
                        maxHeight: 280,
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 0.5,
                      }}
                    >
                      {timeline.map((item) => (
                        <ContactTimelineRow
                          key={item.id}
                          item={item}
                          expanded={expandedIds.has(item.id)}
                          onToggle={() => toggleExpanded(item.id)}
                        />
                      ))}
                    </Box>
                  )}

                  {!hasTimeline && !activityLoading && !activityError && (
                    <Typography variant="caption" color="text.secondary">
                      No activity recorded yet.
                    </Typography>
                  )}

                  {(activityError || activityUnavailable.length > 0) && (
                    <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.5, fontStyle: 'italic' }}>
                      {activityError
                        ? 'HubSpot activity could not be loaded.'
                        : `Some HubSpot activity couldn’t be loaded${activityUnavailable.length ? ` (${activityUnavailable.join(', ')})` : ''}.`}
                    </Typography>
                  )}
                </Box>
              )}

              {!hasTimeline && lastAttemptAt && (
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
            <ModalContactHeader
              name={displayName}
              phone={phone}
              mobile={mobile}
              email={contactData?.contactEmail || contactEmail}
              contactId={demo ? undefined : contactId}
              onContactSaved={handleContactSaved}
            />
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
    <DiscardConfirmDialog
      open={confirmDiscardOpen}
      onDiscard={handleDiscard}
      onKeepEditing={handleKeepEditing}
    />

    <Dialog
      open={emailConfirmOpen}
      onClose={() => setEmailConfirmOpen(false)}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>Send email?</DialogTitle>
      <DialogContent>
        <Stack spacing={0.5}>
          <Typography variant="body2">
            <strong>To:</strong> {(() => {
              const addr = contactData?.contactEmail || contactEmail;
              const name_ = contactData?.contactName || contactName;
              return name_ ? `${name_} <${addr}>` : addr;
            })()}
          </Typography>
          <Typography variant="body2">
            <strong>Subject:</strong> {emailSubject.trim()}
          </Typography>
          {emailAttachments.length > 0 && (
            <Typography variant="body2">
              <strong>Attachments:</strong> {emailAttachments.length} file{emailAttachments.length !== 1 ? 's' : ''}
              {' '}({emailAttachments.map(f => f.name).join(', ')})
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setEmailConfirmOpen(false)}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => { setEmailConfirmOpen(false); void handleSendEmail(); }}
          data-testid="email-send-confirm-btn"
        >
          Send
        </Button>
      </DialogActions>
    </Dialog>

    {taskModalOpen && (
      <Suspense fallback={null}>
        <TaskModal
          open
          onClose={() => setTaskModalOpen(false)}
          contactId={contactId}
          contactName={displayName}
          contactEmail={contactData?.contactEmail || contactEmail}
          contactPhone={phone}
          contactMobile={mobile}
          prefillTaskName={callLaterPrefill.taskName}
          prefillDescription={callLaterPrefill.description}
          prefillDeadlineIso={callLaterPrefill.deadlineIso}
          demo={demo}
        />
      </Suspense>
    )}
    </>
  );
}
