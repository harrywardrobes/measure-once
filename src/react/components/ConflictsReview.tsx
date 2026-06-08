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
import { explainConflict } from '../lib/syncErrorMessages';
import { fmtGbp } from '../pages/customer-detail/types';

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
  // Design-visit submit plumbing: re-sent on every write, not a stored record
  // field. `handlerConfig` (lead status / T&C text) and `termsAccepted` have no
  // readable server counterpart, so diffing/restoring them is meaningless — they
  // are preserved verbatim from the queued edit instead.
  'handlerConfig',
  'termsAccepted',
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

/** Shared styling for a side-by-side diff cell: the chosen side is emphasised,
 *  the discarded side is dimmed and struck through (only when the value changed). */
function diffCellSx(changed: boolean, side: FieldChoice, choice: FieldChoice) {
  return {
    wordBreak: 'break-word' as const,
    fontWeight: changed && choice === side ? 600 : 400,
    color: changed && choice !== side ? 'text.secondary' : 'text.primary',
    textDecoration: changed && choice !== side ? 'line-through' : 'none',
  };
}

// ── Room-by-room diff (design-visit `rooms`) ─────────────────────────────────────
// A design visit's `rooms` is an array of per-room objects; shown as a raw JSON
// blob it's unreadable, so we normalise each room to a handful of human-readable
// attributes and compare them side by side. The queued edit uses the write shape
// (camelCase: `roomName`, `doorStyleId`, `widthMm`…) while the server snapshot
// uses the read shape (snake_case: `room_name`, `door_style_name`, `width_mm`…),
// so every accessor falls back across both. Door style is special: the edit body
// carries only the numeric id, the server snapshot carries both the id and the
// resolved name — so we *compare* by id but *display* the friendly name when the
// server has it (the edit side can only show `Style #<id>`).

interface NormalizedRoom {
  name: string;
  doorStyle: string;
  dimensions: string;
  units: string;
  price: string;
}

function roomField(room: unknown, camel: string, snake: string): unknown {
  if (!room || typeof room !== 'object' || Array.isArray(room)) return undefined;
  const r = room as Record<string, unknown>;
  if (r[camel] != null && r[camel] !== '') return r[camel];
  if (r[snake] != null && r[snake] !== '') return r[snake];
  return undefined;
}

function formatPence(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return `£${fmtGbp(n)}`;
}

function formatDimensions(room: unknown): string {
  const w = roomField(room, 'widthMm', 'width_mm');
  const h = roomField(room, 'heightMm', 'height_mm');
  const d = roomField(room, 'depthMm', 'depth_mm');
  if (w == null && h == null && d == null) return '—';
  const part = (v: unknown) => (v == null ? '—' : String(v));
  return `${part(w)} × ${part(h)} × ${part(d)} mm`;
}

function normalizeRoom(room: unknown): NormalizedRoom {
  const name = roomField(room, 'roomName', 'room_name');
  const doorName = roomField(room, 'doorStyleName', 'door_style_name');
  const doorId = roomField(room, 'doorStyleId', 'door_style_id');
  const units = roomField(room, 'unitCount', 'unit_count');
  return {
    name: name == null ? '' : String(name),
    doorStyle:
      doorName != null ? String(doorName) : doorId != null ? `Style #${doorId}` : '—',
    dimensions: formatDimensions(room),
    units: units == null ? '—' : String(units),
    price: formatPence(roomField(room, 'unitPricePence', 'unit_price_pence')),
  };
}

/** Compare a single room attribute across the two raw rooms, using the
 *  underlying value (e.g. door-style *id*, not the displayed name). */
function roomAttrChanged(a: unknown, s: unknown, key: 'door' | 'dim' | 'units' | 'price'): boolean {
  const str = (v: unknown) => (v == null ? '' : String(v));
  switch (key) {
    case 'door':
      return str(roomField(a, 'doorStyleId', 'door_style_id')) !== str(roomField(s, 'doorStyleId', 'door_style_id'));
    case 'units':
      return str(roomField(a, 'unitCount', 'unit_count')) !== str(roomField(s, 'unitCount', 'unit_count'));
    case 'price':
      return str(roomField(a, 'unitPricePence', 'unit_price_pence')) !== str(roomField(s, 'unitPricePence', 'unit_price_pence'));
    case 'dim':
      return formatDimensions(a) !== formatDimensions(s);
  }
}

// ── Write-shape ↔ read-shape key normalisation ──────────────────────────────────
// A queued edit's body uses the *write* field names the endpoint accepts, while
// the server snapshot uses the *read* field names it returns. For most areas
// these match, but design-visit edits are camelCase (`visitDate`, `durationMin`,
// `rooms[].roomName`) while the server reads back snake_case (`visit_date`,
// `duration_min`, `rooms[].room_name`). Matching purely by key name then fails:
// every changed field looks overwritten and a restore writes `null`. We bridge
// the two by looking up each write-shape key against its snake_case counterpart.

function toSnakeKey(key: string): string {
  return key.replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`);
}

/** Read a value from the server snapshot by its write-shape key, falling back to
 *  the snake_case counterpart (e.g. `visitDate` → `visit_date`). */
function lookupServerValue(server: Record<string, unknown>, key: string): unknown {
  if (key in server) return server[key];
  const snake = toSnakeKey(key);
  if (snake in server) return server[snake];
  return undefined;
}

/**
 * Project a server value onto the *shape* of the attempted (write-shape) value
 * so the two can be compared and restored consistently.
 *
 * - Objects: rebuild using the attempted object's keys, resolving each child
 *   against the server's matching (camel or snake) field. This drops server-only
 *   metadata (`id`, `door_style_name`, …) that the write body never carries, so
 *   an otherwise-identical nested record doesn't read as "changed".
 * - Arrays (e.g. a design visit's rooms): rebuild from the *server* array length
 *   — so a restore brings back exactly the server's rooms — shaping each element
 *   to the attempted element template.
 * - Primitives: return the resolved server scalar.
 */
function projectServerValue(attempted: unknown, server: unknown): unknown {
  if (Array.isArray(attempted)) {
    if (!Array.isArray(server)) return server;
    const template = attempted.length ? attempted[0] : (server.length ? server[0] : {});
    return server.map((el) => projectServerValue(template, el));
  }
  if (attempted && typeof attempted === 'object') {
    if (!server || typeof server !== 'object' || Array.isArray(server)) return server;
    const sObj = server as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(attempted as Record<string, unknown>)) {
      out[k] = projectServerValue((attempted as Record<string, unknown>)[k], lookupServerValue(sObj, k));
    }
    return out;
  }
  return server;
}

export interface FieldDiffRow {
  key: string;
  label: string;
  attempted: unknown;
  server: unknown;
  /** Raw (un-projected) server value, looked up by write→read key. Used by the
   *  rich room-by-room renderer, which needs server-only fields like
   *  `door_style_name` that the projection drops. */
  serverRaw: unknown;
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
    // Resolve the server value via write→read key normalisation (handles the
    // design-visit camelCase↔snake_case gap) and project it onto the attempted
    // shape so the comparison and the displayed "Server copy" line up.
    const rawServerValue = lookupServerValue(server, key);
    const serverValue = projectServerValue(attempted[key], rawServerValue);
    rows.push({
      key,
      label: humanizeKey(key),
      attempted: attempted[key],
      server: serverValue,
      serverRaw: rawServerValue,
      changed: !valuesEqual(attempted[key], serverValue),
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
  const attempted = unwrapRecord(attemptedBody);
  const server = unwrapRecord(serverData);
  const body: Record<string, unknown> = { ...(attemptedBody as Record<string, unknown>) };
  for (const key of restoreKeys) {
    // Resolve and reshape the server value to the write shape (camelCase for
    // design visits) so the restored body is one the endpoint accepts. Missing
    // server values become `null` to explicitly clear the field.
    const value = projectServerValue(attempted[key], lookupServerValue(server, key));
    body[key] = value === undefined ? null : value;
  }
  return body;
}

/** Per-field resolution choice. `mine` keeps the queued edit; `server` restores. */
type FieldChoice = 'mine' | 'server';

const ROOM_ATTR_DEFS: Array<{ key: 'door' | 'dim' | 'units' | 'price'; label: string; field: keyof NormalizedRoom }> = [
  { key: 'door', label: 'Door style', field: 'doorStyle' },
  { key: 'dim', label: 'Dimensions (W × H × D)', field: 'dimensions' },
  { key: 'units', label: 'Units', field: 'units' },
  { key: 'price', label: 'Unit price', field: 'price' },
];

/** One room's side-by-side comparison. Rooms are paired by position: a room
 *  present on only one side reads as added (your edit) or removed (server). */
function RoomDiffBlock({
  index,
  attemptedRaw,
  serverRaw,
  choice,
}: {
  index: number;
  attemptedRaw: unknown;
  serverRaw: unknown;
  choice: FieldChoice;
}) {
  const hasA = attemptedRaw != null;
  const hasS = serverRaw != null;
  const a = hasA ? normalizeRoom(attemptedRaw) : null;
  const s = hasS ? normalizeRoom(serverRaw) : null;
  const added = hasA && !hasS;
  const removed = hasS && !hasA;

  const attrs = ROOM_ATTR_DEFS.map((def) => ({
    ...def,
    mine: a ? a[def.field] : '—',
    server: s ? s[def.field] : '—',
    // A whole-room add/remove marks every attribute as changed; otherwise compare
    // the underlying values (door style by id, not the displayed name).
    changed: added || removed ? true : roomAttrChanged(attemptedRaw, serverRaw, def.key),
  }));
  const anyChanged = added || removed || attrs.some((x) => x.changed);

  const title = a?.name || s?.name || '';
  const status = added ? 'Added in your edit' : removed ? 'Only on server' : anyChanged ? 'Changed' : 'No changes';

  return (
    <Box
      data-testid="conflict-room"
      data-room-changed={anyChanged ? 'true' : 'false'}
      sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1 }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600, wordBreak: 'break-word' }}>
          {`Room ${index + 1}`}{title ? `: ${title}` : ''}
        </Typography>
        <Chip
          size="small"
          label={status}
          variant="outlined"
          color={added || removed ? 'warning' : anyChanged ? 'primary' : 'default'}
          sx={{ height: 18, fontSize: 10, flexShrink: 0 }}
        />
      </Stack>
      {anyChanged ? (
        attrs.map((attr) => (
          <Box key={attr.key} sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, mt: 0.5 }}>
            <Typography variant="caption" sx={{ gridColumn: '1 / -1', color: 'text.disabled' }}>
              {attr.label}
            </Typography>
            <Typography variant="body2" sx={diffCellSx(attr.changed, 'mine', choice)}>
              {attr.mine}
            </Typography>
            <Typography variant="body2" sx={diffCellSx(attr.changed, 'server', choice)}>
              {attr.server}
            </Typography>
          </Box>
        ))
      ) : (
        <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', mt: 0.25 }}>
          No changes
        </Typography>
      )}
    </Box>
  );
}

/** Render a design-visit `rooms` array as a legible room-by-room comparison
 *  instead of a truncated JSON blob. `attempted` is the queued edit's rooms;
 *  `server` is the raw server snapshot's rooms (kept un-projected so server-only
 *  fields like `door_style_name` survive for display). */
function RoomsDiff({
  attempted,
  server,
  choice,
}: {
  attempted: unknown;
  server: unknown;
  choice: FieldChoice;
}) {
  const aRooms = Array.isArray(attempted) ? attempted : [];
  const sRooms = Array.isArray(server) ? server : [];
  const count = Math.max(aRooms.length, sRooms.length);
  if (count === 0) {
    return (
      <Typography variant="body2" data-testid="conflict-rooms-empty" sx={{ color: 'text.disabled' }}>
        No rooms
      </Typography>
    );
  }
  return (
    <Stack spacing={1} data-testid="conflict-rooms-diff" sx={{ gridColumn: '1 / -1', mt: 0.5 }}>
      {Array.from({ length: count }, (_, i) => (
        <RoomDiffBlock
          key={i}
          index={i}
          attemptedRaw={aRooms[i] ?? null}
          serverRaw={sRooms[i] ?? null}
          choice={choice}
        />
      ))}
    </Stack>
  );
}

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
                {row.key === 'rooms' ? (
                  <RoomsDiff attempted={row.attempted} server={row.serverRaw} choice={choice} />
                ) : (
                  <>
                    <Typography variant="body2" sx={diffCellSx(row.changed, 'mine', choice)}>
                      {formatFieldValue(row.attempted)}
                    </Typography>
                    <Typography variant="body2" sx={diffCellSx(row.changed, 'server', choice)}>
                      {formatFieldValue(row.server)}
                    </Typography>
                  </>
                )}
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

  // Plain-language explanation shared with the admin Offline support tab, so
  // field users and admins read the same friendly, actionable wording.
  const explained = explainConflict({
    resolution: conflict.resolution,
    serverVersion: conflict.serverVersion,
    baseVersion: conflict.baseVersion,
  });

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

      <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }} data-testid="conflict-explanation">
        {explained.summary}
      </Typography>
      {explained.detail && (
        <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', mt: 0.5 }} data-testid="conflict-explanation-detail">
          {explained.detail}
        </Typography>
      )}

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

  // The intro must not assert "last edit wins" for conflicts whose edits were
  // actually held back (resolution === 'flagged'). Describe what really happened
  // based on the resolutions present: applied-on-top, held-back, or a mix.
  const hasApplied = conflicts.some((c) => c.resolution !== 'flagged');
  const hasFlagged = conflicts.some((c) => c.resolution === 'flagged');
  let introOutcome: string;
  if (hasApplied && hasFlagged) {
    introOutcome =
      'Some of your edits were saved on top (last edit wins) and others were held back so nothing was overwritten.';
  } else if (hasFlagged) {
    introOutcome = 'Your edits were held back, so nothing was overwritten.';
  } else {
    introOutcome = 'Your edits were kept (last edit wins).';
  }

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
            {' '}{introOutcome} For each conflict, keep your edit or restore the
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
