import React, { useEffect, useState } from 'react';
import { TASK_MODAL_DRAFT_PREFIX } from '../../constants/localStorageKeys';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { DateTimeEditor } from '../DateTimeEditor';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { POST, calendarErrorMessage, isGoogleAuthError } from '../../utils/api';
import { broadcastTaskChanged } from '../../utils/broadcastTaskChanged';
import { openConnectModal, useServiceStatuses } from '../../contexts/ConnectionToastContext';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { FullScreenModal } from './FullScreenModal';
import { ModalContactHeader } from './ModalContactHeader';
import type { CalendarTask, StaffUser } from '../../pages/customer-detail/types';

export interface TaskModalProps {
  open: boolean;
  onClose: () => void;
  contactId: string;
  contactName: string;
  contactEmail?: string;
  onCreated?: (task: CalendarTask) => void;
  demo?: boolean;
}

interface DraftState {
  taskName: string;
  taskDescription: string;
  assignedUserId: string;
  assignedUserName: string;
  deadlineDt?: string;
}

function draftKey(contactId: string): string {
  return `${TASK_MODAL_DRAFT_PREFIX}${contactId || 'unknown'}`;
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
  try { localStorage.setItem(key, JSON.stringify(draft)); } catch { /* quota */ }
}

function clearDraft(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export function TaskModal({
  open,
  onClose,
  contactId,
  contactName,
  contactEmail,
  onCreated,
  demo,
}: TaskModalProps) {
  const showToast = useToast();
  const { user: currentUser } = useAuth();
  const serviceStatuses = useServiceStatuses();
  const googleDisconnected = serviceStatuses.get('google') === 'error';

  const key = draftKey(contactId);
  const draft = demo ? {} : loadDraft(key);

  const currentUserId = currentUser?.id ? String(currentUser.id) : '';
  const currentUserName = [currentUser?.first_name, currentUser?.last_name].filter(Boolean).join(' ').trim() || '';

  const [taskName,        setTaskName]        = useState(draft.taskName ?? '');
  const [taskDescription, setTaskDescription] = useState(draft.taskDescription ?? '');
  const [assignedUserId,  setAssignedUserId]  = useState(draft.assignedUserId ?? currentUserId);
  const [assignedUserName, setAssignedUserName] = useState(draft.assignedUserName ?? currentUserName);
  const [deadlineDt,      setDeadlineDt]      = useState<Dayjs | null>(
    draft.deadlineDt ? dayjs(draft.deadlineDt) : dayjs().add(1, 'day').startOf('hour'),
  );

  const [users,        setUsers]        = useState<StaffUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [submitting,   setSubmitting]   = useState(false);
  const [error,        setError]        = useState('');

  useEffect(() => {
    if (!open || demo) return;
    setUsersLoading(true);
    fetch('/api/users', { headers: { Accept: 'application/json' } })
      .then(r => r.ok ? (r.json() as Promise<StaffUser[]>) : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => {
        setUsers(data);
        if (!assignedUserId && currentUserId) {
          const me = data.find(u => u.id === currentUserId);
          if (me) {
            setAssignedUserId(me.id);
            setAssignedUserName(me.name);
          }
        }
      })
      .catch(() => { /* non-fatal — user can still submit */ })
      .finally(() => setUsersLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (demo) return;
    saveDraft(key, {
      taskName,
      taskDescription,
      assignedUserId,
      assignedUserName,
      deadlineDt: deadlineDt?.toISOString(),
    });
  }, [key, taskName, taskDescription, assignedUserId, assignedUserName, deadlineDt, demo]);

  function handleUserChange(userId: string) {
    setAssignedUserId(userId);
    const found = users.find(u => u.id === userId);
    setAssignedUserName(found?.name ?? '');
  }

  async function handleSubmit() {
    if (demo) { onClose(); return; }
    setError('');
    if (!taskName.trim()) { setError('Task name is required.'); return; }
    if (!deadlineDt || !deadlineDt.isValid()) { setError('Deadline is required.'); return; }

    setSubmitting(true);
    try {
      const task = await POST('/api/tasks', {
        task_name: taskName.trim(),
        task_description: taskDescription.trim() || undefined,
        task_customer: { contactId, contactName },
        task_assigned_user: { userId: assignedUserId, name: assignedUserName },
        task_deadline: deadlineDt.toISOString(),
      }) as CalendarTask;
      showToast('Task added to the shared calendar', false);
      clearDraft(key);
      broadcastTaskChanged(contactId);
      onCreated?.(task);
      onClose();
    } catch (e) {
      const msg = calendarErrorMessage(e);
      setError(msg);
      if (isGoogleAuthError(e)) {
        openConnectModal('google', 'Google Calendar is disconnected — reconnect it to add tasks.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose() {
    if (submitting) return;
    onClose();
  }

  return (
      <FullScreenModal
        open={open}
        onClose={handleClose}
        disableClose={submitting}
        title={`Schedule call-back${contactName ? ` for ${contactName}` : ''}`}
        footer={
          <>
            <Button onClick={handleClose} disabled={submitting}>Cancel</Button>
            <Button
              variant="contained"
              onClick={() => void handleSubmit()}
              disabled={submitting || demo}
              data-testid="task-modal-submit"
            >
              {submitting ? 'Saving…' : 'Add task'}
            </Button>
          </>
        }
      >
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <ModalContactHeader
            name={contactName}
            email={contactEmail}
          />

          {googleDisconnected && !demo && (
            <Alert
              severity="warning"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => openConnectModal('google', 'Reconnect Google Calendar to add tasks.')}
                >
                  Reconnect
                </Button>
              }
            >
              Google Calendar is disconnected — tasks can&apos;t be added until you reconnect.
            </Alert>
          )}

          {error && <Alert severity="error">{error}</Alert>}

          <TextField
            id="task-modal-name"
            label="Task name"
            value={taskName}
            onChange={e => setTaskName(e.target.value)}
            slotProps={{ htmlInput: { maxLength: 200 } }}
            placeholder="e.g. Follow-up call with customer"
            fullWidth
            size="small"
            required
          />

          <TextField
            id="task-modal-description"
            label="Notes (optional)"
            value={taskDescription}
            onChange={e => setTaskDescription(e.target.value)}
            slotProps={{ htmlInput: { maxLength: 2000 } }}
            placeholder="Any context for this task…"
            multiline
            minRows={2}
            fullWidth
            size="small"
          />

          <DateTimeEditor
            label="Deadline"
            value={deadlineDt}
            onChange={(v) => setDeadlineDt(v)}
            id="task-modal-deadline"
            required
          />

          <FormControl size="small" fullWidth>
            <InputLabel id="task-modal-assignee-label">Assigned to</InputLabel>
            <Select
              labelId="task-modal-assignee-label"
              id="task-modal-assignee"
              value={assignedUserId}
              label="Assigned to"
              onChange={e => handleUserChange(e.target.value)}
              disabled={usersLoading}
            >
              {users.length === 0 && assignedUserId && (
                <MenuItem value={assignedUserId}>{assignedUserName || assignedUserId}</MenuItem>
              )}
              {users.map(u => (
                <MenuItem key={u.id} value={u.id}>{u.name || u.email}</MenuItem>
              ))}
            </Select>
          </FormControl>

          <Typography variant="caption" color="text.secondary">
            This task is added to the shared Measure Once Google Calendar.
          </Typography>
        </Stack>
      </FullScreenModal>
  );
}
