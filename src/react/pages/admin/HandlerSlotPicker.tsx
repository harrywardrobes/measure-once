import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, CircularProgress, FormControl,
  IconButton, InputLabel, MenuItem, Select, TextField, Tooltip,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { POST, PATCH, DELETE } from '../../utils/api';
import { HANDLER_TYPE_LABELS, isHandlerType } from '../../utils/handlerMeta';
import type { HandlerType } from '../../components/CardActionModalsHost';
import { STATUS_COLORS } from '../../theme';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Binding { stage_key?: string; status_key?: string; }
export interface SlotHandler {
  id: number;
  name: string;
  type: HandlerType;
  config: Record<string, unknown>;
  bindings: Binding[];
}

export interface HandlerSlotPickerProps {
  stageKey: string;
  statusKey: string;
  /** Full list of all handlers (picker filters to this slot internally). */
  handlers: SlotHandler[];
  /** Called after any successful create / update / remove so the parent can refetch. */
  onMutated: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const W = window as unknown as Record<string, unknown>;

function emitHandlerChanged(): void {
  try { new BroadcastChannel('card_action_handlers_changed').postMessage({ ts: Date.now() }); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('card_action_handlers_changed'));
}

function handlersForSlot(handlers: SlotHandler[], stageKey: string, statusKey: string): SlotHandler[] {
  return handlers.filter(h => h.bindings?.some(b =>
    (b.stage_key  || '').toLowerCase() === (stageKey  || '').toLowerCase()
    && (b.status_key || '').toLowerCase() === (statusKey || '').toLowerCase(),
  ));
}

/** True when the error message suggests a unique-constraint / duplicate-binding conflict. */
function isConflictError(err: unknown): boolean {
  const msg = ((err as Error)?.message ?? '').toLowerCase();
  return msg.includes('already') || msg.includes('duplicate') || msg.includes('unique') || msg.includes('conflict');
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Inline handler picker for a single card-action slot.
 *
 * Renders a handler-type Select, an action-name TextField, and a remove button.
 * All mutations use the same POST /api/admin/card-action-handlers (create),
 * PATCH /api/admin/card-action-handlers/:id (update), and
 * DELETE /api/admin/card-action-handlers/:id/binding (remove) endpoints as
 * ActionHandlersPage — no separate stage-action-labels write.
 *
 * Conflict state (>1 handler bound to the slot) shows a warning + "Fix conflict"
 * button that delegates to the existing window.openConflictResolver exposure
 * from ActionHandlersPage.
 */
export function HandlerSlotPicker({
  stageKey,
  statusKey,
  handlers,
  onMutated,
}: HandlerSlotPickerProps) {
  const slotHandlers = handlersForSlot(handlers, stageKey, statusKey);
  const hasConflict  = slotHandlers.length > 1;
  const existing     = slotHandlers.length === 1 ? slotHandlers[0] : null;

  const [localType, setLocalType] = useState<HandlerType | ''>(() => existing?.type ?? '');
  const [localName, setLocalName] = useState<string>(() => String(existing?.config?.action_name ?? ''));
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');

  // Sync local state when the bound handler changes externally — track id, type,
  // AND action_name so same-ID updates (e.g. another tab edits the handler) are
  // reflected, and to avoid stale-type races in the name-blur path.
  const prevKeyRef = useRef<string>('');
  const stableKey = `${existing?.id ?? ''}|${existing?.type ?? ''}|${String(existing?.config?.action_name ?? '')}`;
  useEffect(() => {
    if (stableKey !== prevKeyRef.current) {
      prevKeyRef.current = stableKey;
      setLocalType(existing?.type ?? '');
      setLocalName(String(existing?.config?.action_name ?? ''));
      setError('');
    }
  }, [stableKey, existing]);

  const bindingSpec = { stage_key: stageKey, status_key: statusKey };

  // ── Handler-type change ───────────────────────────────────────────────────

  const handleTypeChange = useCallback(async (newType: HandlerType | '') => {
    const prevType = localType;
    setLocalType(newType);
    setError('');
    setSaving(true);

    try {
      if (!newType) {
        // Clearing — delete binding only.
        if (existing) {
          await DELETE(`/api/admin/card-action-handlers/${existing.id}/binding`, bindingSpec);
          setLocalName('');
        }
      } else if (existing) {
        // Updating type on existing handler — preserve config incl. action_name.
        const cfg: Record<string, unknown> = { ...existing.config };
        await PATCH(`/api/admin/card-action-handlers/${existing.id}`, {
          name: existing.name, type: newType, config: cfg, bindings: existing.bindings,
        });
      } else {
        // Creating a new handler+binding.
        const cfg: Record<string, unknown> = {};
        if (localName.trim()) cfg.action_name = localName.trim();
        await POST('/api/admin/card-action-handlers', {
          name: '', type: newType, config: cfg, bindings: [bindingSpec],
        });
      }

      emitHandlerChanged();
      onMutated();
    } catch (e) {
      // On a duplicate-binding conflict, refetch so the conflict state renders
      // and shows the "Fix conflict" CTA — matching Action Handlers page UX.
      if (isConflictError(e)) {
        setLocalType(prevType);
        emitHandlerChanged();
        onMutated();
      } else {
        setError((e as Error).message || 'Save failed.');
        setLocalType(prevType);
      }
    } finally {
      setSaving(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing, localName, stageKey, statusKey, localType, onMutated]);

  // ── Action-name blur (auto-save) ──────────────────────────────────────────

  const handleNameBlur = useCallback(async () => {
    // Use localType from state (kept in sync with props) to avoid stale-type races.
    if (!existing || !localType) return;
    const trimmed  = localName.trim();
    const original = String(existing.config?.action_name ?? '');
    if (trimmed === original) return;

    setSaving(true);
    setError('');
    try {
      const cfg = { ...existing.config };
      if (trimmed) cfg.action_name = trimmed; else delete cfg.action_name;
      // Use existing.type (from props, always fresh) for the PATCH to avoid
      // submitting a stale type from a rapid type-then-name edit sequence.
      await PATCH(`/api/admin/card-action-handlers/${existing.id}`, {
        name: existing.name, type: existing.type, config: cfg, bindings: existing.bindings,
      });
      emitHandlerChanged();
      onMutated();
    } catch (e) {
      setError((e as Error).message || 'Save failed.');
      setLocalName(original);
    } finally {
      setSaving(false);
    }
  }, [existing, localName, localType, onMutated]);

  // ── Remove binding ────────────────────────────────────────────────────────

  const handleRemove = useCallback(async () => {
    if (!existing) return;
    setSaving(true);
    setError('');
    try {
      await DELETE(`/api/admin/card-action-handlers/${existing.id}/binding`, bindingSpec);
      setLocalType('');
      setLocalName('');
      emitHandlerChanged();
      onMutated();
    } catch (e) {
      setError((e as Error).message || 'Remove failed.');
    } finally {
      setSaving(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing, onMutated]);

  // ── Conflict resolver ─────────────────────────────────────────────────────

  const openConflictFix = () => {
    if (typeof W.openConflictResolver !== 'function') return;
    const fn = W.openConflictResolver as (a: string | null, b: string | null, c: number | null) => void;
    fn(stageKey || null, statusKey || null, null);
  };

  // ── Render: conflict state ────────────────────────────────────────────────

  if (hasConflict) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1 }}>
        <Box sx={{
          display: 'inline-flex', alignItems: 'center', gap: 0.75,
          px: 1.25, py: 0.4,
          background: STATUS_COLORS.warning.bg,
          color: STATUS_COLORS.warning.text,
          border: `1px solid ${STATUS_COLORS.warning.border}`,
          borderRadius: 1, fontSize: '0.75rem', fontWeight: 600,
        }}>
          <WarningAmberIcon sx={{ fontSize: 14 }} />
          {slotHandlers.length} handlers — conflict
        </Box>
        <Button size="small" variant="outlined" color="warning" onClick={openConflictFix}>
          Fix conflict
        </Button>
      </Box>
    );
  }

  // ── Render: normal state ──────────────────────────────────────────────────

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
      <FormControl size="small" sx={{ minWidth: 220, flexShrink: 0 }}>
        <InputLabel>Action type</InputLabel>
        <Select
          label="Action type"
          value={localType}
          disabled={saving}
          onChange={e => {
            const v = e.target.value as string;
            if (v === '' || isHandlerType(v)) {
              handleTypeChange(v as HandlerType | '');
            }
          }}
        >
          <MenuItem value=""><em>— no action —</em></MenuItem>
          {Object.entries(HANDLER_TYPE_LABELS).map(([k, v]) => (
            <MenuItem key={k} value={k}>{v}</MenuItem>
          ))}
        </Select>
      </FormControl>

      <TextField
        size="small"
        label="Action name"
        placeholder="(optional label)"
        value={localName}
        disabled={!localType || saving}
        onChange={e => setLocalName(e.target.value)}
        onBlur={handleNameBlur}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        sx={{ flex: 1, minWidth: 120 }}
        slotProps={{ htmlInput: { maxLength: 80 } }}
      />

      {localType && (
        <Tooltip title="Remove handler from this slot">
          <span>
            <IconButton
              size="small"
              onClick={handleRemove}
              disabled={saving}
              color="error"
              aria-label="Remove handler"
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      )}

      {saving && <CircularProgress size={14} sx={{ flexShrink: 0 }} />}

      {error && (
        <Alert severity="error" sx={{ py: 0, px: 1, flex: 1, fontSize: '0.72rem', minWidth: '100%' }}>
          {error}
        </Alert>
      )}
    </Box>
  );
}
