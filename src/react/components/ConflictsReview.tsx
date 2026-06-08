import { useState } from 'react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import Collapse from '@mui/material/Collapse';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import CircularProgress from '@mui/material/CircularProgress';
import MergeTypeIcon from '@mui/icons-material/MergeType';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useOfflineConflicts } from '../hooks/useOfflineConflicts';
import type { ConflictEntry, OfflineArea, ResolveConflictResult } from '../lib/offlineQueue';
import { resolveConflictRoute } from '../lib/conflictRoute';

// ── Offline sync-conflict review ─────────────────────────────────────────────────
// When a queued offline edit replays onto a record that changed on the server,
// the sync engine keeps your edit (last-write-wins) but persists a conflict so
// you can see what was overwritten. This header pill appears only while there
// are unreviewed conflicts; clicking it opens a list where each can be resolved:
// keep your edit, restore the server copy, or pick per field which value to keep.
//
// Lazy-loaded by GlobalHeader so its code (plus the conflicts hook and its
// icons) stays out of the always-loaded main.js bundle.

const AREA_LABELS: Record<OfflineArea, string> = {
  customer: 'Customer details',
  visit: 'Visit & schedule',
  photo: 'Photo',
};

function areaLabel(area: OfflineArea): string {
  return AREA_LABELS[area] ?? area;
}

function formatTimestamp(value: number | string | null | undefined): string {
  if (value == null) return '—';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(ms)) return '—';
  try {
    return new Date(ms).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

// ── Field-level diff ─────────────────────────────────────────────────────────────
// The conflict stores the user's queued edit (`attemptedBody`) and a snapshot of
// the server record at conflict time (`serverData`). Both can arrive wrapped in a
// response envelope (`{ visit: … }`, `{ designVisit: … }`, `{ submission: … }`),
// so we unwrap to the meaningful record before comparing field by field.

const RESPONSE_ENVELOPE_KEYS = ['visit', 'designVisit', 'submission', 'record', 'data'];

// Bookkeeping / sync-plumbing keys that never represent a user-meaningful field.
const NOISE_KEYS = new Set([
  'id',
  'version',
  'updated_at',
  'updatedAt',
  'created_at',
  'createdAt',
  'created_by',
  'createdBy',
  'updated_by',
  'updatedBy',
]);

function unwrapRecord(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const obj = data as Record<string, unknown>;
  for (const key of RESPONSE_ENVELOPE_KEYS) {
    const nested = obj[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }
  return obj;
}

function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatFieldValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value.trim() === '' ? '—' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const json = JSON.stringify(value);
    return json.length > 200 ? `${json.slice(0, 197)}…` : json;
  } catch {
    return String(value);
  }
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export interface FieldDiffRow {
  key: string;
  label: string;
  attempted: unknown;
  server: unknown;
  changed: boolean;
}

/**
 * Build a per-field comparison of the queued edit vs the server snapshot.
 *
 * Only the keys the user actually edited (present in `attemptedBody`) are listed —
 * those are the fields the last-write-wins replay overwrote. Server-only keys are
 * deliberately excluded: the user never touched them, so flagging them as
 * "changed" would inflate the overwrite count and mislead. Noise/plumbing keys
 * are dropped and function values skipped.
 */
export function buildFieldDiff(attemptedBody: unknown, serverData: unknown): FieldDiffRow[] {
  const attempted = unwrapRecord(attemptedBody);
  const server = unwrapRecord(serverData);

  const rows: FieldDiffRow[] = [];
  for (const key of Object.keys(attempted)) {
    if (NOISE_KEYS.has(key) || typeof attempted[key] === 'function') continue;
    rows.push({
      key,
      label: humanizeKey(key),
      attempted: attempted[key],
      server: server[key],
      changed: !valuesEqual(attempted[key], server[key]),
    });
  }
  return rows;
}

/**
 * Build the write body that re-applies the chosen server values.
 *
 * Starts from the original queued body (so fields the user is keeping — and any
 * extra payload keys the diff never surfaced, e.g. a design visit's rooms or
 * handlerConfig — are preserved verbatim) and overwrites only `restoreKeys`
 * with the server snapshot value. Missing server values become `null` so the
 * field is explicitly cleared rather than silently dropped from the body.
 *
 * Returns `null` when there is nothing to restore (no keys, or no usable
 * attempted body), signalling the caller to keep the edit instead.
 */
export function buildRestoreBody(
  attemptedBody: unknown,
  serverData: unknown,
  restoreKeys: string[],
): Record<string, unknown> | null {
  if (!restoreKeys || restoreKeys.length === 0) return null;
  if (!attemptedBody || typeof attemptedBody !== 'object' || Array.isArray(attemptedBody)) {
    return null;
  }
  const server = unwrapRecord(serverData);
  const body: Record<string, unknown> = { ...(attemptedBody as Record<string, unknown>) };
  for (const key of restoreKeys) {
    const value = server[key];
    body[key] = value === undefined ? null : value;
  }
  return body;
}

/** Per-field resolution choice. `mine` keeps the queued edit; `server` restores. */
type FieldChoice = 'mine' | 'server';

function FieldDiffSection({
  rows,
  open,
  onToggleOpen,
  choices,
  onChoose,
  disabled,
}: {
  rows: FieldDiffRow[];
  open: boolean;
  onToggleOpen: () => void;
  choices: Record<string, FieldChoice>;
  onChoose: (key: string, choice: FieldChoice) => void;
  disabled: boolean;
}) {
  if (rows.length === 0) return null;

  const changedCount = rows.filter((r) => r.changed).length;

  return (
    <Box sx={{ mt: 1.5 }}>
      <Button
        size="small"
        variant="text"
        color="inherit"
        onClick={onToggleOpen}
        startIcon={open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        data-testid="conflict-fields-toggle"
        sx={{ textTransform: 'none', px: 0.5 }}
      >
        {open ? 'Hide field changes' : `Compare fields${changedCount ? ` (${changedCount} changed)` : ''}`}
      </Button>
      <Collapse in={open} unmountOnExit>
        <Box
          data-testid="conflict-fields"
          sx={{ mt: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}
        >
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 1,
              px: 1.25,
              py: 0.75,
              bgcolor: 'action.hover',
            }}
          >
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700 }}>
              Your edit
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700 }}>
              Server copy
            </Typography>
          </Box>
          {rows.map((row) => {
            const choice = choices[row.key] ?? 'mine';
            return (
              <Box
                key={row.key}
                data-testid="conflict-field-row"
                data-changed={row.changed ? 'true' : 'false'}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 1,
                  px: 1.25,
                  py: 0.75,
                  borderTop: '1px solid',
                  borderColor: 'divider',
                  bgcolor: row.changed ? 'rgba(249,115,22,0.1)' : 'transparent',
                }}
              >
                <Typography variant="caption" sx={{ gridColumn: '1 / -1', color: 'text.disabled' }}>
                  {row.label}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    wordBreak: 'break-word',
                    fontWeight: row.changed && choice === 'mine' ? 600 : 400,
                    color: row.changed && choice === 'server' ? 'text.secondary' : 'text.primary',
                    textDecoration: row.changed && choice === 'server' ? 'line-through' : 'none',
                  }}
                >
                  {formatFieldValue(row.attempted)}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    wordBreak: 'break-word',
                    fontWeight: row.changed && choice === 'server' ? 600 : 400,
                    color: row.changed && choice === 'mine' ? 'text.secondary' : 'text.primary',
                    textDecoration: row.changed && choice === 'mine' ? 'line-through' : 'none',
                  }}
                >
                  {formatFieldValue(row.server)}
                </Typography>
                {row.changed && (
                  <ToggleButtonGroup
                    exclusive
                    size="small"
                    value={choice}
                    disabled={disabled}
                    onChange={(_e, next: FieldChoice | null) => { if (next) onChoose(row.key, next); }}
                    data-testid="conflict-field-choice"
                    sx={{
                      gridColumn: '1 / -1',
                      mt: 0.5,
                      '& .MuiToggleButton-root': {
                        textTransform: 'none',
                        py: 0.25,
                        fontSize: 11,
                      },
                    }}
                  >
                    <ToggleButton value="mine" data-testid="conflict-field-choice-mine">
                      Keep mine
                    </ToggleButton>
                    <ToggleButton value="server" data-testid="conflict-field-choice-server">
                      Use server
                    </ToggleButton>
                  </ToggleButtonGroup>
                )}
              </Box>
            );
          })}
        </Box>
      </Collapse>
    </Box>
  );
}

function VersionRow({ label, base, server }: { label: string; base: React.ReactNode; server: React.ReactNode }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 1,
        py: 0.5,
      }}
    >
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
          Your edit was based on
        </Typography>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{base}</Typography>
      </Box>
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
          Server had
        </Typography>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{server}</Typography>
      </Box>
      <Typography variant="caption" sx={{ gridColumn: '1 / -1', color: 'text.disabled' }}>
        {label}
      </Typography>
    </Box>
  );
}

function ConflictCard({
  conflict,
  onResolve,
  onReconflicted,
}: {
  conflict: ConflictEntry;
  onResolve: (conflict: ConflictEntry, resolvedBody: Record<string, unknown> | null) => Promise<ResolveConflictResult>;
  onReconflicted?: () => void;
}) {
  const hasVersions = conflict.baseVersion != null || conflict.serverVersion != null;
  const hasTimestamps = !!conflict.baseUpdatedAt || !!conflict.serverUpdatedAt;
  const recordHref = resolveConflictRoute(conflict);

  const rows = buildFieldDiff(conflict.attemptedBody, conflict.serverData);
  const changedKeys = rows.filter((r) => r.changed).map((r) => r.key);
  const canRestore = changedKeys.length > 0;

  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Record<string, FieldChoice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = (key: string, choice: FieldChoice) => {
    setChoices((prev) => ({ ...prev, [key]: choice }));
  };

  // Keys the user has explicitly flipped to the server value.
  const selectedServerKeys = changedKeys.filter((k) => choices[k] === 'server');
  const hasSelection = selectedServerKeys.length > 0;

  const run = async (restoreKeys: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const body = buildRestoreBody(conflict.attemptedBody, conflict.serverData, restoreKeys);
      const res = await onResolve(conflict, body);
      // The server changed again since this conflict was detected — the restore
      // was abandoned and a fresh conflict re-flagged. This card unmounts and a
      // refreshed one appears; let the dialog explain why.
      if (body !== null && res.reconflicted) {
        onReconflicted?.();
        return;
      }
      // A genuine server rejection (4xx) leaves the conflict in place; surface it.
      if (body !== null && !res.ok && !res.queued) {
        setError('Could not restore the server copy. Please try again.');
      }
      // On success/queued the parent clears the conflict and this card unmounts.
    } catch {
      setError('Could not restore the server copy. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      data-testid="conflict-card"
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1.5,
        p: 2,
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Chip label={areaLabel(conflict.area)} size="small" color="primary" variant="outlined" />
            <Typography variant="subtitle2" sx={{ fontWeight: 700, wordBreak: 'break-word' }}>
              {conflict.label || conflict.recordKey || 'Record'}
            </Typography>
          </Stack>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
            Detected {formatTimestamp(conflict.detectedAt)}
          </Typography>
        </Box>
        {recordHref && (
          <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
            <Button
              size="small"
              variant="outlined"
              component="a"
              href={recordHref}
              target="_blank"
              rel="noopener"
              startIcon={<OpenInNewIcon />}
              data-testid="conflict-open-record"
            >
              Open record
            </Button>
          </Stack>
        )}
      </Stack>

      <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>
        Someone else changed this record while your edit was waiting to sync. Your change was
        applied anyway (last edit wins), overwriting the server copy. Choose which version to keep.
      </Typography>

      {(hasVersions || hasTimestamps) && (
        <>
          <Divider sx={{ my: 1.5 }} />
          {hasVersions && (
            <VersionRow
              label="Record version"
              base={conflict.baseVersion ?? '—'}
              server={conflict.serverVersion ?? '—'}
            />
          )}
          {hasTimestamps && (
            <VersionRow
              label="Last updated"
              base={formatTimestamp(conflict.baseUpdatedAt)}
              server={formatTimestamp(conflict.serverUpdatedAt)}
            />
          )}
        </>
      )}

      <FieldDiffSection
        rows={rows}
        open={open}
        onToggleOpen={() => setOpen((v) => !v)}
        choices={choices}
        onChoose={choose}
        disabled={busy}
      />

      {error && (
        <Typography variant="caption" sx={{ color: 'error.main', display: 'block', mt: 1 }} data-testid="conflict-error">
          {error}
        </Typography>
      )}

      <Stack
        direction="row"
        sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1, mt: 1.5 }}
      >
        <Button
          size="small"
          variant="text"
          color="inherit"
          disabled={busy}
          onClick={() => void run([])}
          data-testid="conflict-keep-mine"
        >
          Keep my edit
        </Button>
        {canRestore && (
          <Button
            size="small"
            variant="outlined"
            color="primary"
            disabled={busy}
            startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
            onClick={() => void run(changedKeys)}
            data-testid="conflict-restore-server"
          >
            Restore server copy
          </Button>
        )}
        {canRestore && open && hasSelection && (
          <Button
            size="small"
            variant="contained"
            color="primary"
            disabled={busy}
            startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
            onClick={() => void run(selectedServerKeys)}
            data-testid="conflict-apply-selection"
          >
            Apply selection ({selectedServerKeys.length})
          </Button>
        )}
      </Stack>
    </Box>
  );
}

export interface ConflictsReviewProps {
  /** Test/Storybook seam: inject conflicts + handlers instead of the live hook. */
  conflicts?: ConflictEntry[];
  onDismissAll?: () => void | Promise<void>;
  /** Resolve a single conflict: `null` keeps the edit, a body restores server values. */
  onResolve?: (conflict: ConflictEntry, resolvedBody: Record<string, unknown> | null) => Promise<ResolveConflictResult>;
  /** Force the dialog open (Storybook). */
  defaultOpen?: boolean;
}

export default function ConflictsReview(props: ConflictsReviewProps) {
  const live = useOfflineConflicts();
  const conflicts = props.conflicts ?? live.conflicts;
  const dismissAll = props.onDismissAll ?? live.dismissAll;
  const resolve = props.onResolve ?? live.resolve;

  const [open, setOpen] = useState(!!props.defaultOpen);
  const [reconflictNotice, setReconflictNotice] = useState(false);

  const count = conflicts.length;
  if (count === 0) return null;

  const tooltip = `${count} sync conflict${count === 1 ? '' : 's'} — a record changed on the server while your offline edit was waiting. Review what was overwritten.`;

  return (
    <>
      <Tooltip title={tooltip}>
        <Box
          component="button"
          type="button"
          onClick={() => setOpen(true)}
          role="status"
          aria-live="polite"
          aria-label={tooltip}
          data-testid="conflicts-pill"
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.5,
            height: 28,
            px: 1,
            borderRadius: '8px',
            color: '#fdba74',
            bgcolor: 'rgba(249,115,22,0.16)',
            border: '1px solid rgba(253,186,116,0.4)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.03em',
            lineHeight: 1,
            whiteSpace: 'nowrap',
            cursor: 'pointer',
            font: 'inherit',
            '&:hover': { bgcolor: 'rgba(249,115,22,0.26)' },
          }}
        >
          <MergeTypeIcon fontSize="small" />
          <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
            {count} conflict{count === 1 ? '' : 's'}
          </Box>
        </Box>
      </Tooltip>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        maxWidth="sm"
        fullWidth
        data-testid="conflicts-dialog"
      >
        <DialogTitle>Sync conflicts</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
            These records changed on the server while your offline edits were waiting to sync.
            Your edits were kept (last edit wins). For each conflict, keep your edit or restore the
            server copy — expand the field comparison to choose value by value.
          </Typography>
          {reconflictNotice && (
            <Box
              data-testid="conflict-reconflict-notice"
              role="status"
              sx={{
                mb: 2,
                p: 1.5,
                borderRadius: 1,
                border: '1px solid rgba(253,186,116,0.5)',
                bgcolor: 'rgba(249,115,22,0.12)',
              }}
            >
              <Typography variant="body2" sx={{ color: '#fdba74', fontWeight: 600 }}>
                The server copy changed again before your restore could be applied. Nothing was
                overwritten — please review the refreshed conflict below.
              </Typography>
            </Box>
          )}
          <Stack spacing={2}>
            {conflicts.map((c) => (
              <ConflictCard
                key={c.id}
                conflict={c}
                onResolve={resolve}
                onReconflicted={() => setReconflictNotice(true)}
              />
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            color="inherit"
            onClick={() => void dismissAll()}
            data-testid="conflicts-dismiss-all"
          >
            Keep all my edits
          </Button>
          <Button variant="contained" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
