import React, { useState } from 'react';
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
import { POST } from '../../utils/api';

interface Props {
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
}

export function DeliveryWindowModal({ handler, ctx, open, onClose }: Props) {
  const cfg = handler.config || {};
  const defaultTitle =
    (cfg.defaultTitle as string) ||
    (ctx.contactName ? `Delivery — ${ctx.contactName}` : 'Delivery');
  const addToGoogleDefault = (cfg.addToGoogleCalendar as boolean) !== false;

  const initialStart = dayjs().add(24, 'hour').startOf('hour');
  const initialEnd = initialStart.add(4, 'hour');

  const [title, setTitle] = useState(defaultTitle);
  const [range, setRange] = useState<DateRange<Dayjs>>([initialStart, initialEnd]);
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [addGcal, setAddGcal] = useState(addToGoogleDefault);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function handleClose() {
    setError('');
    onClose();
  }

  async function handleSubmit() {
    setError('');
    if (!title.trim()) { setError('Title is required.'); return; }
    const [start, end] = range;
    if (!start || !start.isValid()) { setError('Delivery window start is required.'); return; }
    if (!end || !end.isValid()) { setError('Delivery window end is required.'); return; }
    if (!end.isAfter(start)) { setError('End must be after start.'); return; }

    setSubmitting(true);
    try {
      await POST('/api/visits', {
        type: 'delivery',
        title: title.trim(),
        customerId: ctx.contactId || null,
        customerName: ctx.contactName || null,
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
          const w = window as unknown as { showToast?: (m: string, e: boolean) => void };
          w.showToast?.(`Delivery window saved; Google Calendar add failed: ${msg}`, true);
          handleClose();
          (window as unknown as { renderUpcomingVisits?: () => void }).renderUpcomingVisits?.();
          return;
        }
      }

      const w = window as unknown as { showToast?: (m: string, e: boolean) => void };
      w.showToast?.('Delivery window scheduled', false);
      handleClose();
      (window as unknown as { renderUpcomingVisits?: () => void }).renderUpcomingVisits?.();
    } catch (e) {
      setError('Could not save: ' + (e instanceof Error ? e.message : 'error'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>
          {ctx.contactName
            ? `Schedule delivery window for ${ctx.contactName}`
            : 'Schedule delivery window'}
        </DialogTitle>
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
            {submitting ? 'Scheduling…' : 'Schedule'}
          </Button>
        </DialogActions>
      </Dialog>
    </LocalizationProvider>
  );
}
