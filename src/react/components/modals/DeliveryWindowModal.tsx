import React, { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
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
import { POST, PATCH, isGoogleAuthError, calendarErrorMessage } from '../../utils/api';
import { useToast } from '../../contexts/ToastContext';
import { useDiscardGuard } from '../../hooks/useDiscardGuard';
import { DiscardConfirmDialog } from './DiscardConfirmDialog';
import { broadcastLeadStatusChange } from '../../utils/broadcastLeadStatus';

interface CreateProps {
  mode?: 'create';
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
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

  const cfg = (!isEdit && !isCreateDirect) ? ((props as CreateProps).handler.config || {}) : {};
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
  const addToGoogleDefault = !isEdit && !isCreateDirect;

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
  const [addGcal, setAddGcal] = useState(addToGoogleDefault);
  const [updateGcal, setUpdateGcal] = useState(isEdit && !!visit?.googleEventId);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [startTimeWarning, setStartTimeWarning] = useState(false);
  const [pastConfirmOpen, setPastConfirmOpen] = useState(false);

  const initialAddGcalRef    = useRef(addToGoogleDefault);
  const initialUpdateGcalRef = useRef(isEdit && !!visit?.googleEventId);

  const hasUnsavedChanges = (() => {
    const [rs, re] = range;
    return (
      title !== initialTitleRef.current ||
      location !== initialLocationRef.current ||
      notes !== initialNotesRef.current ||
      (rs !== null && !rs.isSame(initialStartRef.current)) ||
      (re !== null && !re.isSame(initialEndRef.current)) ||
      addGcal !== initialAddGcalRef.current ||
      updateGcal !== initialUpdateGcalRef.current
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
    hasUnsavedChanges,
    handleClose,
    submitting,
  );

  async function doSubmit() {
    const [start, end] = range;
    if (!start || !start.isValid() || !end || !end.isValid()) return;

    setSubmitting(true);
    try {
      if (isEdit && visit) {
        // Offline-aware edit. When offline / on a network error the visit update
        // is queued and replayed on reconnect; the cached version/updated_at base
        // lets the sync engine detect a stale overwrite for the conflict view.
        const { sendOrQueue, queueCalendarUpdate } = await import('../../lib/offlineQueue');
        const res = await sendOrQueue({
          area: 'visit',
          label: `Edit delivery window — ${visit.customerName || visit.id}`,
          method: 'PATCH',
          url: `/api/visits/${visit.id}`,
          body: {
            type: 'delivery',
            title: title.trim(),
            customerId: visit.customerId || null,
            customerName: visit.customerName || null,
            startAt: start.toDate().toISOString(),
            endAt: end.toDate().toISOString(),
            location: location.trim() || null,
            notes: notes.trim() || null,
          },
          conflictCheckUrl: `/api/visits/${visit.id}`,
          recordKey: `visit:${visit.id}`,
          dedupeKey: `visit:${visit.id}`,
          baseVersion: visit.version ?? null,
          baseUpdatedAt: visit.updatedAt ?? null,
        });
        if (!res.queued && !res.ok) {
          throw new Error((res.data as { error?: string })?.error || 'Could not save.');
        }
        if (res.queued) {
          if (updateGcal && visit.googleEventId) {
            await queueCalendarUpdate({
              googleEventId: visit.googleEventId,
              summary: title.trim(),
              description: notes.trim() || '',
              location: location.trim() || '',
              startISO: start.toDate().toISOString(),
              endISO: end.toDate().toISOString(),
              label: `Update Google Calendar — ${visit.customerName || visit.id}`,
            });
            showToast('Delivery window update saved offline — the visit and its Google Calendar event will sync when you reconnect', false);
          } else {
            showToast('Delivery window update saved offline — it will sync when you reconnect', false);
          }
          handleClose();
          props.onSaved?.();
          return;
        }

        const _d = res.data as { hs_lead_status?: string; hw_lead_substatus?: string } | undefined;
        if (_d?.hs_lead_status || _d?.hw_lead_substatus) {
          broadcastLeadStatusChange(contactId ?? '', {
            hs_lead_status: _d.hs_lead_status ?? '',
            hw_lead_substatus: _d.hw_lead_substatus ?? '',
          });
        }

        if (updateGcal && visit.googleEventId) {
          try {
            await PATCH(`/api/events/${visit.googleEventId}`, {
              summary: title.trim(),
              description: notes.trim() || '',
              location: location.trim() || '',
              start: { dateTime: start.toDate().toISOString() },
              end: { dateTime: end.toDate().toISOString() },
            });
          } catch (gcalErr) {
            const gcalMsg = isGoogleAuthError(gcalErr)
              ? "Google account isn't connected — reconnect in your profile to sync Calendar."
              : gcalErr instanceof Error ? gcalErr.message : 'error';
            showToast(`Delivery window updated; Google Calendar update failed: ${gcalMsg}`, true);
            handleClose();
            props.onSaved?.();
            return;
          }
        }

        showToast('Delivery window updated', false);
        handleClose();
        props.onSaved?.();
      } else if (isCreateDirect) {
        await POST('/api/visits', {
          type: 'delivery',
          title: title.trim(),
          customerId: contactId || null,
          customerName: contactName || null,
          startAt: start.toDate().toISOString(),
          endAt: end.toDate().toISOString(),
          location: location.trim() || null,
          notes: notes.trim() || null,
        });

        if (addGcal) {
          try {
            await POST('/api/events', {
              summary: title.trim(),
              description: notes.trim() || '',
              location: location.trim() || '',
              start: { dateTime: start.toDate().toISOString() },
              end: { dateTime: end.toDate().toISOString() },
            });
          } catch (gcalErr) {
            const gcalMsg = isGoogleAuthError(gcalErr)
              ? "Google account isn't connected — reconnect in your profile to sync Calendar."
              : gcalErr instanceof Error ? gcalErr.message : 'error';
            showToast(`Delivery window saved; Google Calendar add failed: ${gcalMsg}`, true);
            handleClose();
            (window as unknown as { renderUpcomingVisits?: () => void }).renderUpcomingVisits?.();
            props.onSaved?.();
            return;
          }
        }

        showToast('Delivery window scheduled', false);
        handleClose();
        (window as unknown as { renderUpcomingVisits?: () => void }).renderUpcomingVisits?.();
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
        <DialogTitle>{dialogTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
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
            {isEdit && visit?.googleEventId && (
              <FormControlLabel
                control={
                  <Checkbox
                    id="cah-dw-update-google"
                    checked={updateGcal}
                    onChange={e => setUpdateGcal(e.target.checked)}
                    size="small"
                  />
                }
                label="Also update my Google Calendar event"
              />
            )}
            {isCreateDirect && (
              <FormControlLabel
                control={
                  <Checkbox
                    id="cah-dw-google"
                    checked={addGcal}
                    onChange={e => setAddGcal(e.target.checked)}
                    size="small"
                  />
                }
                label="Also add to my Google Calendar"
              />
            )}
            {!isEdit && !isCreateDirect && (
              <Typography variant="caption" color="text.secondary">
                This delivery window is added to the shared Measure Once Google Calendar.
              </Typography>
            )}
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
            {submitting ? (isEdit ? 'Saving…' : 'Scheduling…') : (isEdit ? 'Save changes' : 'Schedule')}
          </Button>
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
