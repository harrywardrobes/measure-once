import React, { useState, useCallback, useEffect, useMemo, useRef, lazy, Suspense } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import EditCalendarIcon from '@mui/icons-material/EditCalendar';
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import { DateTimeEditor } from '../../components/DateTimeEditor';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { CalendarTask } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';
import { useConnectionToast } from '../../contexts/ConnectionToastContext';
import { broadcastUrgencyChanged } from '../../utils/broadcastUrgencyChanged';
import { broadcastTaskChanged } from '../../utils/broadcastTaskChanged';
import { DOM_FLUSH_DELAY_MS } from '../../constants/timings';
import { TaskList, categorizeTaskItems, type TaskListItem } from '../../components/tasks/TaskList';
import { parseUpcomingEvents, eventTypeLabel, type UpcomingEvent } from '../../utils/calendarEvents';

// The shared task-creation modal (same one used by the Contact Customer modal's
// "Call Later"). Lazy so its date-picker deps stay out of the detail bundle
// until the user actually adds a task.
const TaskModal = lazy(() =>
  import('../../components/modals/TaskModal').then((m) => ({ default: m.TaskModal })),
);

interface Props {
  contactId: string;
  contactName: string;
  contactEmail?: string;
  contactPhone?: string;
  contactMobile?: string;
  tasks: CalendarTask[];
  onTasksChange: (tasks: CalendarTask[]) => void;
}

export function TasksSection({ contactId, contactName, contactEmail, contactPhone, contactMobile, tasks, onTasksChange }: Props) {
  const { notifyApiError } = useConnectionToast();
  const { isViewer } = usePrivilege();

  // When the Tasks section enters the viewport, broadcast a task-changed event
  // for this contact so the badge on the parent customer card re-fetches its
  // open-task count.  This catches the case where a user leaves the page open
  // for a long time and scrolls to a contact whose badge was never fetched (or
  // was fetched before tasks changed).  The IntersectionObserver fires each
  // time the section enters the viewport so repeated scrolls-away-and-back
  // also refresh the badge.
  const sectionRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            broadcastTaskChanged(contactId);
          }
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => { observer.disconnect(); };
  }, [contactId]);

  // When the page is navigated to with the #tasks-section hash (e.g. from the
  // open-tasks badge on the customer card), scroll this section into view once
  // it mounts.  Uses a retry loop because tasks can load asynchronously and
  // the element may not be present at the first attempt.
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (scrolledRef.current) return;
    if (window.location.hash !== '#tasks-section') return;
    scrolledRef.current = true;
    let attempts = 0;
    const tryScroll = () => {
      const el = document.getElementById('tasks-section');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (attempts < 10) {
        attempts++;
        // 150 ms retry interval is specific to this hash-scroll retry loop —
        // long enough to cover an async task-list render without hammering
        // the DOM on every frame.
        setTimeout(tryScroll, 150);
      }
    };
    // Small initial delay lets React flush the render tree before scrolling.
    setTimeout(tryScroll, DOM_FLUSH_DELAY_MS);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // This contact's calendar events (visits etc.), past + upcoming, so the
  // feed mirrors the home screen — upcoming ones sit in the open list, past
  // ones drop into the collapsed "Done / Past" section. Best-effort: a Google
  // auth/connection failure just leaves the feed showing tasks only.
  const [events, setEvents] = useState<UpcomingEvent[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/events?contactId=${encodeURIComponent(contactId)}&includePast=1`, {
      headers: { Accept: 'application/json' },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data) => { if (!cancelled) setEvents(parseUpcomingEvents(data)); })
      .catch(() => { if (!cancelled) setEvents([]); });
    return () => { cancelled = true; };
  }, [contactId]);

  const [taskModalOpen, setTaskModalOpen] = useState(false);

  const [editingTaskId, setEditingTaskId]   = useState<string | null>(null);
  const [editDueDate,   setEditDueDate]     = useState<Dayjs | null>(null);
  const [editSaving,    setEditSaving]      = useState(false);

  const [editingSubjectId,    setEditingSubjectId]    = useState<string | null>(null);
  const [editSubject,         setEditSubject]         = useState('');
  const [editSubjectSaving,   setEditSubjectSaving]   = useState(false);

  // Normalise this contact's tasks + calendar events into the shared feed model.
  const items: TaskListItem[] = useMemo(() => [
    ...tasks.map((t) => ({
      id: t.id,
      kind: 'task' as const,
      title: t.task_name || 'Untitled',
      when: t.task_deadline || null,
      pastWhen: t.task_completed_at ?? t.task_deadline ?? null,
      status: t.task_status,
      contactId,
      assigneeName: t.task_assigned_user?.name || undefined,
    })),
    ...events.map((e) => ({
      id: `ev:${e.id}`,
      kind: 'event' as const,
      title: e.title,
      when: e.start,
      contactId: e.contactId || contactId,
      eventTypeLabel: eventTypeLabel(e.visitType),
    })),
  ], [tasks, events, contactId]);

  const { open, past } = useMemo(() => categorizeTaskItems(items, Date.now()), [items]);

  const handleTaskCreated = useCallback((task: CalendarTask) => {
    onTasksChange([...tasks, task]);
    broadcastUrgencyChanged(contactId);
    // TaskModal already fires broadcastTaskChanged(contactId) on success.
  }, [contactId, tasks, onTasksChange]);

  const toggleTaskDone = useCallback(async (item: TaskListItem, nextDone: boolean) => {
    if (item.kind !== 'task') return;
    const taskId = item.id;
    const newStatus: 'open' | 'completed' = nextDone ? 'completed' : 'open';
    const nowIso = new Date().toISOString();
    const updatedTasks = tasks.map(t =>
      t.id === taskId ? { ...t, task_status: newStatus, task_completed_at: nextDone ? nowIso : null } : t,
    );
    onTasksChange(updatedTasks);
    let succeeded = false;
    try {
      const r = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_status: newStatus }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      succeeded = true;
    } catch (e) {
      notifyApiError('google', e);
      onTasksChange(tasks);
    }
    if (succeeded) {
      broadcastUrgencyChanged(contactId);
      broadcastTaskChanged(contactId);
    }
  }, [contactId, tasks, onTasksChange, notifyApiError]);

  const deleteTask = useCallback(async (taskId: string) => {
    const removed = tasks.find(t => t.id === taskId);
    const idx     = tasks.findIndex(t => t.id === taskId);
    if (idx === -1) return;
    const next = [...tasks];
    next.splice(idx, 1);
    onTasksChange(next);
    let succeeded = false;
    try {
      const r = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`${r.status}`);
      succeeded = true;
    } catch (e) {
      notifyApiError('google', e);
      if (removed) {
        const restore = [...next];
        restore.splice(idx, 0, removed);
        onTasksChange(restore);
      }
    }
    if (succeeded) {
      broadcastUrgencyChanged(contactId);
      broadcastTaskChanged(contactId);
    }
  }, [contactId, tasks, onTasksChange, notifyApiError]);

  const startEditSubject = useCallback((task: CalendarTask) => {
    setEditingTaskId(null);
    setEditSubject(task.task_name || '');
    setEditingSubjectId(task.id);
  }, []);

  const saveSubject = useCallback(async (taskId: string) => {
    const trimmed = editSubject.trim();
    if (!trimmed) return;
    setEditSubjectSaving(true);
    const optimistic = tasks.map(t =>
      t.id === taskId ? { ...t, task_name: trimmed } : t,
    );
    onTasksChange(optimistic);
    try {
      const r = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_name: trimmed }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      setEditingSubjectId(null);
    } catch (e) {
      notifyApiError('google', e);
      onTasksChange(tasks);
    } finally {
      setEditSubjectSaving(false);
    }
  }, [editSubject, tasks, onTasksChange, notifyApiError]);

  const startEditDue = useCallback((task: CalendarTask) => {
    setEditingSubjectId(null);
    setEditDueDate(task.task_deadline ? dayjs(task.task_deadline) : dayjs().add(1, 'day').startOf('hour'));
    setEditingTaskId(task.id);
  }, []);

  const saveDueDate = useCallback(async (taskId: string) => {
    if (!editDueDate || !editDueDate.isValid()) return;
    setEditSaving(true);
    const isoStr = editDueDate.toISOString();
    const optimistic = tasks.map(t =>
      t.id === taskId ? { ...t, task_deadline: isoStr } : t,
    );
    onTasksChange(optimistic);
    let succeeded = false;
    try {
      const r = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_deadline: isoStr }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      succeeded = true;
      setEditingTaskId(null);
    } catch (e) {
      notifyApiError('google', e);
      onTasksChange(tasks);
    } finally {
      setEditSaving(false);
    }
    if (succeeded) broadcastUrgencyChanged(contactId);
  }, [contactId, editDueDate, tasks, onTasksChange, notifyApiError]);

  // Inline editors (subject / due date) replace a row's default title+meta block
  // while the row chrome (tick, container) stays shared with every other surface.
  const renderItemBody = useCallback((item: TaskListItem): React.ReactNode => {
    if (item.kind !== 'task') return null;

    if (editingSubjectId === item.id) {
      return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <input
            type="text"
            value={editSubject}
            onChange={e => setEditSubject(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void saveSubject(item.id);
              if (e.key === 'Escape') setEditingSubjectId(null);
            }}
            autoFocus
            style={{
              flex: 1, fontSize: 13, borderRadius: 6,
              border: '1px solid var(--stone-deep)', padding: '2px 6px',
              fontFamily: 'inherit', minWidth: 0,
            }}
          />
          <IconButton size="small" onClick={() => void saveSubject(item.id)} disabled={editSubjectSaving} title="Save subject" sx={{ color: 'success.main', p: '2px' }}>
            <CheckIcon sx={{ fontSize: '0.875rem' }} />
          </IconButton>
          <IconButton size="small" onClick={() => setEditingSubjectId(null)} title="Cancel" sx={{ color: 'var(--stone-deep)', p: '2px', '&:hover': { color: 'error.main' } }}>
            <CloseIcon sx={{ fontSize: '0.875rem' }} />
          </IconButton>
        </Box>
      );
    }

    if (editingTaskId === item.id) {
      return (
        <Box>
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
            {item.title}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Box sx={{ width: 220 }}>
              <DateTimeEditor value={editDueDate} onChange={(v) => setEditDueDate(v)} />
            </Box>
            <IconButton size="small" onClick={() => void saveDueDate(item.id)} disabled={editSaving} title="Save due date" sx={{ color: 'success.main', p: '2px' }}>
              <CheckIcon sx={{ fontSize: '0.875rem' }} />
            </IconButton>
            <IconButton size="small" onClick={() => setEditingTaskId(null)} title="Cancel" sx={{ color: 'var(--stone-deep)', p: '2px', '&:hover': { color: 'error.main' } }}>
              <CloseIcon sx={{ fontSize: '0.875rem' }} />
            </IconButton>
          </Box>
        </Box>
      );
    }

    return null; // default body
  }, [editingSubjectId, editingTaskId, editSubject, editSubjectSaving, editDueDate, editSaving, saveSubject, saveDueDate]);

  // Trailing controls per task row: edit subject / due (open tasks) + delete.
  const renderItemActions = useCallback((item: TaskListItem): React.ReactNode => {
    if (item.kind !== 'task' || isViewer) return null;
    if (editingSubjectId === item.id || editingTaskId === item.id) return null;
    const task = tasks.find(t => t.id === item.id);
    if (!task) return null;
    const isDone = item.status === 'completed';
    return (
      <>
        {!isDone && (
          <IconButton size="small" onClick={() => startEditSubject(task)} title="Edit subject" sx={{ color: 'var(--stone-deep)', p: '2px', '&:hover': { color: 'var(--orchid)' } }}>
            <DriveFileRenameOutlineIcon sx={{ fontSize: '0.9rem' }} />
          </IconButton>
        )}
        {!isDone && (
          <IconButton size="small" onClick={() => startEditDue(task)} title="Edit due date" sx={{ color: 'var(--stone-deep)', p: '2px', '&:hover': { color: 'var(--orchid)' } }}>
            <EditCalendarIcon sx={{ fontSize: '0.9rem' }} />
          </IconButton>
        )}
        <IconButton size="small" onClick={() => void deleteTask(item.id)} title="Delete task" sx={{ color: 'var(--stone-deep)', p: '2px', '&:hover': { color: 'error.main' } }}>
          <DeleteOutlineIcon sx={{ fontSize: '0.9rem' }} />
        </IconButton>
      </>
    );
  }, [isViewer, editingSubjectId, editingTaskId, tasks, startEditSubject, startEditDue, deleteTask]);

  return (
      <div id="tasks-section" ref={sectionRef} className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--ink-2)' }}>Tasks</h3>
          {!isViewer && (
            <button
              id="add-task-btn"
              onClick={() => setTaskModalOpen(true)}
              className="text-xs font-semibold px-2.5 py-1 rounded-lg transition"
              style={{ color: 'var(--orchid)' }}
            >
              + Add task
            </button>
          )}
        </div>

        <TaskList
          openItems={open}
          pastItems={past}
          onToggleDone={isViewer ? undefined : toggleTaskDone}
          renderItemActions={renderItemActions}
          renderItemBody={renderItemBody}
          emptyText="No tasks yet."
        />

        {taskModalOpen && (
          <Suspense fallback={null}>
            <TaskModal
              open
              onClose={() => setTaskModalOpen(false)}
              contactId={contactId}
              contactName={contactName}
              contactEmail={contactEmail}
              contactPhone={contactPhone}
              contactMobile={contactMobile}
              title="New task"
              onCreated={handleTaskCreated}
            />
          </Suspense>
        )}
      </div>
  );
}
