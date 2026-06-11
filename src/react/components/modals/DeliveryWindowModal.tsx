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
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { DateTimeRangePicker } from '@mui/x-date-pickers-pro/DateTimeRangePicker';
import type { DateRange } from '@mui/x-date-pickers-pro/models';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';
import type { Visit } from '../../pages/customer-detail/types';
import { POST, calendarErrorMessage } from '../../utils/api';
import { useToast } from '../../contexts/ToastContext';
import { useDiscardGuard } from '../../hooks/useDiscardGuard';
import { DiscardConfirmDialog } from './DiscardConfirmDialog';
import { ModalContactHeader } from './ModalContactHeader';
import { DemoDialogTitle, DemoActionTooltip } from './demoMode';

interface CreateProps {
  mode?: 'create';
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  demo?: boolean;
}

interface CreateDirectProps {
  mode: 'create-direct';
  contactId?: string;
  contactName?: string;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

interface EditProps {
  mode: 'edit';
  visit: Visit;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

type Props = CreateProps | CreateDirectProps | EditProps;

export function DeliveryWindowModal(props: Props) {
  const showToast = useToast();
  const isEdit = props.mode === 'edit';
  const isCreateDirect = props.mode === 'create-direct';
  const visit = isEdit ? props.visit : undefined;

  const isCardAction = !isEdit && !isCreateDirect;
  const demo = isCardAction ? !!(props as CreateProps).demo : false;
  const contactEmail = isCardAction ? (props as CreateProps).ctx.contactEmail : undefined;
  const cfg = isCardAction ? ((props as CreateProps).handler.config || {}) : {};
  const contactName = isEdit
    ? visit?.customerName
    : isCreateDirect
      ? (props as CreateDirectProps).contactName
      : (props as CreateProps).ctx.contactName;
  const contactId = isEdit
    ? visit?.customerId
    : isCreateDirect
      ? (props as CreateDirectProps).contactId
      : (props as CreateProps).ctx.contactId;

  const defaultTitle = isEdit
    ? (visit?.title || 'Delivery')
    : ((cfg.defaultTitle as string) || (contactName ? `Delivery — ${contactName}` : 'Delivery'));
  const initialStart = isEdit && visit
    ? dayjs(visit.startAt)
    : dayjs().add(24, 'hour').startOf('hour');
  const initialEnd = isEdit && visit
    ? dayjs(visit.endAt)
    : initialStart.add(4, 'hour');

  const initialTitleRef   = useRef(defaultTitle);
  const initialStartRef   = useRef(initialStart);
  const initialEndRef     = useRef(initialEnd);
  const initialLocationRef = useRef(isEdit ? (visit?.location || '') : '');
  const initialNotesRef   = useRef(isEdit ? (visit?.notes || '') : '');

  const [title, setTitle] = useState(defaultTitle);
  const [range, setRange] = useState<DateRange<Dayjs>>([initialStart, initialEnd]);
  const [location, setLocation] = useState(isEdit ? (visit?.location || '') : '');
  const [notes, setNotes] = useState(isEdit ? (visit?.notes || '') : '');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [startTimeWarning, setStartTimeWarning] = useState(false);
  const [pastConfirmOpen, setPastConfirmOpen] = useState(false);

  const hasUnsavedChanges = (() => {
    const [rs, re] = range;
    return (
      title !== initialTitleRef.current ||
      location !== initialLocationRef.current ||
      notes !== initialNotesRef.current ||
      (rs !== null && !rs.isSame(initialStartRef.current)) ||
      (re !== null && !re.isSame(initialEndRef.current))
    );
  })();

  useEffect(() => {
    if (!props.open) {
      setStartTimeWarning(false);
      return;
    }

    function checkApproaching() {
      const start = range[0];
      if (!start || !start.isValid()) {
        setStartTimeWarning(false);
        return;
      }
      const minutesUntilStart = start.diff(dayjs(), 'minute');
      setStartTimeWarning(minutesUntilStart < 15);
    }

    checkApproaching();
    const interval = setInterval(checkApproaching, 60_000);
    return () => clearInterval(interval);
  }, [props.open, range]);

  function handleClose() {
    setError('');
    props.onClose();
  }

  const { confirmOpen: confirmDiscardOpen, handleRequestClose, handleKeepEditing } = useDiscardGuard(
    demo ? false : hasUnsavedChanges,
    handleClose,
    submitting,
  );

  async function doSubmit() {
    if (demo) return;
    const [start, end] = range;
    if (!start || !start.isValid() || !end || !end.isValid()) return;

    setSubmitting(true);
    try {
      if (isEdit && visit) {
        // Google Calendar is the single source of truth for edits.
        // Visits without a googleEventId pre-date the migration and cannot be
        // edited here — the user is prompted to re-schedule.
        if (!visit.googleEventId) {
          setError('This appointment was created before the Google Calendar migration. Please delete it and create a new one from the shared calendar.');
          return;
        }

        // Offline-aware edit. When offline / on a network error the calendar
        // update is queued and replayed on reconnect.
        const { sendOrQueue } = await import('../../lib/offlineQueue');
        const res = await sendOrQueue({
          area: 'visit',
          label: `Edit delivery window — ${visit.customerName || visit.id}`,
          method: 'PATCH',
          url: `/api/events/${visit.googleEventId}`,
          body: {
            summary: title.trim(),
            description: notes.trim() || '',
            location: location.trim() || '',
            start: { dateTime: start.toDate().toISOString() },
            end: { dateTime: end.toDate().toISOString() },
          },
          dedupeKey: `gcal:${visit.googleEventId}`,
        });

        if (res.queued) {
          showToast('Delivery window update saved offline — the Google Calendar event will sync when you reconnect', false);
          handleClose();
          props.onSaved?.();
          return;
        }

        if (!res.ok) {
          const data = res.data as { error?: string; code?: string } | undefined;
          if (data?.code === 'GOOGLE_AUTH' || data?.code === 'GOOGLE_ERROR') {
            throw new Error("Google account isn't connected — reconnect in your profile to sync Calendar.");
          }
          throw new Error(data?.error || 'Could not save.');
        }

        showToast('Delivery window updated', false);
        handleClose();
        props.onSaved?.();
      } else if (isCreateDirect) {
        // Create-direct → Google Calendar is the single source of truth.
        // No local visits row is written; failures stay in-modal so the user
        // can connect Google / retry without losing their input.
        try {
          await POST('/api/events', {
            moContactId: contactId || '',
            moVisitType: 'delivery',
            summary: title.trim(),
            description: notes.trim() || '',
            location: location.trim() || '',
            start: { dateTime: start.toDate().toISOString() },
            end: { dateTime: end.toDate().toISOString() },
          });
        } catch (gcalErr) {
          setError(calendarErrorMessage(gcalErr));
          return;
        }

        showToast('Delivery window scheduled to the shared calendar', false);
        handleClose();
        props.onSaved?.();
      } else {
        // Card-action create → shared Google Calendar is the single source of
        // truth. No local visits row; failures stay in-modal so the user can
        // connect Google / retry without losing their input.
        try {
          await POST('/api/events', {
            summary: title.trim(),
            description: notes.trim() || '',
            location: location.trim() || '',
            start: { dateTime: start.toDate().toISOString() },
            end: { dateTime: end.toDate().toISOString() },
          });
        } catch (gcalErr) {
          setError(calendarErrorMessage(gcalErr));
          return;
        }

        showToast('Delivery window scheduled to the shared calendar', false);
        handleClose();
        props.onSaved?.();
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'START_IN_PAST') {
        setError('Visit start time is in the past. Please choose a future time.');
      } else {
        setError('Could not save: ' + (e instanceof Error ? e.message : 'error'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit() {
    if (demo) return;
    setError('');
    if (!title.trim()) { setError('Title is required.'); return; }
    const [start, end] = range;
    if (!start || !start.isValid()) { setError('Delivery window start is required.'); return; }
    if (!end || !end.isValid()) { setError('Delivery window end is required.'); return; }
    if (!end.isAfter(start)) { setError('End must be after start.'); return; }

    if (start.isBefore(dayjs())) {
      setPastConfirmOpen(true);
      return;
    }

    void doSubmit();
  }

  const isLegacyAppointment = isEdit && visit && !visit.googleEventId;

  const dialogTitle = isEdit
    ? (contactName ? `Edit delivery window for ${contactName}` : 'Edit delivery window')
    : (contactName ? `Schedule delivery window for ${contactName}` : 'Schedule delivery window');

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

      <Dialog open={props.open} onClose={handleRequestClose} maxWidth="sm" fullWidth>
        <DemoDialogTitle demo={demo}>{dialogTitle}</DemoDialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            {isCardAction && (
              <ModalContactHeader name={contactName} email={contactEmail} />
            )}
            {isLegacyAppointment && (
              <Alert severity="warning">
                This appointment was created before the Google Calendar migration and cannot be edited here.
                Please delete it and create a new one from the shared calendar.
              </Alert>
            )}
            <TextField
              id="cah-dw-title"
              label="Title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 120 } }}
              fullWidth
              size="small"
            />
            <DateTimeRangePicker
              value={range}
              onChange={(v: DateRange<Dayjs>) => setRange(v)}
              localeText={{ start: 'Window start', end: 'Window end' }}
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
            />
            {startTimeWarning && (
              <Alert severity="warning" sx={{ py: 0.5 }}>
                {range[0] && range[0].isBefore(dayjs())
                  ? 'The selected start time has already passed. Please choose a future time.'
                  : 'The selected start time is less than 15 minutes away. You may want to update it.'}
              </Alert>
            )}
            <TextField
              id="cah-dw-location"
              label="Location (optional)"
              value={location}
              onChange={e => setLocation(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 300 } }}
              placeholder="Delivery address"
              fullWidth
              size="small"
            />
            <TextField
              id="cah-dw-notes"
              label="Notes (optional)"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 4000 } }}
              placeholder="Access instructions, contact on site, etc."
              multiline
              minRows={3}
              fullWidth
              size="small"
            />
            <Typography variant="caption" color="text.secondary">
              {isEdit
                ? 'Changes are saved to the shared Measure Once Google Calendar.'
                : 'This delivery window is added to the shared Measure Once Google Calendar.'}
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
              disabled={submitting || demo || !!isLegacyAppointment}
              data-testid="cah-primary"
            >
              {submitting ? (isEdit ? 'Saving…' : 'Scheduling…') : (isEdit ? 'Save changes' : 'Schedule')}
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
