import React, { useState } from 'react';
import {
  Box,
  CircularProgress,
  Popover,
  Typography,
} from '@mui/material';

// ── Types ──────────────────────────────────────────────────────────────────────

interface SubstageOption {
  id: string;
  label?: string;
}

interface Room {
  stageKey?: string;
  statusId?: string;
  completedStatuses?: Record<string, string[]>;
  substateDates?: Record<string, string>;
  notes?: string;
}

interface WorkflowStage {
  label?: string;
  statuses?: SubstageOption[];
}

interface WindowGlobals {
  state?: {
    workflow?: { stages?: Record<string, WorkflowStage> };
  };
  showToast?: (msg: string, isError?: boolean) => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().split('T')[0];
}

function getErrMessage(e: unknown, code: string | undefined): string {
  if (code === 'PIPELINE_EDIT_FORBIDDEN')
    return 'Manager or admin privilege required to change pipeline state.';
  if (code === 'HUBSPOT_AUTH')
    return 'Could not save — HubSpot token is invalid or expired.';
  if (code === 'HUBSPOT_RATE_LIMIT')
    return 'Could not save — HubSpot rate limit reached. Try again in a moment.';
  return (e instanceof Error ? e.message : null) || 'Failed to save change';
}

// ── SubstagePicker ─────────────────────────────────────────────────────────────

export interface SubstagePickerProps {
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  contactId: string;
  roomIdx: number;
  stageKey: string;
  statuses: SubstageOption[];
  currentSubId: string;
}

export function SubstagePicker({
  anchorEl,
  open,
  onClose,
  contactId,
  roomIdx,
  stageKey,
  statuses,
  currentSubId,
}: SubstagePickerProps) {
  const [saving, setSaving] = useState(false);

  const saveRoomMutation = async (mutateRoom: (rooms: Room[]) => boolean) => {
    setSaving(true);
    try {
      const resp = await fetch(`/api/contacts/${encodeURIComponent(contactId)}/localdata`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as
        | Room[]
        | { rooms?: Room[]; notes?: string }
        | null;

      let rooms: Room[];
      let notes = '';
      if (Array.isArray(data)) {
        rooms = data as Room[];
      } else if (data && Array.isArray((data as { rooms?: Room[] }).rooms)) {
        rooms = (data as { rooms: Room[]; notes?: string }).rooms;
        notes = (data as { notes?: string }).notes || '';
      } else {
        rooms = [{ stageKey: 'sales', statusId: null as unknown as string }];
      }

      if (!rooms.length) {
        const w = window as unknown as WindowGlobals;
        if (typeof w.showToast === 'function') w.showToast('No room found to edit', true);
        return;
      }

      const ok = mutateRoom(rooms);
      if (!ok) return;

      const primary = rooms[0] || {};
      const sk = primary.stageKey || 'sales';
      const w = window as unknown as WindowGlobals;
      const workflow = w.state?.workflow;
      const stageLabel = workflow?.stages?.[sk]?.label || sk;
      const doneIds: string[] = (primary.completedStatuses?.[sk] as string[]) || [];
      const stageStatuses = workflow?.stages?.[sk]?.statuses || [];
      const lastDone = [...stageStatuses]
        .reverse()
        .find((s) => doneIds.includes(s.id));
      const substageLabel = lastDone?.label || '';

      const saveResp = await fetch(
        `/api/contacts/${encodeURIComponent(contactId)}/localdata`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rooms, notes, stage: stageLabel, substage: substageLabel }),
        },
      );
      if (!saveResp.ok) {
        const body = (await saveResp.json().catch(() => ({}))) as { code?: string; error?: string };
        const err = new Error(body.error || `HTTP ${saveResp.status}`);
        (err as Error & { code?: string }).code = body.code;
        throw err;
      }

      document.dispatchEvent(new CustomEvent('localdata-updated'));
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      const msg = getErrMessage(e, code);
      const w = window as unknown as WindowGlobals;
      if (typeof w.showToast === 'function') w.showToast(msg, true);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = () => {
    onClose();
    void saveRoomMutation((rooms) => {
      const r = rooms[roomIdx];
      if (!r) {
        const w = window as unknown as WindowGlobals;
        if (typeof w.showToast === 'function') w.showToast('Room no longer exists', true);
        return false;
      }
      r.statusId = '';
      if (r.completedStatuses) r.completedStatuses[stageKey] = [];
      return true;
    });
  };

  const handleSelect = (subId: string) => {
    if (subId === currentSubId) { onClose(); return; }
    onClose();
    void saveRoomMutation((rooms) => {
      const r = rooms[roomIdx];
      if (!r) {
        const w = window as unknown as WindowGlobals;
        if (typeof w.showToast === 'function') w.showToast('Room no longer exists', true);
        return false;
      }
      const ids = statuses.map((s) => s.id);
      const cutoff = ids.indexOf(subId);
      const done = cutoff >= 0 ? ids.slice(0, cutoff + 1) : [subId];
      r.completedStatuses = r.completedStatuses || {};
      r.completedStatuses[stageKey] = done;
      r.statusId = subId;
      r.substateDates = r.substateDates || {};
      r.substateDates[subId] = r.substateDates[subId] || todayISO();
      return true;
    });
  };

  if (!statuses.length) return null;

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      slotProps={{
        paper: {
          sx: {
            mt: 0.5,
            minWidth: 200,
            maxHeight: 340,
            overflowY: 'auto',
            p: '6px',
            border: '1.5px solid',
            borderColor: 'divider',
            borderRadius: 1.5,
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          },
        },
      }}
    >
      {saving ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: '10px 14px' }}>
          <CircularProgress size={14} sx={{ flexShrink: 0 }} />
          <Typography sx={{ fontSize: '0.82rem', color: 'text.secondary' }}>Saving…</Typography>
        </Box>
      ) : (
        <>
          <Box
            component="button"
            disabled={!currentSubId}
            onClick={currentSubId ? handleClear : undefined}
            sx={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              border: 'none',
              background: 'none',
              color: currentSubId ? '#ef4444' : '#B8AE99',
              fontWeight: 500,
              fontSize: '0.82rem',
              fontFamily: 'inherit',
              px: '12px',
              py: '7px',
              cursor: currentSubId ? 'pointer' : 'not-allowed',
              borderRadius: '4px',
              transition: 'background 0.1s',
              '&:hover:not(:disabled)': { background: '#F6F1E7' },
            }}
          >
            ✕ Clear substage
          </Box>
          {statuses.map((s) => {
            const isActive = s.id === currentSubId;
            return (
              <Box
                key={s.id}
                component="button"
                onClick={() => handleSelect(s.id)}
                sx={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  background: isActive ? '#EDE8FF' : 'none',
                  color: isActive ? '#6A12D9' : '#141413',
                  fontWeight: isActive ? 700 : 400,
                  fontSize: '0.82rem',
                  fontFamily: 'inherit',
                  px: '12px',
                  py: '7px',
                  cursor: 'pointer',
                  borderRadius: '4px',
                  transition: 'background 0.1s',
                  '&:hover': { background: isActive ? '#E0D8FF' : '#F6F1E7' },
                }}
              >
                {s.label || s.id}
              </Box>
            );
          })}
        </>
      )}
    </Popover>
  );
}
