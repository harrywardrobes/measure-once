import React, { useState } from 'react';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
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
import type { Visit } from '../../pages/customer-detail/types';
import { PATCH } from '../../utils/api';

const VISIT_TYPE_LABELS: Record<string, string> = {
  design:       'Design visit',
  survey:       'Survey',
  installation: 'Installation slot',
  delivery:     'Delivery window',
  remedial:     'Remedial',
  workshop:     'Workshop',
  other:        'Other',
};

function visitTypeLabel(type?: string): string {
  if (!type) return 'Visit';
  return VISIT_TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

interface Props {
  visit: Visit;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export function GenericVisitEditModal({ visit, open, onClose, onSaved }: Props) {
  const label = visitTypeLabel(visit.type);

  const [title, setTitle] = useState(visit.title || label);
  const [range, setRange] = useState<DateRange<Dayjs>>([
    dayjs(visit.startAt),
    dayjs(visit.endAt),
  ]);
  const [location, setLocation] = useState(visit.location || '');
  const [notes, setNotes] = useState(visit.notes || '');
  const [updateGcal, setUpdateGcal] = useState(!!visit.googleEventId);
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
    if (!start || !start.isValid()) { setError('Start date/time is required.'); return; }
    if (!end || !end.isValid()) { setError('End date/time is required.'); return; }
    if (!end.isAfter(start)) { setError('End must be after start.'); return; }

    setSubmitting(true);
    const w = window as unknown as { showToast?: (m: string, e: boolean) => void };
    try {
      await PATCH(`/api/visits/${visit.id}`, {
        type: visit.type,
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
          w.showToast?.(`${label} updated; Google Calendar update failed: ${msg}`, true);
          handleClose();
          onSaved?.();
          return;
        }
      }

      w.showToast?.(`${label} updated`, false);
      handleClose();
      onSaved?.();
    } catch (e) {
      setError('Could not save: ' + (e instanceof Error ? e.message : 'error'));
    } finally {
      setSubmitting(false);
    }
  }

  const dialogTitle = visit.customerName
    ? `Edit ${label.toLowerCase()} for ${visit.customerName}`
    : `Edit ${label.toLowerCase()}`;

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Dialog open={open} onClose={submitting ? undefined : handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>{dialogTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <TextField
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
              localeText={{ start: 'Start', end: 'End' }}
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
            />
            <TextField
              label="Location (optional)"
              value={location}
              onChange={e => setLocation(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 300 } }}
              fullWidth
              size="small"
            />
            <TextField
              label="Notes (optional)"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              slotProps={{ htmlInput: { maxLength: 4000 } }}
              multiline
              minRows={3}
              fullWidth
              size="small"
            />
            {visit.googleEventId && (
              <FormControlLabel
                control={
                  <Checkbox
                    checked={updateGcal}
                    onChange={e => setUpdateGcal(e.target.checked)}
                    size="small"
                    disabled={submitting}
                  />
                }
                label="Also update my Google Calendar event"
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
            startIcon={submitting ? <CircularProgress size={14} color="inherit" /> : undefined}
            data-testid="generic-visit-save"
          >
            {submitting ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogActions>
      </Dialog>
    </LocalizationProvider>
  );
}
