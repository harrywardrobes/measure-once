import React, { useState, useRef, useCallback } from 'react';
import { Room, RoomComment, stageColour, STAGE_KEYS } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';

interface Workflow {
  stages?: Record<string, { label: string; statuses?: Array<{ id: string; label: string }> }>;
}

interface Props {
  contactId: string;
  rooms: Room[];
  notes: string;
  workflow: Workflow | null;
  selectedRoomIdx: number;
  onRoomsChange: (rooms: Room[]) => void;
  onNotesChange: (notes: string) => void;
  onRoomSelect: (idx: number) => void;
  onSave: (rooms: Room[], notes: string) => void;
}

export function RoomsTabs({
  contactId,
  rooms,
  notes,
  workflow,
  selectedRoomIdx,
  onRoomsChange,
  onNotesChange,
  onRoomSelect,
  onSave,
}: Props) {
  const { isViewer, isManager } = usePrivilege();
  const canEdit = isManager;

  const [addingRoom, setAddingRoom]   = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [draftComment, setDraftComment] = useState('');
  const [savingComment, setSavingComment] = useState(false);

  const room   = rooms[selectedRoomIdx];
  const colour = stageColour(room?.stageKey || 'sales');

  const todayISO = () => new Date().toISOString().split('T')[0];

  const addRoom = useCallback(() => {
    const name = newRoomName.trim() || `Room ${rooms.length + 1}`;
    const newRoom: Room = {
      room: name,
      stageKey: 'sales',
      completedStatuses: {},
      comments: [],
      stageDates: { sales: todayISO() },
    };
    const next = [...rooms, newRoom];
    onRoomsChange(next);
    onRoomSelect(next.length - 1);
    setNewRoomName('');
    setAddingRoom(false);
    onSave(next, notes);
  }, [newRoomName, rooms, notes, onRoomsChange, onRoomSelect, onSave]);

  const deleteRoom = useCallback((idx: number) => {
    if (rooms.length <= 1) return;
    const next = [...rooms];
    next.splice(idx, 1);
    const newIdx = Math.min(selectedRoomIdx, next.length - 1);
    onRoomsChange(next);
    onRoomSelect(newIdx);
    onSave(next, notes);
  }, [rooms, selectedRoomIdx, notes, onRoomsChange, onRoomSelect, onSave]);

  const changeStage = useCallback((stageKey: string) => {
    if (!room) return;
    const updated = { ...room, stageKey };
    if (!updated.stageDates[stageKey]) updated.stageDates = { ...updated.stageDates, [stageKey]: todayISO() };
    const next = rooms.map((r, i) => i === selectedRoomIdx ? updated : r);
    onRoomsChange(next);
    onSave(next, notes);
  }, [room, rooms, selectedRoomIdx, notes, onRoomsChange, onSave]);

  const addComment = useCallback(async () => {
    const text = draftComment.trim();
    if (!text) return;
    setSavingComment(true);
    const updated = {
      ...room,
      comments: [
        ...(room.comments || []),
        { text, date: new Date().toISOString(), author: '' },
      ],
    };
    const next = rooms.map((r, i) => i === selectedRoomIdx ? updated : r);
    onRoomsChange(next);
    setDraftComment('');
    try { await onSave(next, notes); } catch { /* noop */ }
    setSavingComment(false);
  }, [draftComment, room, rooms, selectedRoomIdx, notes, onRoomsChange, onSave]);

  const saveNotes = useCallback(async () => {
    try { await onSave(rooms, notes); } catch { /* noop */ }
  }, [rooms, notes, onSave]);

  if (!rooms.length) {
    return <div className="mb-5" />;
  }

  const stageEntries = workflow?.stages
    ? STAGE_KEYS.map(k => ({ key: k, label: workflow!.stages![k]?.label || k }))
    : STAGE_KEYS.map(k => ({ key: k, label: k }));

  const stageLabel = workflow?.stages?.[room?.stageKey]?.label || room?.stageKey || 'Sales';
  const installStart  = room?.installStart;
  const installFinish = room?.installFinish;
  const installLine   = [installStart, installFinish].filter(Boolean).join(' → ');

  return (
    <div className="mb-5">
      <div id="room-tabs-section">
        <div className="room-tabs-bar">
          {rooms.map((r, i) => (
            <button
              key={i}
              className={`room-tab${i === selectedRoomIdx ? ' room-tab-active' : ''}`}
              onClick={() => onRoomSelect(i)}
              title={r.room}
            >
              <span className="room-tab-name">{r.room}</span>
              {rooms.length > 1 && !isViewer && (
                <span
                  className="room-tab-delete"
                  role="button"
                  tabIndex={0}
                  title={`Delete ${r.room}`}
                  onClick={e => { e.stopPropagation(); deleteRoom(i); }}
                  onKeyDown={e => e.key === 'Enter' && deleteRoom(i)}
                >
                  ×
                </span>
              )}
            </button>
          ))}
          {!isViewer && !addingRoom && (
            <button className="room-tab room-tab-add" onClick={() => setAddingRoom(true)} title="Add room">
              + Add room
            </button>
          )}
          {addingRoom && (
            <div className="room-add-form flex items-center gap-2">
              <input
                id="new-room-name"
                type="text"
                placeholder="Room name"
                value={newRoomName}
                onChange={e => setNewRoomName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addRoom(); if (e.key === 'Escape') { setAddingRoom(false); setNewRoomName(''); } }}
                className="border border-slate-300 rounded px-2 py-1 text-sm"
                style={{ fontSize: 16 }}
                autoFocus
              />
              <button className="btn-save-note text-sm" onClick={addRoom}>Add</button>
              <button className="btn-cancel-note text-sm" onClick={() => { setAddingRoom(false); setNewRoomName(''); }}>Cancel</button>
            </div>
          )}
        </div>

        {room && (
          <div className="room-body">
            <div className="room-stage-row flex items-center gap-3 mb-3">
              <span className="text-xs text-slate-500 font-medium">Stage:</span>
              {!isViewer ? (
                <select
                  value={room.stageKey}
                  onChange={e => changeStage(e.target.value)}
                  className="border border-slate-200 rounded px-2 py-1 text-xs bg-white"
                >
                  {stageEntries.map(({ key, label }) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              ) : (
                <span
                  className="text-xs font-semibold px-2 py-0.5 rounded-full"
                  style={{ background: colour.light, color: colour.text }}
                >
                  {stageLabel}
                </span>
              )}
              {installLine && (
                <span className="text-xs text-slate-400 ml-2">Install: {installLine}</span>
              )}
            </div>

            <div id="comments-section" className="mb-4">
              <div className="notes-header flex items-center justify-between mb-2">
                <span className="notes-header-label text-sm font-semibold text-slate-700">Notes</span>
              </div>
              <textarea
                className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm resize-none focus:outline-none focus:border-blue-400 bg-white"
                rows={4}
                placeholder="Room notes…"
                value={notes}
                onChange={e => onNotesChange(e.target.value)}
                onBlur={saveNotes}
                readOnly={isViewer}
                style={{ fontSize: 16 }}
              />

              {!isViewer && (
                <>
                  <div id="comment-input-area" className="mt-2">
                    <textarea
                      id="comment-input"
                      className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm resize-none focus:outline-none focus:border-blue-400 bg-white"
                      rows={2}
                      placeholder="Add a comment…"
                      value={draftComment}
                      onChange={e => setDraftComment(e.target.value)}
                      style={{ fontSize: 16 }}
                    />
                    {draftComment.trim() && (
                      <button
                        className="mt-1 btn-save-note text-xs"
                        onClick={addComment}
                        disabled={savingComment}
                      >
                        {savingComment ? 'Saving…' : 'Add comment'}
                      </button>
                    )}
                  </div>
                </>
              )}

              {(room.comments || []).length > 0 && (
                <div className="mt-3 space-y-2">
                  {[...(room.comments || [])].reverse().map((c, i) => (
                    <div key={i} className="comment-item">
                      <div className="comment-text">{c.text}</div>
                      <div className="comment-meta">
                        {c.author && <span>{c.author}</span>}
                        {c.author && c.date && <span className="comment-meta-sep">·</span>}
                        {c.date && (
                          <span className="comment-date">
                            {new Date(c.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
