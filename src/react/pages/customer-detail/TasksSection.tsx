import React, { useState, useCallback } from 'react';
import { HubSpotTask, stageColour, STAGE_KEYS } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';

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
  const { isViewer } = usePrivilege();

  const [showAddTask, setShowAddTask] = useState(false);
  const [subject, setSubject]   = useState('');
  const [dueDate, setDueDate]   = useState('');
  const [stageKey, setStageKey] = useState('');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState<string | null>(null);

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
      setSubject('');
      setDueDate('');
      setStageKey('');
      setShowAddTask(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'error';
      setError(`Failed to create task: ${msg}`);
    } finally {
      setSaving(false);
    }
  }, [contactId, dueDate, stageKey, subject, tasks, onTasksChange]);

  const toggleTaskDone = useCallback(async (taskId: string, currentlyDone: boolean) => {
    const newStatus = currentlyDone ? 'NOT_STARTED' : 'COMPLETED';
    const updatedTasks = tasks.map(t =>
      t.id === taskId ? { ...t, properties: { ...t.properties, hs_task_status: newStatus } } : t,
    );
    onTasksChange(updatedTasks);
    try {
      const r = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hs_task_status: newStatus, contactId }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
    } catch {
      onTasksChange(tasks);
    }
  }, [contactId, tasks, onTasksChange]);

  const deleteTask = useCallback(async (taskId: string) => {
    const removed = tasks.find(t => t.id === taskId);
    const idx     = tasks.findIndex(t => t.id === taskId);
    if (idx === -1) return;
    const next = [...tasks];
    next.splice(idx, 1);
    onTasksChange(next);
    try {
      const r = await fetch(`/api/tasks/${taskId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
    } catch {
      if (removed) {
        const restore = [...next];
        restore.splice(idx, 0, removed);
        onTasksChange(restore);
      }
    }
  }, [contactId, tasks, onTasksChange]);

  return (
    <div id="tasks-section" className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-700">Tasks</h3>
        {!isViewer && (
          <button
            id="add-task-btn"
            onClick={() => setShowAddTask(v => !v)}
            className="text-xs font-semibold text-blue-600 hover:text-blue-700 px-2.5 py-1 rounded-lg hover:bg-blue-50 transition"
          >
            {showAddTask ? 'Cancel' : '+ Add task'}
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

      {showAddTask && (
        <div className="add-task-form">
          <input
            id="task-subject"
            type="text"
            placeholder="Task description..."
            value={subject}
            onChange={e => setSubject(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && saveNewTask()}
            className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm mb-2 focus:outline-none focus:border-blue-400 bg-white"
            style={{ fontSize: 16 }}
          />
          <div className="flex gap-2 mb-2">
            <input
              id="task-due"
              type="date"
              value={dueDate}
              onChange={e => setDueDate(e.target.value)}
              className="flex-1 min-w-0 border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400 bg-white"
              style={{ fontSize: 16 }}
            />
            <select
              id="task-stage"
              value={stageKey}
              onChange={e => setStageKey(e.target.value)}
              className="flex-1 min-w-0 border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400 bg-white"
              style={{ fontSize: 16 }}
            >
              <option value="">No stage</option>
              {stageOptions}
            </select>
          </div>
          <button
            onClick={saveNewTask}
            disabled={saving}
            className="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-medium py-2.5 rounded-xl transition"
            style={{ minHeight: 44 }}
          >
            {saving ? 'Saving…' : 'Save task'}
          </button>
        </div>
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
              <div key={task.id} className={`task-item${isDone ? ' task-done' : ''}`}>
                <button
                  className={`task-check${isDone ? ' task-check-done' : ''}`}
                  onClick={() => toggleTaskDone(task.id, isDone)}
                  title={isDone ? 'Mark incomplete' : 'Mark complete'}
                >
                  {isDone && (
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </button>
                <div className="task-content">
                  <div className={`task-subject${isDone ? ' task-subject-done' : ''}`}>{subj}</div>
                  <div className="task-meta">
                    {slabel && colour && (
                      <span className="task-stage-pill" style={{ background: colour.light, color: colour.text }}>
                        {slabel}
                      </span>
                    )}
                    {dueLabel && (
                      <span className={`task-due${overdue ? ' task-due-overdue' : ''}`}>
                        {overdue ? '⚠ ' : ''}{dueLabel}
                      </span>
                    )}
                  </div>
                </div>
                <button className="task-delete" onClick={() => deleteTask(task.id)} title="Delete task">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-slate-400 italic">No tasks yet.</p>
      )}
    </div>
  );
}
