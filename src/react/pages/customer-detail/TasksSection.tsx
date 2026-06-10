import React, { useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import EditCalendarIcon from '@mui/icons-material/EditCalendar';
import { HubSpotTask, stageColour, STAGE_KEYS } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';
import { useConnectionToast } from '../../context/ConnectionToastContext';
import { broadcastUrgencyChanged } from '../../utils/broadcastUrgencyChanged';

interface Workflow {
  stages?: Record<string, { label: string }>;
}

interface Props {
  contactId: string;
  tasks: HubSpotTask[];
  workflow: Workflow | null;
  onTasksChange: (tasks: HubSpotTask[]) => void;
}

function getTaskUrgency(tasks: HubSpotTask[]): string | null {
  const now = Date.now();
  const oneDay = now + 86400000;
  const twoDay = now + 172800000;
  let urgency: string | null = null;
  for (const t of tasks) {
    if (t.properties?.hs_task_status === 'COMPLETED') continue;
    const due = parseInt(t.properties?.hs_timestamp || '0', 10);
    if (!due) continue;
    if (due <= oneDay) { urgency = 'red'; break; }
    else if (due <= twoDay && urgency !== 'red') urgency = 'orange';
  }
  return urgency;
}

export function TasksSection({ contactId, tasks, workflow, onTasksChange }: Props) {
  const { notifyApiError } = useConnectionToast();
  const { isViewer } = usePrivilege();

  const [showAddTask, setShowAddTask] = useState(false);
  const [subject, setSubject]   = useState('');
  const [dueDate, setDueDate]   = useState('');
  const [stageKey, setStageKey] = useState('');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editDueDate, setEditDueDate]     = useState('');
  const [editSaving, setEditSaving]       = useState(false);

  const sorted = [...tasks].sort((a, b) => {
    const aDone = a.properties?.hs_task_status === 'COMPLETED';
    const bDone = b.properties?.hs_task_status === 'COMPLETED';
    if (aDone !== bDone) return aDone ? 1 : -1;
    return parseInt(a.properties?.hs_timestamp || '0', 10) - parseInt(b.properties?.hs_timestamp || '0', 10);
  });

  const stageOptions = Object.entries(workflow?.stages || {}).map(([k, s]) => (
    <option key={k} value={k}>{s.label}</option>
  ));

  const saveNewTask = useCallback(async () => {
    if (!subject.trim()) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/contacts/${contactId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: subject.trim(), dueDate: dueDate || null, stageKey: stageKey || null }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      const task: HubSpotTask = await r.json();
      onTasksChange([...tasks, task]);
      broadcastUrgencyChanged(contactId);
      setSubject('');
      setDueDate('');
      setStageKey('');
      setShowAddTask(false);
    } catch (e: unknown) {
      notifyApiError('hubspot', e);
      const msg = e instanceof Error ? e.message : 'error';
      setError(`Failed to create task: ${msg}`);
    } finally {
      setSaving(false);
    }
  }, [contactId, dueDate, stageKey, subject, tasks, onTasksChange, notifyApiError]);

  const toggleTaskDone = useCallback(async (taskId: string, currentlyDone: boolean) => {
    const newStatus = currentlyDone ? 'NOT_STARTED' : 'COMPLETED';
    const updatedTasks = tasks.map(t =>
      t.id === taskId ? { ...t, properties: { ...t.properties, hs_task_status: newStatus } } : t,
    );
    onTasksChange(updatedTasks);
    let succeeded = false;
    try {
      const r = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hs_task_status: newStatus, contactId }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      succeeded = true;
    } catch (e) {
      notifyApiError('hubspot', e);
      onTasksChange(tasks);
    }
    if (succeeded) broadcastUrgencyChanged(contactId);
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
      const r = await fetch(`/api/tasks/${taskId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      succeeded = true;
    } catch (e) {
      notifyApiError('hubspot', e);
      if (removed) {
        const restore = [...next];
        restore.splice(idx, 0, removed);
        onTasksChange(restore);
      }
    }
    if (succeeded) broadcastUrgencyChanged(contactId);
  }, [contactId, tasks, onTasksChange, notifyApiError]);

  const startEditDue = useCallback((task: HubSpotTask) => {
    const dueTsMs = task.properties?.hs_timestamp ? parseInt(task.properties.hs_timestamp, 10) : null;
    const dateStr = dueTsMs ? new Date(dueTsMs).toISOString().slice(0, 10) : '';
    setEditDueDate(dateStr);
    setEditingTaskId(task.id);
  }, []);

  const saveDueDate = useCallback(async (taskId: string) => {
    setEditSaving(true);
    const newTimestamp = editDueDate
      ? new Date(editDueDate + 'T12:00:00').toISOString()
      : '';
    const newTsMs = editDueDate ? String(new Date(editDueDate + 'T12:00:00').getTime()) : '';
    const optimistic = tasks.map(t =>
      t.id === taskId
        ? { ...t, properties: { ...t.properties, hs_timestamp: newTsMs } }
        : t,
    );
    onTasksChange(optimistic);
    let succeeded = false;
    try {
      const r = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, hs_timestamp: newTimestamp }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      succeeded = true;
      setEditingTaskId(null);
    } catch (e) {
      notifyApiError('hubspot', e);
      onTasksChange(tasks);
    } finally {
      setEditSaving(false);
    }
    if (succeeded) broadcastUrgencyChanged(contactId);
  }, [contactId, editDueDate, tasks, onTasksChange, notifyApiError]);

  return (
    <div id="tasks-section" className="mb-6">
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
            onKeyDown={e => e.key === 'Enter' && saveNewTask()}
            className="w-full border rounded-xl px-4 py-2.5 text-sm mb-2 focus:outline-none"
            style={{ fontSize: 16 }}
          />
          <div className="flex gap-2 mb-2">
            <input
              id="task-due"
              type="date"
              value={dueDate}
              onChange={e => setDueDate(e.target.value)}
              className="flex-1 min-w-0 border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
              style={{ fontSize: 16 }}
            />
            <select
              id="task-stage"
              value={stageKey}
              onChange={e => setStageKey(e.target.value)}
              className="flex-1 min-w-0 border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
              style={{ fontSize: 16 }}
            >
              <option value="">No stage</option>
              {stageOptions}
            </select>
          </div>
          <button
            onClick={saveNewTask}
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
            const p        = task.properties || {};
            const subj     = p.hs_task_subject || 'Untitled';
            const body     = p.hs_task_body || '';
            const sk       = body.startsWith('TASK_STAGE:') ? body.slice('TASK_STAGE:'.length).trim() : null;
            const slabel   = sk ? (workflow?.stages?.[sk]?.label || sk) : null;
            const colour   = sk ? stageColour(sk) : null;
            const isDone   = p.hs_task_status === 'COMPLETED';
            const dueTsMs  = p.hs_timestamp ? parseInt(p.hs_timestamp, 10) : null;
            const overdue  = !!dueTsMs && dueTsMs < Date.now() && !isDone;
            const dueLabel = dueTsMs
              ? new Date(dueTsMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
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
                  onClick={() => toggleTaskDone(task.id, isDone)}
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
                  <Typography sx={{
                    fontSize: '0.875rem',
                    color: isDone ? 'var(--ink-4)' : 'var(--ink-1)',
                    lineHeight: 1.4,
                    wordBreak: 'break-word',
                    textDecoration: isDone ? 'line-through' : 'none',
                  }}>
                    {subj}
                  </Typography>

                  {(slabel || dueLabel || (!isDone && !isViewer)) && (
                    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', mt: '5px' }}>
                      {slabel && colour && (
                        <Chip
                          label={slabel}
                          size="small"
                          sx={{
                            fontSize: '0.67rem',
                            fontWeight: 700,
                            height: 'auto',
                            borderRadius: 'var(--radius-pill)',
                            background: colour.light,
                            color: colour.text,
                            letterSpacing: '0.02em',
                            '& .MuiChip-label': { px: '7px', py: '2px' },
                          }}
                        />
                      )}
                      {!isDone && !isViewer && editingTaskId === task.id ? (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <input
                            type="date"
                            value={editDueDate}
                            onChange={e => setEditDueDate(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') saveDueDate(task.id);
                              if (e.key === 'Escape') setEditingTaskId(null);
                            }}
                            style={{ fontSize: 13, borderRadius: 6, border: '1px solid var(--stone-deep)', padding: '2px 6px' }}
                          />
                          <Box
                            component="button"
                            onClick={() => saveDueDate(task.id)}
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
                  onClick={() => deleteTask(task.id)}
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
  );
}
