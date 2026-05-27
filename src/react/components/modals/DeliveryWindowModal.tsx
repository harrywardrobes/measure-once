import React, { useEffect, useState } from 'react';
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
import { POST, PATCH } from '../../utils/api';

interface CreateProps {
  mode?: 'create';
  handler: CardActionHandlerData;
  ctx: CardActionContext;
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

type Props = CreateProps | EditProps;

export function DeliveryWindowModal(props: Props) {
  const isEdit = props.mode === 'edit';
  const visit = isEdit ? props.visit : undefined;

  const cfg = !isEdit ? (props.handler.config || {}) : {};
  const contactName = !isEdit ? props.ctx.contactName : visit?.customerName;
  const contactId   = !isEdit ? props.ctx.contactId   : visit?.customerId;

  const defaultTitle = isEdit
    ? (visit?.title || 'Delivery')
    : ((cfg.defaultTitle as string) || (contactName ? `Delivery — ${contactName}` : 'Delivery'));
  const addToGoogleDefault = !isEdit ? (cfg.addToGoogleCalendar as boolean) !== false : false;

  const initialStart = isEdit && visit
    ? dayjs(visit.startAt)
    : dayjs().add(24, 'hour').startOf('hour');
  const initialEnd = isEdit && visit
    ? dayjs(visit.endAt)
    : initialStart.add(4, 'hour');

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

  async function doSubmit() {
    const [start, end] = range;
    if (!start || !start.isValid() || !end || !end.isValid()) return;

    setSubmitting(true);
    const w = window as unknown as { showToast?: (m: string, e: boolean) => void };
    try {
      if (isEdit && visit) {
        await PATCH(`/api/visits/${visit.id}`, {
          type: 'delivery',
          title: title.trim(),
          customerId: visit.customerId || null,
          customerName: visit.customerName || null,
          startAt: start.toDate().toISOString(),
          endAt: end.toDate().toISOString(),
          location: location.trim() || null,
          notes: notes.trim() || null,
        });

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
            const msg = gcalErr instanceof Error ? gcalErr.message : 'error';
            w.showToast?.(`Delivery window updated; Google Calendar update failed: ${msg}`, true);
            handleClose();
            props.onSaved?.();
            return;
          }
        }

        w.showToast?.('Delivery window updated', false);
        handleClose();
        props.onSaved?.();
      } else {
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
            const msg = gcalErr instanceof Error ? gcalErr.message : 'error';
            w.showToast?.(`Delivery window saved; Google Calendar add failed: ${msg}`, true);
            handleClose();
            (window as unknown as { renderUpcomingVisits?: () => void }).renderUpcomingVisits?.();
            props.onSaved?.();
            return;
          }
        }

        w.showToast?.('Delivery window scheduled', false);
        handleClose();
        (window as unknown as { renderUpcomingVisits?: () => void }).renderUpcomingVisits?.();
        props.onSaved?.();
      }
    } catch (e) {
      setError('Could not save: ' + (e instanceof Error ? e.message : 'error'));
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

      <Dialog open={props.open} onClose={handleClose} maxWidth="sm" fullWidth>
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
            {!isEdit && (
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
            {error && (
              <Typography variant="caption" color="error">{error}</Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={submitting}>Cancel</Button>
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
    </LocalizationProvider>
  );
}
