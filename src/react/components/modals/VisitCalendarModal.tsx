/** @deprecated — use ScheduleVisitModal */
import React, { useEffect, useRef, useState } from 'react';
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
import { ModalContactHeader } from './ModalContactHeader';
import { DemoDialogTitle, DemoActionTooltip } from './demoMode';

interface Props {
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
  demo?: boolean;
}

const VISIT_TYPE_LABELS: Record<string, string> = {
  design:       'Design visit',
  survey:       'Survey',
  installation: 'Installation',
  remedial:     'Remedial',
  workshop:     'Workshop',
  other:        'Visit',
};

const VISIT_TYPE_PLACEHOLDERS: Record<string, string> = {
  design:       'Anything the designer should know',
  survey:       'Anything the surveyor should know',
  installation: 'Anything the fitter should know',
  remedial:     'Details of the remedial work',
  workshop:     'Workshop details',
  other:        'Notes for this visit',
};

export function VisitCalendarModal({ handler, ctx, open, onClose, demo }: Props) {
  const showToast = useToast();
  const cfg = handler.config || {};
  const visitType      = (cfg.visitType as string) || 'design';
  const typeLabel      = VISIT_TYPE_LABELS[visitType] || 'Visit';
  const defaultDuration = (cfg.defaultDurationMin as number) || 60;
  const defaultTitle =
    (cfg.defaultTitle as string) ||
    (ctx.contactName ? `${typeLabel} — ${ctx.contactName}` : typeLabel);

  const initialStart = dayjs().add(24, 'hour').startOf('hour');

  const initialStartRef = useRef(initialStart);
  const initialTitleRef = useRef(defaultTitle);
  const initialDurationRef = useRef(String(defaultDuration));

  const [title, setTitle]       = useState(defaultTitle);
  const [startDt, setStartDt]   = useState<Dayjs | null>(initialStart);
  const [duration, setDuration] = useState(String(defaultDuration));
  const [location, setLocation] = useState('');
  const [notes, setNotes]       = useState('');
  const [error, setError]       = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [startTimeWarning, setStartTimeWarning] = useState(false);
  const [pastConfirmOpen, setPastConfirmOpen] = useState(false);

  const hasUnsavedChanges =
    title !== initialTitleRef.current ||
    location.trim() !== '' ||
    notes.trim() !== '' ||
    duration !== initialDurationRef.current ||
    (startDt !== null && !startDt.isSame(initialStartRef.current));

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

  function handleClose() {
    setError('');
    onClose();
  }

  const { confirmOpen: confirmDiscardOpen, handleRequestClose, handleKeepEditing } =
    useDiscardGuard(demo ? false : hasUnsavedChanges, handleClose, submitting);

  async function doSubmit() {
    if (demo) return;
    if (!startDt || !startDt.isValid()) return;
    const durationInt = parseInt(duration, 10);
    const start = startDt.toDate();
    const end   = new Date(start.getTime() + durationInt * 60000);

    setSubmitting(true);
    try {
      await POST('/api/events', {
        summary:     title.trim(),
        description: notes.trim() || '',
        location:    location.trim() || '',
        start:       { dateTime: start.toISOString() },
        end:         { dateTime: end.toISOString() },
      });

      showToast('Visit scheduled to the shared calendar', false);
      handleClose();
    } catch (e) {
      setError(calendarErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit() {
    if (demo) return;
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

  const dialogTitle = ctx.contactName
    ? `Schedule ${typeLabel.toLowerCase()} for ${ctx.contactName}`
    : `Schedule ${typeLabel.toLowerCase()}`;

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
        <DemoDialogTitle demo={demo}>{dialogTitle}</DemoDialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <ModalContactHeader name={ctx.contactName} email={ctx.contactEmail} />
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
                onChange={(v: Dayjs | null) => setStartDt(v)}
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
            {startTimeWarning && (
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
              placeholder={VISIT_TYPE_PLACEHOLDERS[visitType] || 'Notes for this visit'}
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
          <DemoActionTooltip demo={demo}>
            <Button
              variant="contained"
              onClick={handleSubmit}
              disabled={submitting || demo}
              data-testid="cah-primary"
            >
              {submitting ? 'Scheduling…' : 'Schedule'}
            </Button>
          </DemoActionTooltip>
        </DialogActions>
      </Dialog>

      <DiscardConfirmDialog
        open={confirmDiscardOpen}
        onKeepEditing={handleKeepEditing}
        onDiscard={handleClose}
      />
    </LocalizationProvider>
  );
}
