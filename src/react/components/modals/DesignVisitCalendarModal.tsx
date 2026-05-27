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
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';
import { POST } from '../../utils/api';

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Props {
  handler: CardActionHandlerData;
  ctx: CardActionContext;
  open: boolean;
  onClose: () => void;
}

export function DesignVisitCalendarModal({ handler, ctx, open, onClose }: Props) {
  const cfg = handler.config || {};
  const defaultDuration = (cfg.defaultDurationMin as number) || 60;
  const defaultTitle =
    (cfg.defaultTitle as string) ||
    (ctx.contactName ? `Design visit — ${ctx.contactName}` : 'Design visit');
  const addToGoogleDefault = (cfg.addToGoogleCalendar as boolean) !== false;

  const now = new Date();
  now.setMinutes(0, 0, 0);
  now.setHours(now.getHours() + 24);

  const [title, setTitle] = useState(defaultTitle);
  const [startVal, setStartVal] = useState(toLocalInputValue(now));
  const [duration, setDuration] = useState(String(defaultDuration));
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
    if (!startVal) { setError('Start time is required.'); return; }
    const durationInt = parseInt(duration, 10);
    if (!Number.isInteger(durationInt) || durationInt < 5) {
      setError('Duration must be ≥ 5 minutes.');
      return;
    }

    const start = new Date(startVal);
    const end = new Date(start.getTime() + durationInt * 60000);

    setSubmitting(true);
    try {
      await POST('/api/visits', {
        type: 'design',
        title: title.trim(),
        customerId: ctx.contactId || null,
        customerName: ctx.contactName || null,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        location: location.trim() || null,
        notes: notes.trim() || null,
      });

      if (addGcal) {
        try {
          await POST('/api/events', {
            summary: title.trim(),
            description: notes.trim() || '',
            location: location.trim() || '',
            start: { dateTime: start.toISOString() },
            end: { dateTime: end.toISOString() },
          });
        } catch (gcalErr) {
          const msg = gcalErr instanceof Error ? gcalErr.message : 'error';
          const w = window as unknown as { showToast?: (m: string, e: boolean) => void };
          w.showToast?.(`Visit saved; Google Calendar add failed: ${msg}`, true);
          handleClose();
          (window as unknown as { renderUpcomingVisits?: () => void }).renderUpcomingVisits?.();
          return;
        }
      }

      const w = window as unknown as { showToast?: (m: string, e: boolean) => void };
      w.showToast?.('Visit scheduled', false);
      handleClose();
      (window as unknown as { renderUpcomingVisits?: () => void }).renderUpcomingVisits?.();
    } catch (e) {
      setError('Could not save: ' + (e instanceof Error ? e.message : 'error'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
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
            <TextField
              id="cah-dv-start"
              label="Start"
              type="datetime-local"
              value={startVal}
              onChange={e => setStartVal(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
              fullWidth
              size="small"
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
          <FormControlLabel
            control={
              <Checkbox
                id="cah-dv-google"
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
  );
}
