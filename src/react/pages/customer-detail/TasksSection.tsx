import React, { useState, useCallback, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import EditCalendarIcon from '@mui/icons-material/EditCalendar';
import DriveFileRenameOutlineIcon from '@mui/icons-material/DriveFileRenameOutline';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { CalendarTask } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';
import { useConnectionToast } from '../../contexts/ConnectionToastContext';
import { broadcastUrgencyChanged } from '../../utils/broadcastUrgencyChanged';
import { broadcastTaskChanged } from '../../utils/broadcastTaskChanged';
import { DOM_FLUSH_DELAY_MS } from '../../constants/timings';

interface Props {
  contactId: string;
  tasks: CalendarTask[];
  onTasksChange: (tasks: CalendarTask[]) => void;
}

function getTaskUrgency(tasks: CalendarTask[]): string | null {
  const now = Date.now();
  const oneDay = now + 86400000;
  const twoDay = now + 172800000;
  let urgency: string | null = null;
  for (const t of tasks) {
    if (t.task_status === 'completed') continue;
    const due = t.task_deadline ? new Date(t.task_deadline).getTime() : 0;
    if (!due) continue;
    if (due <= oneDay) { urgency = 'red'; break; }
    else if (due <= twoDay && urgency !== 'red') urgency = 'orange';
  }
  return urgency;
}

export function TasksSection({ contactId, tasks, onTasksChange }: Props) {
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

  const [showAddTask, setShowAddTask] = useState(false);
  const [subject,    setSubject]      = useState('');
  const [dueDate,    setDueDate]      = useState<Dayjs | null>(
    dayjs().add(1, 'day').startOf('hour'),
  );
  const [saving, setSaving]   = useState(false);
  const [error,  setError]    = useState<string | null>(null);

  const [editingTaskId, setEditingTaskId]   = useState<string | null>(null);
  const [editDueDate,   setEditDueDate]     = useState<Dayjs | null>(null);
  const [editSaving,    setEditSaving]      = useState(false);

  const [editingSubjectId,    setEditingSubjectId]    = useState<string | null>(null);
  const [editSubject,         setEditSubject]         = useState('');
  const [editSubjectSaving,   setEditSubjectSaving]   = useState(false);

  const sorted = [...tasks].sort((a, b) => {
    const aDone = a.task_status === 'completed';
    const bDone = b.task_status === 'completed';
    if (aDone !== bDone) return aDone ? 1 : -1;
    const aTime = a.task_deadline ? new Date(a.task_deadline).getTime() : 0;
    const bTime = b.task_deadline ? new Date(b.task_deadline).getTime() : 0;
    return aTime - bTime;
  });

  const saveNewTask = useCallback(async () => {
    if (!subject.trim()) return;
    setSaving(true);
    try {
      const r = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_name: subject.trim(),
          task_customer: { contactId, contactName: '' },
          task_assigned_user: { userId: '', name: '' },
          task_deadline: dueDate?.toISOString() ?? new Date().toISOString(),
        }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      const task: CalendarTask = await r.json();
      onTasksChange([...tasks, task]);
      broadcastUrgencyChanged(contactId);
      broadcastTaskChanged(contactId);
      setSubject('');
      setDueDate(dayjs().add(1, 'day').startOf('hour'));
      setShowAddTask(false);
    } catch (e: unknown) {
      notifyApiError('google', e);
      const msg = e instanceof Error ? e.message : 'error';
      setError(`Failed to create task: ${msg}`);
    } finally {
      setSaving(false);
    }
  }, [contactId, dueDate, subject, tasks, onTasksChange, notifyApiError]);

  const toggleTaskDone = useCallback(async (taskId: string, currentlyDone: boolean) => {
    const newStatus: 'open' | 'completed' = currentlyDone ? 'open' : 'completed';
    const updatedTasks = tasks.map(t =>
      t.id === taskId ? { ...t, task_status: newStatus } : t,
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

  void getTaskUrgency;

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <div id="tasks-section" ref={sectionRef} className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--ink-2)' }}>Tasks</h3>
          {!isViewer && (
            <button
              id="add-task-btn"
              onClick={() => setShowAddTask(v => !v)}
              className="text-xs font-semibold px-2.5 py-1 rounded-lg transition"
              style={{ color: 'var(--orchid)' }}
            >
              {showAddTask ? 'Cancel' : '+ Add task'}
            </button>
          )}
        </div>

        {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

        {showAddTask && (
          <Box sx={{
            background: 'var(--paper-deep)',
            border: '1px solid var(--stone)',
            borderRadius: 'var(--radius-lg)',
            p: '12px',
            mb: '12px',
          }}>
            <input
              id="task-subject"
              type="text"
              placeholder="Task description..."
              value={subject}
              onChange={e => setSubject(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && void saveNewTask()}
              className="w-full border rounded-xl px-4 py-2.5 text-sm mb-2 focus:outline-none"
              style={{ fontSize: 16 }}
            />
            <Box sx={{ mb: '8px' }}>
              <DateTimePicker
                label="Due date & time"
                value={dueDate}
                onChange={(v: Dayjs | null) => setDueDate(v)}
                slotProps={{ textField: { fullWidth: true, size: 'small' } }}
              />
            </Box>
            <button
              onClick={() => void saveNewTask()}
              disabled={saving}
              className="w-full text-white text-sm font-medium py-2.5 rounded-xl transition task-save-btn"
              style={{ minHeight: 44, background: 'var(--orchid)' }}
            >
              {saving ? 'Saving…' : 'Save task'}
            </button>
          </Box>
        )}

        {sorted.length > 0 ? (
          <div className="space-y-1.5">
            {sorted.map(task => {
              const isDone   = task.task_status === 'completed';
              const dueMs    = task.task_deadline ? new Date(task.task_deadline).getTime() : null;
              const overdue  = !!dueMs && dueMs < Date.now() && !isDone;
              const dueLabel = dueMs
                ? new Date(dueMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                : null;

              return (
                <Box
                  key={task.id}
                  sx={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '10px',
                    background: 'var(--paper)',
                    border: '1px solid var(--stone)',
                    borderRadius: 'var(--radius-lg)',
                    p: '10px 12px',
                    transition: 'background 0.1s',
                    boxShadow: 'var(--shadow-sm)',
                    opacity: isDone ? 0.55 : 1,
                    '&:active': { background: 'var(--paper-deep)' },
                  }}
                >
                  <Box
                    component="button"
                    onClick={() => void toggleTaskDone(task.id, isDone)}
                    title={isDone ? 'Mark incomplete' : 'Mark complete'}
                    sx={{
                      width: 20,
                      height: 20,
                      borderRadius: '50%',
                      border: isDone ? 'none' : '2px solid var(--stone-deep)',
                      background: isDone ? 'success.dark' : 'none',
                      color: isDone ? 'common.white' : 'inherit',
                      flexShrink: 0,
                      mt: '1px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'border-color 0.15s, background 0.15s',
                      WebkitTapHighlightColor: 'transparent',
                      fontFamily: 'inherit',
                      p: 0,
                      '&:hover': {
                        borderColor: isDone ? undefined : 'var(--orchid)',
                        background: isDone ? 'success.dark' : undefined,
                      },
                    }}
                  >
                    {isDone && <CheckIcon sx={{ fontSize: 12 }} />}
                  </Box>

                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    {!isDone && !isViewer && editingSubjectId === task.id ? (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <input
                          type="text"
                          value={editSubject}
                          onChange={e => setEditSubject(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') void saveSubject(task.id);
                            if (e.key === 'Escape') setEditingSubjectId(null);
                          }}
                          autoFocus
                          style={{
                            flex: 1,
                            fontSize: 13,
                            borderRadius: 6,
                            border: '1px solid var(--stone-deep)',
                            padding: '2px 6px',
                            fontFamily: 'inherit',
                            minWidth: 0,
                          }}
                        />
                        <Box
                          component="button"
                          onClick={() => void saveSubject(task.id)}
                          disabled={editSubjectSaving}
                          title="Save subject"
                          sx={{
                            background: 'none', border: 'none', cursor: editSubjectSaving ? 'default' : 'pointer',
                            color: 'success.main', p: '2px', display: 'flex', alignItems: 'center',
                            borderRadius: 'var(--radius-sm)', fontFamily: 'inherit', flexShrink: 0,
                          }}
                        >
                          <CheckIcon sx={{ fontSize: '0.875rem' }} />
                        </Box>
                        <Box
                          component="button"
                          onClick={() => setEditingSubjectId(null)}
                          title="Cancel"
                          sx={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: 'var(--stone-deep)', p: '2px', display: 'flex', alignItems: 'center',
                            borderRadius: 'var(--radius-sm)', fontFamily: 'inherit', flexShrink: 0,
                            '&:hover': { color: 'error.main' },
                          }}
                        >
                          <CloseIcon sx={{ fontSize: '0.875rem' }} />
                        </Box>
                      </Box>
                    ) : (
                      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
                        <Typography sx={{
                          fontSize: '0.875rem',
                          color: isDone ? 'var(--ink-4)' : 'var(--ink-1)',
                          lineHeight: 1.4,
                          wordBreak: 'break-word',
                          textDecoration: isDone ? 'line-through' : 'none',
                          flex: 1,
                        }}>
                          {task.task_name || 'Untitled'}
                        </Typography>
                        {!isDone && !isViewer && (
                          <Box
                            component="button"
                            onClick={() => startEditSubject(task)}
                            title="Edit subject"
                            sx={{
                              background: 'none', border: 'none', cursor: 'pointer',
                              color: 'var(--stone-deep)', p: '1px', display: 'flex', alignItems: 'center',
                              borderRadius: 'var(--radius-sm)', fontFamily: 'inherit', flexShrink: 0,
                              opacity: 0.6, mt: '2px',
                              '&:hover': { color: 'var(--orchid)', opacity: 1 },
                            }}
                          >
                            <DriveFileRenameOutlineIcon sx={{ fontSize: '0.8rem' }} />
                          </Box>
                        )}
                      </Box>
                    )}

                    {(task.task_assigned_user?.name || dueLabel || (!isDone && !isViewer)) && (
                      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', mt: '5px' }}>
                        {task.task_assigned_user?.name && (
                          <Typography component="span" sx={{ fontSize: '0.72rem', color: 'var(--ink-4)' }}>
                            {task.task_assigned_user.name}
                          </Typography>
                        )}

                        {!isDone && !isViewer && editingTaskId === task.id ? (
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <DateTimePicker
                              value={editDueDate}
                              onChange={(v: Dayjs | null) => setEditDueDate(v)}
                              slotProps={{ textField: { size: 'small', sx: { fontSize: 12, width: 200 } } }}
                            />
                            <Box
                              component="button"
                              onClick={() => void saveDueDate(task.id)}
                              disabled={editSaving}
                              title="Save due date"
                              sx={{
                                background: 'none', border: 'none', cursor: editSaving ? 'default' : 'pointer',
                                color: 'success.main', p: '2px', display: 'flex', alignItems: 'center',
                                borderRadius: 'var(--radius-sm)', fontFamily: 'inherit',
                              }}
                            >
                              <CheckIcon sx={{ fontSize: '0.875rem' }} />
                            </Box>
                            <Box
                              component="button"
                              onClick={() => setEditingTaskId(null)}
                              title="Cancel"
                              sx={{
                                background: 'none', border: 'none', cursor: 'pointer',
                                color: 'var(--stone-deep)', p: '2px', display: 'flex', alignItems: 'center',
                                borderRadius: 'var(--radius-sm)', fontFamily: 'inherit',
                                '&:hover': { color: 'error.main' },
                              }}
                            >
                              <CloseIcon sx={{ fontSize: '0.875rem' }} />
                            </Box>
                          </Box>
                        ) : (
                          <>
                            {dueLabel && (
                              <Typography
                                component="span"
                                sx={{
                                  fontSize: '0.72rem',
                                  color: overdue ? 'error.main' : 'var(--ink-3)',
                                  fontWeight: overdue ? 700 : 500,
                                }}
                              >
                                {overdue ? '⚠ ' : ''}{dueLabel}
                              </Typography>
                            )}
                            {!isDone && !isViewer && (
                              <Box
                                component="button"
                                onClick={() => startEditDue(task)}
                                title="Edit due date"
                                sx={{
                                  background: 'none', border: 'none', cursor: 'pointer',
                                  color: 'var(--stone-deep)', p: '1px', display: 'flex', alignItems: 'center',
                                  borderRadius: 'var(--radius-sm)', fontFamily: 'inherit',
                                  opacity: 0.6,
                                  '&:hover': { color: 'var(--orchid)', opacity: 1 },
                                }}
                              >
                                <EditCalendarIcon sx={{ fontSize: '0.8rem' }} />
                              </Box>
                            )}
                          </>
                        )}
                      </Box>
                    )}
                  </Box>

                  <Box
                    component="button"
                    onClick={() => void deleteTask(task.id)}
                    title="Delete task"
                    sx={{
                      flexShrink: 0,
                      color: 'var(--stone-deep)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      p: '2px',
                      borderRadius: 'var(--radius-sm)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      WebkitTapHighlightColor: 'transparent',
                      fontFamily: 'inherit',
                      transition: 'color 0.15s',
                      mt: '2px',
                      '&:hover': { color: 'error.main' },
                    }}
                  >
                    <CloseIcon sx={{ fontSize: '0.875rem' }} />
                  </Box>
                </Box>
              );
            })}
          </div>
        ) : (
          <p className="text-sm italic" style={{ color: 'var(--stone-deep)' }}>No tasks yet.</p>
        )}
      </div>
    </LocalizationProvider>
  );
}
