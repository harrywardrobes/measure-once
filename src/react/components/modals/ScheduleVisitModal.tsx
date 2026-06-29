/**
 * ScheduleVisitModal — merged replacement for DesignVisitCalendarModal and
 * VisitCalendarModal. Handles all calendar-event scheduling flows.
 *
 * Key differences from the deprecated modals:
 *   • visitType prop: if supplied the type is locked; absent → shows a selector.
 *   • contactAddress prop: pre-fills the location field.
 *   • moContactId/moVisitType tags are sent to POST /api/events so
 *     GET /api/events?contactId can find events for a contact.
 *   • Optional "Send confirmation email" checkbox: when ticked, renders an
 *     editable preview of the visit_confirmation template and sends it after
 *     the calendar event is created. Email failure is non-fatal (warning toast).
 *   • onSuccess callback: fires after a successful event creation (instead of
 *     just closing). Used by DesignVisitFollowupModal to chain an outcome call.
 *   • Draft persistence: localStorage keyed per contactId (SCHEDULE_VISIT_DRAFT_PREFIX).
 */
import React, { useEffect, useRef, useState } from 'react';
import { SCHEDULE_VISIT_DRAFT_PREFIX } from '../../constants/localStorageKeys';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { DateTimeEditor } from '../DateTimeEditor';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';
import { useDiscardGuard } from '../../hooks/useDiscardGuard';
import { useBeforeUnloadGuard } from '../../hooks/useBeforeUnloadGuard';
import { POST, PATCH, calendarErrorMessage, isGoogleAuthError } from '../../utils/api';
import { openConnectModal, useServiceStatuses } from '../../contexts/ConnectionToastContext';
import { STAFF_EMAIL_TEMPLATE_KEY } from '../../utils/handlerMeta';
import { useToast } from '../../contexts/ToastContext';
import { DiscardConfirmDialog } from './DiscardConfirmDialog';
import { ModalContactHeader } from './ModalContactHeader';
import { DemoActionTooltip } from './demoMode';
import { FullScreenModal } from './FullScreenModal';

const VISIT_TYPES = [
  { value: 'design', label: 'Design visit' },
  { value: 'survey', label: 'Survey' },
  { value: 'other',  label: 'Other' },
];

function visitTypeLabel(t: string): string {
  return VISIT_TYPES.find(v => v.value === t)?.label ?? t;
}

interface CalendarEvent {
  id?: string;
  summary?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
}

export interface ScheduleVisitModalProps {
  handler?: CardActionHandlerData | null;
  ctx: CardActionContext;
  /** If supplied the type is locked; absent → shows a type selector. */
  visitType?: string;
  /** Pre-fill the location field (e.g. customer address). */
  contactAddress?: string;
  /** Pre-fill the start date/time (ISO string). Used when rescheduling an
   *  existing event. Ignored when a draft already exists for the contact. */
  initialStartDt?: string;
  /** Pre-fill the event title. Ignored when a draft already exists. */
  initialTitle?: string;
  /** When supplied the modal updates this existing calendar event in place
   *  via PATCH /api/events/:id (reschedule) instead of creating a new event
   *  via POST /api/events. */
  existingEventId?: string;
  open: boolean;
  onClose: () => void;
  /** Called after a successful event creation. When supplied the modal does NOT
   *  auto-close after success — the parent is responsible for closing it. */
  onSuccess?: (event: CalendarEvent) => void;
  demo?: boolean;
}

interface DraftState {
  title: string;
  duration: string;
  location: string;
  notes: string;
  startDt?: string;
  visitType?: string;
  sendEmail: boolean;
  emailSubject: string;
  emailBody: string;
}

function draftKey(contactId: string | number | null | undefined): string {
  return `${SCHEDULE_VISIT_DRAFT_PREFIX}${contactId ?? 'unknown'}`;
}

function loadDraft(key: string): Partial<DraftState> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<DraftState>;
  } catch {
    return {};
  }
}

function saveDraft(key: string, draft: DraftState): void {
  try { localStorage.setItem(key, JSON.stringify(draft)); } catch { /* quota */ }
}

function clearDraft(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export function ScheduleVisitModal({
  handler,
  ctx,
  visitType: visitTypeProp,
  contactAddress,
  initialStartDt,
  initialTitle,
  existingEventId,
  open,
  onClose,
  onSuccess,
  demo,
}: ScheduleVisitModalProps) {
  const showToast = useToast();
  const serviceStatuses = useServiceStatuses();
  const googleDisconnected = serviceStatuses.get('google') === 'error';
  const cfg = handler?.config || {};
  const defaultDuration = (cfg.defaultDurationMin as number) || 60;
  const lockedVisitType = visitTypeProp;

  const key = draftKey(ctx.contactId);
  const draft = demo ? {} : loadDraft(key);

  const initialVisitType = draft.visitType ?? lockedVisitType ?? 'design';
  const [visitType, setVisitType] = useState(initialVisitType);

  function defaultTitle(vt: string): string {
    const vLabel = visitTypeLabel(vt);
    if ((cfg.defaultTitle as string)) return cfg.defaultTitle as string;
    return ctx.contactName ? `${vLabel} — ${ctx.contactName}` : vLabel;
  }

  const freshStart = dayjs().add(24, 'hour').startOf('hour');
  const restoredStart = draft.startDt ? dayjs(draft.startDt) : null;
  const restoredStartIsStale =
    restoredStart !== null && restoredStart.isValid() && !restoredStart.isAfter(dayjs());
  // initialStartDt (from parent, e.g. rescheduling) is used only when no draft exists.
  const seedStart = (!restoredStart && initialStartDt) ? dayjs(initialStartDt) : null;
  const initialStart =
    restoredStart && restoredStart.isValid() && restoredStart.isAfter(dayjs())
      ? restoredStart
      : (seedStart && seedStart.isValid() ? seedStart : freshStart);
  const initialStartRef = useRef(initialStart);

  const [title, setTitle] = useState(draft.title ?? initialTitle ?? defaultTitle(initialVisitType));
  const [startDt, setStartDt] = useState<Dayjs | null>(initialStart);
  const [duration, setDuration] = useState(draft.duration ?? String(defaultDuration));
  const [location, setLocation] = useState(draft.location ?? contactAddress ?? '');
  const [notes, setNotes] = useState(draft.notes ?? '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [startDtWasReset, setStartDtWasReset] = useState(restoredStartIsStale);
  const [startTimeWarning, setStartTimeWarning] = useState(false);
  const [pastConfirmOpen, setPastConfirmOpen] = useState(false);

  const [sendEmail, setSendEmail] = useState(draft.sendEmail ?? false);
  const [emailSubject, setEmailSubject] = useState(draft.emailSubject ?? '');
  const [emailBody, setEmailBody] = useState(draft.emailBody ?? '');
  const [emailLoading, setEmailLoading] = useState(false);
  const emailFetchedRef = useRef(false);

  const computedTitle = title || defaultTitle(visitType);

  const hasUnsavedChanges =
    title !== defaultTitle(visitType) ||
    location.trim() !== '' ||
    notes.trim() !== '' ||
    duration !== String(defaultDuration) ||
    sendEmail ||
    (startDt !== null && !startDt.isSame(initialStartRef.current));

  useEffect(() => {
    if (demo) return;
    saveDraft(key, { title, duration, location, notes, startDt: startDt?.toISOString(), visitType, sendEmail, emailSubject, emailBody });
  }, [key, title, duration, location, notes, startDt, visitType, sendEmail, emailSubject, emailBody, demo]);

  useEffect(() => {
    if (!open) { setStartTimeWarning(false); return; }
    function checkApproaching() {
      if (!startDt || !startDt.isValid()) { setStartTimeWarning(false); return; }
      setStartTimeWarning(startDt.diff(dayjs(), 'minute') < 15);
    }
    checkApproaching();
    const interval = setInterval(checkApproaching, 60_000);
    return () => clearInterval(interval);
  }, [open, startDt]);

  useEffect(() => {
    if (!sendEmail || emailFetchedRef.current || demo) return;
    emailFetchedRef.current = true;
    setEmailLoading(true);
    const firstName = (ctx.contactName || '').split(' ')[0] || ctx.contactName || 'there';
    const durationInt = parseInt(duration, 10) || defaultDuration;
    const locStr = location.trim() ? ` at ${location.trim()}` : '';
    const dateStr = startDt?.isValid() ? startDt.format('D MMMM YYYY') : '';
    const timeStr = startDt?.isValid() ? startDt.format('h:mm A') : '';
    POST('/api/email-templates/render', {
      key: STAFF_EMAIL_TEMPLATE_KEY.visit_confirmation,
      vars: {
        firstName,
        visitLabel: visitTypeLabel(visitType),
        visitDate: dateStr,
        visitTime: timeStr,
        visitDuration: String(durationInt),
        location: location.trim() || 'TBC',
      },
    })
      .then((data) => {
        if (!emailFetchedRef.current) return;
        const d = data as { subject?: string; body_text?: string };
        setEmailSubject(d.subject ?? '');
        setEmailBody(d.body_text ?? '');
      })
      .catch(() => {
        setEmailSubject(`Your ${visitTypeLabel(visitType)} is confirmed`);
        setEmailBody(`Hi ${firstName},\n\nYour ${visitTypeLabel(visitType)} is confirmed for ${dateStr}${locStr}.\n\nSee you then!`);
      })
      .finally(() => setEmailLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendEmail]);

  function handleToggleEmail(e: React.ChangeEvent<HTMLInputElement>) {
    const checked = e.target.checked;
    setSendEmail(checked);
    if (!checked) {
      emailFetchedRef.current = false;
      setEmailSubject('');
      setEmailBody('');
    }
  }

  function handleDismiss() { setError(''); onClose(); }

  function handleCancel() { clearDraft(key); setError(''); onClose(); }

  const { confirmOpen: confirmDiscardOpen, handleRequestClose, handleKeepEditing } =
    useDiscardGuard(demo ? false : hasUnsavedChanges, handleDismiss, submitting);
  useBeforeUnloadGuard(demo ? false : hasUnsavedChanges);

  async function doSubmit() {
    if (demo) return;
    if (!startDt || !startDt.isValid()) return;
    const durationInt = parseInt(duration, 10);
    const start = startDt.toDate();
    const end = new Date(start.getTime() + durationInt * 60000);
    setSubmitting(true);
    try {
      let event: CalendarEvent;
      if (existingEventId) {
        // Reschedule: update the existing event in place via PATCH.
        event = await PATCH<CalendarEvent>(`/api/events/${encodeURIComponent(existingEventId)}`, {
          summary: computedTitle.trim(),
          description: notes.trim() || '',
          location: location.trim() || '',
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() },
        });
      } else {
        event = await POST('/api/events', {
          summary: computedTitle.trim(),
          description: notes.trim() || '',
          location: location.trim() || '',
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() },
          moContactId: ctx.contactId ? String(ctx.contactId) : undefined,
          moVisitType: visitType,
        });
      }

      if (sendEmail && ctx.contactEmail && emailSubject.trim() && emailBody.trim()) {
        try {
          await POST('/api/emails/send', {
            to: ctx.contactEmail,
            subject: emailSubject.trim(),
            text: emailBody.trim(),
          });
          showToast('Visit scheduled and confirmation email sent', false);
        } catch {
          showToast('Visit scheduled — confirmation email failed to send', true);
        }
      } else {
        showToast('Visit added to the shared calendar', false);
      }

      clearDraft(key);
      if (onSuccess) {
        onSuccess(event);
      } else {
        handleDismiss();
      }
    } catch (e) {
      setError(calendarErrorMessage(e));
      if (isGoogleAuthError(e)) {
        openConnectModal('google', 'Google Calendar is disconnected — reconnect it to schedule visits.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit() {
    if (demo) return;
    setError('');
    if (!computedTitle.trim()) { setError('Title is required.'); return; }
    if (!startDt || !startDt.isValid()) { setError('Start time is required.'); return; }
    const durationInt = parseInt(duration, 10);
    if (!Number.isInteger(durationInt) || durationInt < 5) { setError('Duration must be ≥ 5 minutes.'); return; }
    if (startDt.isBefore(dayjs())) { setPastConfirmOpen(true); return; }
    void doSubmit();
  }

  const modalTitle = lockedVisitType
    ? `Schedule ${visitTypeLabel(lockedVisitType)}${ctx.contactName ? ` for ${ctx.contactName}` : ''}`
    : `Schedule visit${ctx.contactName ? ` for ${ctx.contactName}` : ''}`;

  return (
    <>
      <FullScreenModal
        open={pastConfirmOpen}
        onClose={() => setPastConfirmOpen(false)}
        title="Schedule in the past?"
        centerContent
        footer={
          <>
            <Button onClick={() => setPastConfirmOpen(false)}>Go back</Button>
            <Button variant="contained" color="warning" data-testid="cah-past-confirm"
              onClick={() => { setPastConfirmOpen(false); void doSubmit(); }}>
              Schedule anyway
            </Button>
          </>
        }
      >
        <Typography variant="body2">This time has already passed — schedule anyway?</Typography>
      </FullScreenModal>

      <FullScreenModal
        open={open}
        onClose={handleRequestClose}
        disableClose={submitting}
        title={modalTitle}
        headerActions={
          demo ? <Chip label="Demo preview" size="small" color="info" variant="outlined" /> : undefined
        }
        footer={
          <>
            <Button onClick={handleRequestClose} disabled={submitting}>Cancel</Button>
            <DemoActionTooltip demo={demo}>
              <Button
                variant="contained"
                onClick={handleSubmit}
                disabled={submitting || demo || (sendEmail && emailLoading)}
                data-testid="cah-primary"
              >
                {submitting ? 'Scheduling…' : 'Schedule'}
              </Button>
            </DemoActionTooltip>
          </>
        }
      >
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <ModalContactHeader name={ctx.contactName} email={ctx.contactEmail} phone={ctx.contactPhone} mobile={ctx.contactMobile} contactId={demo ? undefined : ctx.contactId} />
            {googleDisconnected && !demo && (
              <Alert
                severity="warning"
                action={
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => openConnectModal('google', 'Reconnect Google Calendar to schedule visits.')}
                  >
                    Reconnect
                  </Button>
                }
              >
                Google Calendar is disconnected — visits can&apos;t be scheduled until you reconnect.
              </Alert>
            )}

            {!lockedVisitType && (
              <FormControl size="small" fullWidth>
                <InputLabel id="cah-sv-vt-label">Visit type</InputLabel>
                <Select
                  labelId="cah-sv-vt-label"
                  id="cah-sv-visit-type"
                  value={visitType}
                  label="Visit type"
                  onChange={e => {
                    setVisitType(e.target.value);
                    if (!draft.title) setTitle('');
                  }}
                >
                  {VISIT_TYPES.map(vt => (
                    <MenuItem key={vt.value} value={vt.value}>{vt.label}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            <TextField
              id="cah-sv-title"
              label="Title"
              value={title}
              placeholder={defaultTitle(visitType)}
              onChange={e => setTitle(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 120 } }}
              fullWidth
              size="small"
            />
            <Stack direction="row" spacing={1.5}>
              <DateTimeEditor
                label="Start"
                value={startDt}
                onChange={(v) => { setStartDt(v); setStartDtWasReset(false); }}
                id="cah-sv-start"
              />
              <TextField
                id="cah-sv-duration"
                label="Duration (min)"
                type="number"
                value={duration}
                onChange={e => setDuration(e.target.value)}
                slotProps={{ htmlInput: { min: 5, max: 1440, step: 5 } }}
                sx={{ minWidth: 130 }}
                size="small"
              />
            </Stack>
            {startDtWasReset && (
              <Alert severity="info" sx={{ py: 0.5 }}>
                Your saved date/time was in the past and has been reset.
              </Alert>
            )}
            {startTimeWarning && !startDtWasReset && (
              <Alert severity="warning" sx={{ py: 0.5 }}>
                {startDt && startDt.isBefore(dayjs())
                  ? 'The selected start time has already passed. Please choose a future time.'
                  : 'The selected start time is less than 15 minutes away. You may want to update it.'}
              </Alert>
            )}
            <TextField
              id="cah-sv-location"
              label="Location (optional)"
              value={location}
              onChange={e => setLocation(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 300 } }}
              placeholder="Customer address"
              fullWidth
              size="small"
            />
            <TextField
              id="cah-sv-notes"
              label="Notes (optional)"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 4000 } }}
              placeholder="Anything the team should know"
              multiline
              minRows={2}
              fullWidth
              size="small"
            />
            <Typography variant="caption" color="text.secondary">
              This visit is added to the shared Measure Once Google Calendar.
            </Typography>
            <FormControlLabel
              control={
                <Checkbox
                  id="cah-sv-send-email"
                  checked={sendEmail}
                  onChange={handleToggleEmail}
                  disabled={!ctx.contactEmail}
                  size="small"
                />
              }
              label={
                <Typography variant="body2">
                  Send confirmation email to customer
                  {!ctx.contactEmail && (
                    <Typography component="span" variant="caption" color="text.secondary"> (no email on file)</Typography>
                  )}
                </Typography>
              }
            />
            <Collapse in={sendEmail}>
              <Stack spacing={1.5}>
                {emailLoading ? (
                  <Typography variant="caption" color="text.secondary">Loading email template…</Typography>
                ) : (
                  <>
                    <TextField
                      id="cah-sv-email-subject"
                      label="Email subject"
                      value={emailSubject}
                      onChange={e => setEmailSubject(e.target.value)}
                      size="small"
                      fullWidth
                      slotProps={{ htmlInput: { maxLength: 300 } }}
                    />
                    <TextField
                      id="cah-sv-email-body"
                      label="Email body"
                      value={emailBody}
                      onChange={e => setEmailBody(e.target.value)}
                      multiline
                      minRows={5}
                      size="small"
                      fullWidth
                      slotProps={{ htmlInput: { maxLength: 8000 } }}
                    />
                    <Typography variant="caption" color="text.secondary">
                      Sent from your connected Gmail account.
                    </Typography>
                  </>
                )}
              </Stack>
            </Collapse>
            {error && <Box><Typography variant="caption" color="error">{error}</Typography></Box>}
          </Stack>
      </FullScreenModal>

      <DiscardConfirmDialog
        open={confirmDiscardOpen}
        onKeepEditing={handleKeepEditing}
        onDiscard={handleCancel}
      />
    </>
  );
}
