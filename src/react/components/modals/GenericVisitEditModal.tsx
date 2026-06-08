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
import { PATCH, POST, isGoogleAuthError } from '../../utils/api';
import { useToast } from '../../contexts/ToastContext';

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

interface EditProps {
  mode?: 'edit';
  visit: Visit;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

interface CreateProps {
  mode: 'create';
  visitType: string;
  contactId: string;
  contactName?: string;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

type Props = EditProps | CreateProps;

export function GenericVisitEditModal(props: Props) {
  const showToast = useToast();
  const isCreate = props.mode === 'create';
  const isEdit = !isCreate;

  const visitType = isCreate ? props.visitType : props.visit.type;
  const label = visitTypeLabel(visitType);

  const contactName = isCreate ? props.contactName : props.visit.customerName;
  const contactId   = isCreate ? props.contactId   : props.visit.customerId;

  const defaultTitle = isCreate
    ? (contactName ? `${label} — ${contactName}` : label)
    : (isEdit ? (props.visit.title || label) : label);

  const initialStart = isCreate
    ? dayjs().add(24, 'hour').startOf('hour')
    : dayjs(props.visit.startAt);
  const initialEnd = isCreate
    ? initialStart.add(2, 'hour')
    : dayjs(props.visit.endAt);

  const [title, setTitle] = useState(defaultTitle);
  const [range, setRange] = useState<DateRange<Dayjs>>([initialStart, initialEnd]);
  const [location, setLocation] = useState(isCreate ? '' : (props.visit.location || ''));
  const [notes, setNotes] = useState(isCreate ? '' : (props.visit.notes || ''));
  const [gcalChecked, setGcalChecked] = useState(
    isCreate ? true : !!(props.visit.googleEventId)
  );
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function handleClose() {
    setError('');
    props.onClose();
  }

  async function handleSubmit() {
    setError('');
    if (!title.trim()) { setError('Title is required.'); return; }
    const [start, end] = range;
    if (!start || !start.isValid()) { setError('Start date/time is required.'); return; }
    if (!end || !end.isValid()) { setError('End date/time is required.'); return; }
    if (!end.isAfter(start)) { setError('End must be after start.'); return; }

    setSubmitting(true);
    try {
      if (isCreate) {
        await POST('/api/visits', {
          type: visitType,
          title: title.trim(),
          customerId: contactId || null,
          customerName: contactName || null,
          startAt: start.toDate().toISOString(),
          endAt: end.toDate().toISOString(),
          location: location.trim() || null,
          notes: notes.trim() || null,
        });

        if (gcalChecked) {
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
            showToast(`${label} scheduled; Google Calendar add failed: ${gcalMsg}`, true);
            handleClose();
            props.onSaved?.();
            return;
          }
        }

        showToast(`${label} scheduled`, false);
        handleClose();
        props.onSaved?.();
      } else {
        const visit = props.visit;
        // Offline-aware edit. When offline / on a network error the visit update
        // is queued and replayed on reconnect; the cached version/updated_at base
        // lets the sync engine detect a stale overwrite for the conflict view.
        const { sendOrQueue } = await import('../../lib/offlineQueue');
        const res = await sendOrQueue({
          area: 'visit',
          label: `Edit ${label.toLowerCase()} — ${contactName || visit.id}`,
          method: 'PATCH',
          url: `/api/visits/${visit.id}`,
          body: {
            type: visit.type,
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
          showToast(`${label} update saved offline — it will sync when you reconnect`, false);
          handleClose();
          props.onSaved?.();
          return;
        }

        if (gcalChecked && visit.googleEventId) {
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
            showToast(`${label} updated; Google Calendar update failed: ${gcalMsg}`, true);
            handleClose();
            props.onSaved?.();
            return;
          }
        }

        showToast(`${label} updated`, false);
        handleClose();
        props.onSaved?.();
      }
    } catch (e) {
      setError('Could not save: ' + (e instanceof Error ? e.message : 'error'));
    } finally {
      setSubmitting(false);
    }
  }

  const dialogTitle = isCreate
    ? (contactName ? `Schedule ${label.toLowerCase()} for ${contactName}` : `Schedule ${label.toLowerCase()}`)
    : (contactName ? `Edit ${label.toLowerCase()} for ${contactName}` : `Edit ${label.toLowerCase()}`);

  const gcalLabel = isCreate
    ? 'Also add to my Google Calendar'
    : 'Also update my Google Calendar event';

  const showGcal = isCreate || !!(props.visit.googleEventId);

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Dialog open={props.open} onClose={submitting ? undefined : handleClose} maxWidth="sm" fullWidth>
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
            {showGcal && (
              <FormControlLabel
                control={
                  <Checkbox
                    checked={gcalChecked}
                    onChange={e => setGcalChecked(e.target.checked)}
                    size="small"
                    disabled={submitting}
                  />
                }
                label={gcalLabel}
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
            {submitting
              ? (isCreate ? 'Scheduling…' : 'Saving…')
              : (isCreate ? 'Schedule' : 'Save changes')}
          </Button>
        </DialogActions>
      </Dialog>
    </LocalizationProvider>
  );
}
