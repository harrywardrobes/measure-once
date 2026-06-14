import React, { useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
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
import type { Visit } from '../../pages/customer-detail/types';
import { useDiscardGuard } from '../../hooks/useDiscardGuard';
import { POST, isGoogleAuthError } from '../../utils/api';
import { useToast } from '../../contexts/ToastContext';
import { DiscardConfirmDialog } from './DiscardConfirmDialog';
import { PlacesLocationField } from '../PlacesLocationField';

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

  const initialTitleRef    = useRef(defaultTitle);
  const initialStartRef    = useRef(initialStart);
  const initialEndRef      = useRef(initialEnd);
  const initialLocationRef = useRef(isCreate ? '' : (props.visit.location || ''));
  const initialNotesRef    = useRef(isCreate ? '' : (props.visit.notes || ''));

  const [title, setTitle] = useState(defaultTitle);
  const [range, setRange] = useState<DateRange<Dayjs>>([initialStart, initialEnd]);
  const [location, setLocation] = useState(isCreate ? '' : (props.visit.location || ''));
  const [notes, setNotes] = useState(isCreate ? '' : (props.visit.notes || ''));
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
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

  function handleClose() {
    setError('');
    props.onClose();
  }

  const { confirmOpen: confirmDiscardOpen, handleRequestClose, handleKeepEditing } =
    useDiscardGuard(hasUnsavedChanges, handleClose, submitting);

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
        // Create → Google Calendar is the single source of truth.
        // No local visits row is written; failures stay in-modal so the user
        // can connect Google / retry without losing their input.
        try {
          await POST('/api/events', {
            moContactId: contactId || '',
            moVisitType: visitType,
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
          setError(gcalMsg);
          return;
        }

        showToast(`${label} scheduled to the shared calendar`, false);
        handleClose();
        props.onSaved?.();
      } else {
        const visit = props.visit;
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
          label: `Edit ${label.toLowerCase()} — ${contactName || visit.id}`,
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
          showToast(`${label} update saved offline — the Google Calendar event will sync when you reconnect`, false);
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

  const isLegacyAppointment = isEdit && !isCreate && !(props as EditProps).visit.googleEventId;

  const dialogTitle = isCreate
    ? (contactName ? `Schedule ${label.toLowerCase()} for ${contactName}` : `Schedule ${label.toLowerCase()}`)
    : (contactName ? `Edit ${label.toLowerCase()} for ${contactName}` : `Edit ${label.toLowerCase()}`);

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Dialog open={props.open} onClose={handleRequestClose} maxWidth="sm" fullWidth>
        <DialogTitle>{dialogTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            {isLegacyAppointment && (
              <Alert severity="warning">
                This appointment was created before the Google Calendar migration and cannot be edited here.
                Please delete it and create a new one from the shared calendar.
              </Alert>
            )}
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
            <PlacesLocationField
              surface="genericVisit"
              label="Location (optional)"
              value={location}
              onChange={setLocation}
              maxLength={300}
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
            <Typography variant="caption" color="text.secondary">
              {isCreate
                ? 'This visit is added to the shared Measure Once Google Calendar.'
                : 'Changes are saved to the shared Measure Once Google Calendar.'}
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
            disabled={submitting || isLegacyAppointment}
            startIcon={submitting ? <CircularProgress size={14} color="inherit" /> : undefined}
            data-testid="generic-visit-save"
          >
            {submitting
              ? (isCreate ? 'Scheduling…' : 'Saving…')
              : (isCreate ? 'Schedule' : 'Save changes')}
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
