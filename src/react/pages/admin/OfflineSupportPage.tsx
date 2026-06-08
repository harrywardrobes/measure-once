import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import CloudQueueIcon from '@mui/icons-material/CloudQueue';
import CloudSyncIcon from '@mui/icons-material/CloudSync';
import CloudDoneIcon from '@mui/icons-material/CloudDone';
import SyncProblemIcon from '@mui/icons-material/SyncProblem';
import SyncIcon from '@mui/icons-material/Sync';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { usePageTitle } from '../../hooks/usePageTitle';
import { useOfflineQueue } from '../../hooks/useOfflineQueue';
import { useOfflineFailures } from '../../hooks/useOfflineFailures';
import type { ConflictEntry } from '../../lib/offlineQueue';
import { FEATURE_AREAS, type CapabilityLevel } from '../../lib/offlineCapabilities';
import { explainSyncError } from '../../lib/syncErrorMessages';

/**
 * Admin → Offline support tab (#tab-offline).
 *
 * An operations view over the Offline Phase 1/2 infrastructure. It surfaces:
 *  - a config-driven **capability matrix** documenting which areas work fully
 *    offline, are view-only when cached, or need a live connection;
 *  - **live sync status** (pending / syncing / failed queue counts + the last
 *    successful sync time);
 *  - a **failed-changes list** of writes that exhausted their retry budget,
 *    with per-item Retry / Discard actions (reusing `useOfflineFailures`, the
 *    same hook backing the header SyncPill dialog);
 *  - a **lightweight conflicts list** of stale-write conflicts the sync engine
 *    flagged during replay, for manual review.
 *
 * The capability matrix data (`FEATURE_AREAS`) is imported from the shared
 * single source of truth `src/react/lib/offlineCapabilities.ts`; a CI lint
 * keeps it in lockstep with the real covered write surfaces and `docs/OFFLINE.md`.
 */

// ── Capability matrix (config-driven) ────────────────────────────────────────
// The matrix data (FEATURE_AREAS) lives in the shared single-source-of-truth
// module `src/react/lib/offlineCapabilities.ts`. A CI lint
// (scripts/check-offline-capability-sync.mjs) keeps it in sync with the real
// covered write surfaces and docs/OFFLINE.md, so this table can't drift.
// Only the presentational chip styling (CAPABILITY_META) is defined here.

interface CapabilityMeta {
  label: string;
  /** MUI Chip colour. */
  color: 'success' | 'warning' | 'default';
  icon: React.ReactElement;
  /** One-line explanation of what this level means. */
  blurb: string;
}

const CAPABILITY_META: Record<CapabilityLevel, CapabilityMeta> = {
  full: {
    label: 'Works offline',
    color: 'success',
    icon: <CheckCircleOutlineIcon fontSize="small" />,
    blurb: 'View and edit while offline. Changes are saved on this device and synced automatically when you reconnect.',
  },
  view: {
    label: 'View only offline',
    color: 'warning',
    icon: <VisibilityOutlinedIcon fontSize="small" />,
    blurb: 'Data you already loaded stays viewable offline, but making changes needs a connection.',
  },
  online: {
    label: 'Needs internet',
    color: 'default',
    icon: <CloudOffIcon fontSize="small" />,
    blurb: 'This area is unavailable until you reconnect.',
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTimestamp(ms: number | null): string {
  if (!ms) return 'No successful sync yet';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatRelative(ms: number | null): string | null {
  if (!ms) return null;
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const AREA_LABELS: Record<string, string> = {
  customer: 'Customer',
  visit: 'Visit',
  photo: 'Photo',
};

// ── Page ────────────────────────────────────────────────────────────────────

export function OfflineSupportPage() {
  usePageTitle('Offline support · Measure Once');

  const counts = useOfflineQueue();
  const { failures, retry, discard } = useOfflineFailures();
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [conflicts, setConflicts] = useState<ConflictEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [syncing, setSyncing] = useState<boolean>(false);

  // Dynamic-import the offline queue so its `idb` dependency stays out of the
  // always-loaded bundle (mirrors useOfflineQueue / SyncPill). Subscribe to the
  // queue's pub/sub so the conflicts list + last-sync time refresh live.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    let mod: typeof import('../../lib/offlineQueue') | null = null;

    const refresh = () => {
      if (!mod) return;
      Promise.all([mod.getConflicts(), mod.getLastSyncAt()])
        .then(([c, last]) => {
          if (cancelled) return;
          setConflicts(c);
          setLastSyncAt(last);
          setLoading(false);
        })
        .catch(() => { if (!cancelled) setLoading(false); });
    };

    import('../../lib/offlineQueue')
      .then((m) => {
        if (cancelled) return;
        mod = m;
        unsubscribe = m.subscribe(refresh);
        refresh();
      })
      .catch(() => { if (!cancelled) setLoading(false); });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const handleSyncNow = useCallback(async () => {
    setSyncing(true);
    try {
      const engine = await import('../../lib/syncEngine');
      await engine.flushQueue();
    } catch {
      /* best-effort — the periodic flush will retry */
    } finally {
      setSyncing(false);
    }
  }, []);

  const handleDismissConflict = useCallback(async (id: number) => {
    try {
      const mod = await import('../../lib/offlineQueue');
      await mod.clearConflict(id);
    } catch {
      /* best-effort */
    }
  }, []);

  const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

  return (
    <Stack spacing={2}>
      {/* Intro */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" sx={{ mb: 0.5 }}>
            Offline support
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Measure Once is an installable app that keeps working when your connection
            drops. The table below shows what each area can do offline, and the panels
            track changes saved on this device that are waiting to sync — including any
            that failed, which you can retry or discard individually.
          </Typography>
        </CardContent>
      </Card>

      {/* Sync status */}
      <Card variant="outlined">
        <CardContent>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 1,
              mb: 1.5,
            }}
          >
            <Typography variant="h6">Sync status</Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Button
                variant="outlined"
                size="small"
                startIcon={syncing ? <CircularProgress size={14} /> : <SyncIcon />}
                onClick={handleSyncNow}
                disabled={syncing || isOffline || counts.total === 0}
              >
                {syncing ? 'Syncing…' : 'Sync now'}
              </Button>
            </Box>
          </Box>

          {isOffline && (
            <Alert severity="info" icon={<CloudOffIcon fontSize="small" />} sx={{ mb: 1.5 }}>
              You appear to be offline. Saved changes will sync automatically when you reconnect.
            </Alert>
          )}

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' },
              gap: 1.5,
              mb: 2,
            }}
          >
            <StatTile icon={<CloudQueueIcon />} label="Pending" value={counts.pending} tone="warning" />
            <StatTile icon={<CloudSyncIcon />} label="Syncing" value={counts.syncing} tone="info" />
            <StatTile icon={<SyncProblemIcon />} label="Failed" value={counts.failed} tone="error" />
            <StatTile icon={<CloudDoneIcon />} label="Total queued" value={counts.total} tone="default" />
          </Box>

          <Divider sx={{ mb: 1.5 }} />

          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="body2" color="text.secondary">
              Last successful sync:
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {formatTimestamp(lastSyncAt)}
            </Typography>
            {formatRelative(lastSyncAt) && (
              <Typography variant="caption" color="text.secondary">
                ({formatRelative(lastSyncAt)})
              </Typography>
            )}
          </Box>

          {counts.failed > 0 && (
            <Alert severity="warning" icon={<WarningAmberIcon fontSize="small" />} sx={{ mt: 1.5 }}>
              {counts.failed} change{counts.failed === 1 ? '' : 's'} couldn&apos;t be synced after
              several attempts. They will retry automatically on the next connection, or use{' '}
              <strong>Sync now</strong> to retry immediately.
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Capability matrix */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" sx={{ mb: 0.5 }}>
            What works offline
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Offline access relies on data you have already loaded. Open an area while online
            to cache it for offline viewing.
          </Typography>

          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
            {(Object.keys(CAPABILITY_META) as CapabilityLevel[]).map((level) => {
              const meta = CAPABILITY_META[level];
              return (
                <Tooltip key={level} title={meta.blurb}>
                  <Chip
                    icon={meta.icon}
                    label={meta.label}
                    color={meta.color}
                    variant={meta.color === 'default' ? 'outlined' : 'filled'}
                    size="small"
                  />
                </Tooltip>
              );
            })}
          </Box>

          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700, width: '26%' }}>Area</TableCell>
                <TableCell sx={{ fontWeight: 700, width: '20%' }}>Offline</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Details</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {FEATURE_AREAS.map((area) => {
                const meta = CAPABILITY_META[area.capability];
                return (
                  <TableRow key={area.name}>
                    <TableCell sx={{ fontWeight: 600 }}>{area.name}</TableCell>
                    <TableCell>
                      <Chip
                        icon={meta.icon}
                        label={meta.label}
                        color={meta.color}
                        variant={meta.color === 'default' ? 'outlined' : 'filled'}
                        size="small"
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {area.detail}
                      </Typography>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Failed changes */}
      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mb: 0.5 }}>
            <Typography variant="h6">Changes that failed to sync</Typography>
            {failures.length > 0 && (
              <Chip label={failures.length} color="error" size="small" />
            )}
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            These changes are still saved on this device but couldn&apos;t be sent to the server
            after several automatic attempts. Retry one to send it again now, or discard it if it
            is no longer needed.
          </Typography>

          {failures.length === 0 ? (
            <Alert severity="success" icon={<CheckCircleOutlineIcon fontSize="small" />}>
              No failed changes — everything has synced or is still queued.
            </Alert>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700, width: '16%' }}>Area</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Change</TableCell>
                  <TableCell sx={{ fontWeight: 700, width: '18%' }}>Last tried</TableCell>
                  <TableCell sx={{ fontWeight: 700, width: '18%' }} align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {failures.map((entry) => (
                  <TableRow key={entry.id} data-testid="failed-sync-row">
                    <TableCell>
                      <Chip
                        label={AREA_LABELS[entry.area] ?? entry.area}
                        size="small"
                        color="error"
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600, wordBreak: 'break-word' }}>
                        {entry.label || entry.recordKey || 'Change'}
                      </Typography>
                      {(() => {
                        const explained = explainSyncError(entry.lastError);
                        return (
                          <>
                            <Typography
                              variant="caption"
                              data-testid="failed-sync-error"
                              sx={{ color: 'error.main', display: 'block', wordBreak: 'break-word' }}
                            >
                              {explained.summary}
                            </Typography>
                            {explained.mapped && explained.raw && (
                              <Tooltip title={explained.raw}>
                                <Typography
                                  variant="caption"
                                  data-testid="failed-sync-error-detail"
                                  sx={{ color: 'text.secondary', display: 'block', wordBreak: 'break-word' }}
                                >
                                  Details: {explained.raw}
                                </Typography>
                              </Tooltip>
                            )}
                          </>
                        );
                      })()}
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {formatTimestamp(entry.updatedAt)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" sx={{ gap: 1, justifyContent: 'flex-end' }}>
                        <Button
                          size="small"
                          color="inherit"
                          startIcon={<DeleteOutlineIcon />}
                          onClick={() => void discard(entry.id)}
                          data-testid="failed-sync-discard"
                        >
                          Discard
                        </Button>
                        <Button
                          size="small"
                          variant="contained"
                          startIcon={<RefreshIcon />}
                          onClick={() => void retry(entry.id)}
                          data-testid="failed-sync-retry"
                        >
                          Retry
                        </Button>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Conflicts */}
      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mb: 0.5 }}>
            <Typography variant="h6">Conflicts for review</Typography>
            {conflicts.length > 0 && (
              <Chip label={conflicts.length} color="warning" size="small" />
            )}
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            When a queued edit replays onto a record that changed on the server in the
            meantime, the change is still applied (last-write-wins) and flagged here so
            you can double-check it. Dismiss an entry once you have reviewed it.
          </Typography>

          {loading ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">Loading…</Typography>
            </Box>
          ) : conflicts.length === 0 ? (
            <Alert severity="success" icon={<CheckCircleOutlineIcon fontSize="small" />}>
              No conflicts to review.
            </Alert>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700, width: '14%' }}>Area</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Change</TableCell>
                  <TableCell sx={{ fontWeight: 700, width: '20%' }}>Detected</TableCell>
                  <TableCell sx={{ fontWeight: 700, width: '12%' }} align="right">Action</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {conflicts.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Chip label={AREA_LABELS[c.area] ?? c.area} size="small" variant="outlined" />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{c.label}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {c.recordKey ? `${c.recordKey} · ` : ''}applied (last-write-wins)
                        {c.serverVersion != null && c.baseVersion != null
                          ? ` · server v${c.serverVersion} vs yours v${c.baseVersion}`
                          : ''}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {formatTimestamp(c.detectedAt)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Button size="small" onClick={() => handleDismissConflict(c.id)}>
                        Dismiss
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </Stack>
  );
}

// ── Small presentational stat tile ───────────────────────────────────────────

function StatTile({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactElement;
  label: string;
  value: number;
  tone: 'warning' | 'info' | 'error' | 'default';
}) {
  const toneColor: Record<string, string> = {
    warning: 'warning.main',
    info: 'info.main',
    error: 'error.main',
    default: 'text.secondary',
  };
  const active = value > 0 && tone !== 'default';
  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        p: 1.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, color: active ? toneColor[tone] : 'text.secondary' }}>
        {icon}
        <Typography variant="caption" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {label}
        </Typography>
      </Box>
      <Typography variant="h5" sx={{ fontWeight: 700, color: active ? toneColor[tone] : 'text.primary' }}>
        {value}
      </Typography>
    </Box>
  );
}

export default OfflineSupportPage;
