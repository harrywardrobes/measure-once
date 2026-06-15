import React, { useState, useRef, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import { Room, RoomComment, stageColour, STAGE_KEYS } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';
import { WorkflowDef } from '../../lib/workflowConfig';
import { nowDate } from '../../utils/dateDefaults';

interface Props {
  contactId: string;
  rooms: Room[];
  notes: string;
  workflow: WorkflowDef | null;
  selectedRoomIdx: number;
  onRoomsChange: (rooms: Room[]) => void;
  onNotesChange: (notes: string) => void;
  onRoomSelect: (idx: number) => void;
  onSave: (rooms: Room[], notes: string) => void | Promise<void>;
  onNotesSaved?: () => void;
  onRoomSaved?: () => void;
  onInstallDateSaved?: () => void;
  onCommentSaved?: () => void;
  onRoomSaveError?: () => void;
  onCommentSaveError?: () => void;
  onNotesSaveError?: () => void;
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
  onNotesSaved,
  onRoomSaved,
  onInstallDateSaved,
  onCommentSaved,
  onRoomSaveError,
  onCommentSaveError,
  onNotesSaveError,
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

  const addRoom = useCallback(async () => {
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
    try { await onSave(next, notes); onRoomSaved?.(); } catch { onRoomSaveError?.(); }
  }, [newRoomName, rooms, notes, onRoomsChange, onRoomSelect, onSave, onRoomSaved, onRoomSaveError]);

  const deleteRoom = useCallback(async (idx: number) => {
    if (rooms.length <= 1) return;
    const next = [...rooms];
    next.splice(idx, 1);
    const newIdx = Math.min(selectedRoomIdx, next.length - 1);
    onRoomsChange(next);
    onRoomSelect(newIdx);
    try { await onSave(next, notes); onRoomSaved?.(); } catch { onRoomSaveError?.(); }
  }, [rooms, selectedRoomIdx, notes, onRoomsChange, onRoomSelect, onSave, onRoomSaved, onRoomSaveError]);

  const changeStage = useCallback(async (stageKey: string) => {
    if (!room) return;
    const updated = { ...room, stageKey };
    if (!updated.stageDates[stageKey]) updated.stageDates = { ...updated.stageDates, [stageKey]: todayISO() };
    const next = rooms.map((r, i) => i === selectedRoomIdx ? updated : r);
    onRoomsChange(next);
    try { await onSave(next, notes); onRoomSaved?.(); } catch { onRoomSaveError?.(); }
  }, [room, rooms, selectedRoomIdx, notes, onRoomsChange, onSave, onRoomSaved, onRoomSaveError]);

  const changeInstallDate = useCallback(async (field: 'installStart' | 'installFinish', value: string) => {
    if (!room) return;
    const updated = { ...room, [field]: value || null };
    const next = rooms.map((r, i) => i === selectedRoomIdx ? updated : r);
    onRoomsChange(next);
    try { await onSave(next, notes); onInstallDateSaved?.(); } catch { onRoomSaveError?.(); }
  }, [room, rooms, selectedRoomIdx, notes, onRoomsChange, onSave, onInstallDateSaved, onRoomSaveError]);

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
    try {
      await onSave(next, notes);
      onCommentSaved?.();
    } catch { onCommentSaveError?.(); }
    setSavingComment(false);
  }, [draftComment, room, rooms, selectedRoomIdx, notes, onRoomsChange, onSave, onCommentSaved, onCommentSaveError]);

  const saveNotes = useCallback(async () => {
    try {
      await onSave(rooms, notes);
      onNotesSaved?.();
    } catch { onNotesSaveError?.(); }
  }, [rooms, notes, onSave, onNotesSaved, onNotesSaveError]);

  if (!rooms.length) {
    return (
      <div className="mb-5">
        <Box
          sx={{
            py: 2.5,
            px: 3,
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--stone)',
            background: 'var(--paper)',
            color: 'var(--ink-4)',
            fontSize: '0.875rem',
          }}
        >
          No rooms yet — rooms are added during a design visit.
        </Box>
      </div>
    );
  }

  const stageEntries = workflow?.stages
    ? STAGE_KEYS.map(k => ({ key: k, label: workflow!.stages![k]?.label || k }))
    : STAGE_KEYS.map(k => ({ key: k, label: k }));

  const stageLabel = workflow?.stages?.[room?.stageKey]?.label || room?.stageKey || 'Sales';
  const installStart  = room?.installStart;
  const installFinish = room?.installFinish;
  const installLine   = [installStart, installFinish].filter(Boolean).join(' → ');

  const tabBaseSx = {
    fontSize: '.88rem',
    fontWeight: 600,
    px: 2,
    py: 1,
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--stone)',
    background: 'var(--paper)',
    color: 'var(--ink-3)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'background 0.15s, color 0.15s, border-color 0.15s',
    whiteSpace: 'nowrap',
    WebkitTapHighlightColor: 'transparent',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    '@media (pointer: coarse)': { minHeight: 44 },
    '&:hover': { background: 'var(--paper-deep)', color: 'var(--ink-2)' },
  } as const;

  return (
    <div className="mb-5">
      <div id="room-tabs-section">
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '8px', mb: '12px' }}>
          {rooms.map((r, i) => {
            const isActive = i === selectedRoomIdx;
            return (
              <Box
                key={i}
                component="button"
                onClick={() => onRoomSelect(i)}
                title={r.room}
                sx={{
                  ...tabBaseSx,
                  ...(isActive ? {
                    background: 'var(--plum)',
                    color: 'common.white',
                    borderColor: 'var(--plum)',
                    '&:hover': { background: 'var(--plum)', color: 'common.white' },
                  } : {}),
                }}
              >
                <span>{r.room}</span>
                {rooms.length > 1 && !isViewer && (
                  <Box
                    component="span"
                    role="button"
                    tabIndex={0}
                    title={`Delete ${r.room}`}
                    onClick={e => { e.stopPropagation(); deleteRoom(i); }}
                    onKeyDown={e => e.key === 'Enter' && deleteRoom(i)}
                    sx={{
                      fontSize: '1.1rem',
                      lineHeight: 1,
                      opacity: 0.7,
                      ml: '2px',
                      '&:hover': { opacity: 1 },
                    }}
                  >
                    ×
                  </Box>
                )}
              </Box>
            );
          })}

          {!isViewer && !addingRoom && (
            <Box
              component="button"
              onClick={() => setAddingRoom(true)}
              title="Add room"
              sx={{
                ...tabBaseSx,
                border: '1px dashed var(--stone-deep)',
                background: 'transparent',
                color: 'var(--stone-deep)',
                transition: 'color 0.15s, border-color 0.15s',
                '&:hover': { color: 'var(--orchid)', borderColor: 'var(--orchid-soft)', background: 'transparent' },
              }}
            >
              + Add room
            </Box>
          )}

          {addingRoom && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <input
                id="new-room-name"
                type="text"
                placeholder="Room name"
                value={newRoomName}
                onChange={e => setNewRoomName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') addRoom();
                  if (e.key === 'Escape') { setAddingRoom(false); setNewRoomName(''); }
                }}
                className="border rounded px-2 py-1 text-sm"
                style={{ fontSize: 16 }}
                autoFocus
              />
              <Button
                size="small"
                onClick={addRoom}
                sx={{
                  background: 'var(--orchid)',
                  color: 'common.white',
                  fontWeight: 600,
                  fontSize: '0.875rem',
                  textTransform: 'none',
                  borderRadius: 'var(--radius-md)',
                  px: 1.5,
                  minWidth: 0,
                  '&:hover': { background: 'var(--orchid)', opacity: 0.88 },
                }}
              >
                Add
              </Button>
              <Button
                size="small"
                onClick={() => { setAddingRoom(false); setNewRoomName(''); }}
                sx={{
                  color: 'var(--ink-3)',
                  fontWeight: 400,
                  fontSize: '0.875rem',
                  textTransform: 'none',
                  minWidth: 0,
                  '&:hover': { color: 'var(--ink-1)', background: 'transparent' },
                }}
              >
                Cancel
              </Button>
            </Box>
          )}
        </Box>

        {room && (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
              <Typography sx={{ fontSize: '0.75rem', color: 'var(--ink-3)', fontWeight: 500 }}>Stage:</Typography>
              {!isViewer ? (
                <select
                  value={room.stageKey}
                  onChange={e => changeStage(e.target.value)}
                  className="border rounded px-2 py-1 text-xs"
                >
                  {stageEntries.map(({ key, label }) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              ) : (
                <Typography
                  component="span"
                  sx={{
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    px: 1,
                    py: '2px',
                    borderRadius: '9999px',
                    background: colour.light,
                    color: colour.text,
                  }}
                >
                  {stageLabel}
                </Typography>
              )}
              {!isViewer ? (
                <>
                  <Typography sx={{ fontSize: '0.75rem', color: 'var(--ink-3)', fontWeight: 500 }}>Install:</Typography>
                  <input
                    type="date"
                    title="Install start date"
                    aria-label="Install start date"
                    value={installStart || nowDate()}
                    onChange={e => changeInstallDate('installStart', e.target.value)}
                    className="border rounded px-2 py-1 text-xs"
                  />
                  <Typography sx={{ fontSize: '0.75rem', color: 'var(--ink-4)' }}>→</Typography>
                  <input
                    type="date"
                    title="Install finish date"
                    aria-label="Install finish date"
                    value={installFinish || nowDate()}
                    onChange={e => changeInstallDate('installFinish', e.target.value)}
                    className="border rounded px-2 py-1 text-xs"
                  />
                </>
              ) : installLine ? (
                <Typography sx={{ fontSize: '0.75rem', color: 'var(--ink-4)', ml: 0.5 }}>
                  Install: {installLine}
                </Typography>
              ) : null}
            </Box>

            <div id="comments-section" className="mb-4">
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                <Typography sx={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink-2)' }}>Notes</Typography>
              </Box>

              <textarea
                className="w-full border rounded-xl px-4 py-3 text-sm resize-none focus:outline-none"
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
                      className="w-full border rounded-xl px-4 py-2.5 text-sm resize-none focus:outline-none"
                      rows={2}
                      placeholder="Add a comment…"
                      value={draftComment}
                      onChange={e => setDraftComment(e.target.value)}
                      style={{ fontSize: 16 }}
                    />
                    {draftComment.trim() && (
                      <Button
                        size="small"
                        onClick={addComment}
                        disabled={savingComment}
                        sx={{
                          mt: '4px',
                          background: 'var(--orchid)',
                          color: 'common.white',
                          fontWeight: 600,
                          fontSize: '0.75rem',
                          textTransform: 'none',
                          borderRadius: 'var(--radius-md)',
                          '&:hover': { background: 'var(--orchid)', opacity: 0.88 },
                          '&.Mui-disabled': { background: 'var(--stone)', color: 'var(--ink-4)' },
                        }}
                      >
                        {savingComment ? 'Saving…' : 'Add comment'}
                      </Button>
                    )}
                  </div>
                </>
              )}

              {(room.comments || []).length > 0 && (
                <Box sx={{ mt: 1.5, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {[...(room.comments || [])].reverse().map((c, i) => (
                    <Box
                      key={i}
                      sx={{
                        background: 'var(--paper)',
                        border: '1px solid var(--stone)',
                        borderRadius: 'var(--radius-lg)',
                        p: '11px 14px',
                        boxShadow: 'var(--shadow-sm)',
                      }}
                    >
                      <Typography sx={{ fontSize: '0.875rem', color: 'var(--ink-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                        {c.text}
                      </Typography>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: '5px', mt: '4px' }}>
                        {c.author && (
                          <Typography component="span" sx={{ fontSize: '0.75rem', color: 'var(--ink-3)' }}>
                            {c.author}
                          </Typography>
                        )}
                        {c.author && c.date && (
                          <Typography component="span" sx={{ fontSize: '0.65rem', color: 'var(--ink-4)' }}>·</Typography>
                        )}
                        {c.date && (
                          <Typography component="span" sx={{ fontSize: '0.68rem', color: 'var(--ink-4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                            {new Date(c.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </Typography>
                        )}
                      </Box>
                    </Box>
                  ))}
                </Box>
              )}
            </div>
          </Box>
        )}
      </div>
    </div>
  );
}
