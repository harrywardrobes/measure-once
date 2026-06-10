import React, { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
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
import { useDiscardGuard } from '../../hooks/useDiscardGuard';
import { POST, calendarErrorMessage } from '../../utils/api';
import { useToast } from '../../contexts/ToastContext';
import { DiscardConfirmDialog } from './DiscardConfirmDialog';

interface Props {
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
}

interface DraftState {
  title: string;
  duration: string;
  location: string;
  notes: string;
  startDt?: string;
}

function draftKey(handlerId: string | number, contactId: string | number | null | undefined): string {
  return `mo-dv-cal-draft-${handlerId}-${contactId ?? 'unknown'}`;
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
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // quota exceeded or private browsing — silently ignore
  }
}

function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function DesignVisitCalendarModal({ handler, ctx, open, onClose }: Props) {
  const showToast = useToast();
  const cfg = handler.config || {};
  const defaultDuration = (cfg.defaultDurationMin as number) || 60;
  const defaultTitle =
    (cfg.defaultTitle as string) ||
    (ctx.contactName ? `Design visit — ${ctx.contactName}` : 'Design visit');

  const key = draftKey(handler.id, ctx.contactId);
  const draft = loadDraft(key);

  const freshStart = dayjs().add(24, 'hour').startOf('hour');
  const restoredStart = draft.startDt ? dayjs(draft.startDt) : null;
  const restoredStartIsStale =
    restoredStart !== null && restoredStart.isValid() && !restoredStart.isAfter(dayjs());
  const initialStart =
    restoredStart && restoredStart.isValid() && restoredStart.isAfter(dayjs())
      ? restoredStart
      : freshStart;

  const initialStartRef = React.useRef(initialStart);

  const [title, setTitle] = useState(draft.title ?? defaultTitle);
  const [startDt, setStartDt] = useState<Dayjs | null>(initialStart);
  const [duration, setDuration] = useState(draft.duration ?? String(defaultDuration));
  const [location, setLocation] = useState(draft.location ?? '');
  const [notes, setNotes] = useState(draft.notes ?? '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [startDtWasReset, setStartDtWasReset] = useState(restoredStartIsStale);
  const [startTimeWarning, setStartTimeWarning] = useState(false);
  const [pastConfirmOpen, setPastConfirmOpen] = useState(false);

  const hasUnsavedChanges =
    title !== defaultTitle ||
    location.trim() !== '' ||
    notes.trim() !== '' ||
    duration !== String(defaultDuration) ||
    (startDt !== null && !startDt.isSame(initialStartRef.current));

  useEffect(() => {
    saveDraft(key, { title, duration, location, notes, startDt: startDt?.toISOString() });
  }, [key, title, duration, location, notes, startDt]);

  useEffect(() => {
    if (!open) {
      setStartTimeWarning(false);
      return;
    }

    function checkApproaching() {
      if (!startDt || !startDt.isValid()) {
        setStartTimeWarning(false);
        return;
      }
      const minutesUntilStart = startDt.diff(dayjs(), 'minute');
      setStartTimeWarning(minutesUntilStart < 15);
    }

    checkApproaching();
    const interval = setInterval(checkApproaching, 60_000);
    return () => clearInterval(interval);
  }, [open, startDt]);

  function handleDismiss() {
    setError('');
    onClose();
  }

  function handleCancel() {
    clearDraft(key);
    setError('');
    onClose();
  }

  const { confirmOpen: confirmDiscardOpen, handleRequestClose, setConfirmOpen: setConfirmDiscardOpen } =
    useDiscardGuard(hasUnsavedChanges, handleDismiss, submitting);

  async function doSubmit() {
    if (!startDt || !startDt.isValid()) return;
    const durationInt = parseInt(duration, 10);
    const start = startDt.toDate();
    const end = new Date(start.getTime() + durationInt * 60000);

    setSubmitting(true);
    try {
      await POST('/api/events', {
        summary: title.trim(),
        description: notes.trim() || '',
        location: location.trim() || '',
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
      });

      showToast('Visit scheduled to the shared calendar', false);
      clearDraft(key);
      handleDismiss();
    } catch (e) {
      setError(calendarErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit() {
    setError('');
    if (!title.trim()) { setError('Title is required.'); return; }
    if (!startDt || !startDt.isValid()) { setError('Start time is required.'); return; }
    const durationInt = parseInt(duration, 10);
    if (!Number.isInteger(durationInt) || durationInt < 5) {
      setError('Duration must be ≥ 5 minutes.');
      return;
    }

    if (startDt.isBefore(dayjs())) {
      setPastConfirmOpen(true);
      return;
    }

    void doSubmit();
  }

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Dialog
        open={pastConfirmOpen}
        onClose={() => setPastConfirmOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Schedule in the past?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This time has already passed — schedule anyway?
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPastConfirmOpen(false)}>Go back</Button>
          <Button
            variant="contained"
            color="warning"
            data-testid="cah-past-confirm"
            onClick={() => {
              setPastConfirmOpen(false);
              void doSubmit();
            }}
          >
            Schedule anyway
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={open} onClose={handleRequestClose} maxWidth="xs" fullWidth>
        <DialogTitle>
          {ctx.contactName ? `Schedule design visit for ${ctx.contactName}` : 'Schedule design visit'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <TextField
              id="cah-dv-title"
              label="Title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 120 } }}
              fullWidth
              size="small"
            />
            <Stack direction="row" spacing={1.5}>
              <DateTimePicker
                label="Start"
                value={startDt}
                onChange={(v: Dayjs | null) => {
                  setStartDt(v);
                  setStartDtWasReset(false);
                }}
                slotProps={{
                  textField: {
                    id: 'cah-dv-start',
                    fullWidth: true,
                    size: 'small',
                  },
                }}
              />
              <TextField
                id="cah-dv-duration"
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
              label="Location (optional)"
              value={location}
              onChange={e => setLocation(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 300 } }}
              placeholder="Customer address"
              fullWidth
              size="small"
            />
            <TextField
              id="cah-dv-notes"
              label="Notes (optional)"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 4000 } }}
              placeholder="Anything the designer should know"
              multiline
              minRows={3}
              fullWidth
              size="small"
            />
            <Typography variant="caption" color="text.secondary">
              This visit is added to the shared Measure Once Google Calendar.
            </Typography>
            {error && (
              <Typography variant="caption" color="error">{error}</Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleRequestClose} disabled={submitting}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleSubmit}
            disabled={submitting}
            data-testid="cah-primary"
          >
            {submitting ? 'Scheduling…' : 'Schedule'}
          </Button>
        </DialogActions>
      </Dialog>

      <DiscardConfirmDialog
        open={confirmDiscardOpen}
        onKeepEditing={() => setConfirmDiscardOpen(false)}
        onDiscard={handleCancel}
      />
    </LocalizationProvider>
  );
}
