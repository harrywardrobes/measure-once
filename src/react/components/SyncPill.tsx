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
import Alert from '@mui/material/Alert';
import CloudQueueIcon from '@mui/icons-material/CloudQueue';
import CloudSyncIcon from '@mui/icons-material/CloudSync';
import SyncProblemIcon from '@mui/icons-material/SyncProblem';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import DownloadIcon from '@mui/icons-material/Download';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { useOfflineFailures } from '../hooks/useOfflineFailures';
import type { QueueCounts, QueueEntry, OfflineArea } from '../lib/offlineQueue';

// ── Pending-sync indicator ───────────────────────────────────────────────────────
// Shows whenever the offline write queue has entries: queued edits waiting to
// replay, an in-progress sync, or writes that exhausted their retries and need
// attention. Independent of online/offline state — it can appear while syncing.
//
// When there are failed writes the pill becomes clickable and opens a dialog
// listing each failed change with its error, plus one-tap Retry and Discard.
// Until then the failed items only retry automatically on the next reconnect.
//
// Lazy-loaded by GlobalHeader so its code (plus the offline-queue hooks and its
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
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toISOString();
  }
}

// ── Per-item failed card ─────────────────────────────────────────────────────────

function FailedCard({
  entry,
  onRetry,
  onDiscard,
}: {
  entry: QueueEntry;
  onRetry: (id: number) => void;
  onDiscard: (id: number) => void;
}) {
  return (
    <Box
      data-testid="failed-sync-card"
      sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1.5, p: 2 }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Chip label={areaLabel(entry.area)} size="small" color="error" variant="outlined" />
            <Typography variant="subtitle2" sx={{ fontWeight: 700, wordBreak: 'break-word' }}>
              {entry.label || entry.recordKey || 'Change'}
            </Typography>
          </Stack>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
            Last tried {formatTimestamp(entry.updatedAt)}
          </Typography>
        </Box>
      </Stack>

      <Typography
        variant="body2"
        data-testid="failed-sync-error"
        sx={{ color: 'error.main', mt: 1, wordBreak: 'break-word' }}
      >
        {entry.lastError || 'This change could not be synced after several attempts.'}
      </Typography>

      <Stack direction="row" sx={{ gap: 1, mt: 1.5, justifyContent: 'flex-end' }}>
        <Button
          size="small"
          color="inherit"
          startIcon={<DeleteOutlineIcon />}
          onClick={() => onDiscard(entry.id)}
          data-testid="failed-sync-discard"
        >
          Discard
        </Button>
        <Button
          size="small"
          variant="contained"
          startIcon={<RefreshIcon />}
          onClick={() => onRetry(entry.id)}
          data-testid="failed-sync-retry"
        >
          Retry
        </Button>
      </Stack>
    </Box>
  );
}

export interface SyncPillProps {
  /** Test/Storybook seam: inject counts instead of the live queue hook. */
  counts?: QueueCounts;
  /** Test/Storybook seam: inject failed entries instead of the live hook. */
  failures?: QueueEntry[];
  onRetry?: (id: number) => void | Promise<void>;
  onDiscard?: (id: number) => void | Promise<void>;
  onRetryAll?: () => void | Promise<void>;
  onDiscardAll?: () => void | Promise<void>;
  /** Force the dialog open (Storybook). */
  defaultOpen?: boolean;
}

export default function SyncPill(props: SyncPillProps) {
  const liveCounts = useOfflineQueue();
  const liveFailures = useOfflineFailures();

  const counts = props.counts ?? liveCounts;
  const failures = props.failures ?? liveFailures.failures;
  const retry = props.onRetry ?? liveFailures.retry;
  const discard = props.onDiscard ?? liveFailures.discard;
  const retryAll = props.onRetryAll ?? liveFailures.retryAll;
  const discardAll = props.onDiscardAll ?? liveFailures.discardAll;

  const [open, setOpen] = useState(!!props.defaultOpen);
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);

  const downloadPdf = () => {
    const list = failures;
    if (list.length === 0) return;
    void import('../lib/failuresPdf').then((m) => m.downloadFailuresPdf(list));
  };

  const { pending, syncing, failed } = counts;
  if (pending === 0 && syncing === 0 && failed === 0) return null;

  let tone: { color: string; bg: string; border: string };
  let Icon: typeof CloudQueueIcon;
  let label: string;
  let tooltip: string;

  if (failed > 0) {
    tone = { color: '#fca5a5', bg: 'rgba(239,68,68,0.16)', border: 'rgba(252,165,165,0.4)' };
    Icon = SyncProblemIcon;
    label = `${failed} failed`;
    tooltip = `${failed} change${failed === 1 ? '' : 's'} couldn't be synced after several attempts. Tap to review and retry.`;
  } else if (syncing > 0) {
    tone = { color: '#93c5fd', bg: 'rgba(59,130,246,0.16)', border: 'rgba(147,197,253,0.4)' };
    Icon = CloudSyncIcon;
    label = 'Syncing…';
    tooltip = 'Sending your saved changes to the server.';
  } else {
    const n = pending;
    tone = { color: '#fcd34d', bg: 'rgba(245,158,11,0.16)', border: 'rgba(252,211,77,0.4)' };
    Icon = CloudQueueIcon;
    label = `${n} pending`;
    tooltip = `${n} change${n === 1 ? '' : 's'} saved on this device, waiting to sync when you're back online.`;
  }

  const interactive = failed > 0;

  const pillSx = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 0.5,
    height: 28,
    px: 1,
    borderRadius: '8px',
    color: tone.color,
    bgcolor: tone.bg,
    border: `1px solid ${tone.border}`,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.03em',
    lineHeight: 1,
    whiteSpace: 'nowrap',
    ...(interactive && {
      cursor: 'pointer',
      font: 'inherit',
      '&:hover': { bgcolor: 'rgba(239,68,68,0.26)' },
    }),
  } as const;

  const pill = interactive ? (
    <Box
      component="button"
      type="button"
      onClick={() => setOpen(true)}
      role="status"
      aria-live="polite"
      aria-label={tooltip}
      data-testid="sync-pill"
      sx={pillSx}
    >
      <Icon fontSize="small" />
      <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>{label}</Box>
    </Box>
  ) : (
    <Box
      component="span"
      role="status"
      aria-live="polite"
      aria-label={tooltip}
      data-testid="sync-pill"
      sx={pillSx}
    >
      <Icon fontSize="small" />
      <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>{label}</Box>
    </Box>
  );

  return (
    <>
      <Tooltip title={tooltip}>{pill}</Tooltip>

      {interactive && (
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          maxWidth="sm"
          fullWidth
          data-testid="failed-sync-dialog"
        >
          <DialogTitle>Changes that failed to sync</DialogTitle>
          <DialogContent dividers>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
              These changes are still saved on this device but couldn&apos;t be sent to the server
              after several automatic attempts. Retry one to send it again now, or discard it if you
              no longer need it.
            </Typography>
            {failures.length === 0 ? (
              <Alert severity="success" icon={<CheckCircleOutlineIcon fontSize="small" />}>
                Nothing left to retry — all changes have been sent or discarded.
              </Alert>
            ) : (
              <Stack spacing={2}>
                {failures.map((entry) => (
                  <FailedCard
                    key={entry.id}
                    entry={entry}
                    onRetry={(id) => void retry(id)}
                    onDiscard={(id) => void discard(id)}
                  />
                ))}
              </Stack>
            )}
          </DialogContent>
          <DialogActions sx={{ flexWrap: 'wrap', gap: 1, justifyContent: 'space-between' }}>
            <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
              {failures.length > 0 && (
                <>
                  <Button
                    size="small"
                    color="inherit"
                    startIcon={<DownloadIcon />}
                    onClick={downloadPdf}
                    data-testid="failed-sync-download-pdf"
                  >
                    Download as PDF
                  </Button>
                  <Button
                    size="small"
                    color="error"
                    startIcon={<DeleteSweepIcon />}
                    onClick={() => setConfirmDiscardAll(true)}
                    data-testid="failed-sync-discard-all"
                  >
                    Discard all
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<RefreshIcon />}
                    onClick={() => void retryAll()}
                    data-testid="failed-sync-retry-all"
                  >
                    Retry all
                  </Button>
                </>
              )}
            </Stack>
            <Button onClick={() => setOpen(false)}>Close</Button>
          </DialogActions>
        </Dialog>
      )}

      {interactive && (
        <Dialog
          open={confirmDiscardAll}
          onClose={() => setConfirmDiscardAll(false)}
          maxWidth="xs"
          fullWidth
          data-testid="failed-sync-discard-all-confirm"
        >
          <DialogTitle>Discard all failed changes?</DialogTitle>
          <DialogContent>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              This permanently removes all {failures.length} failed change
              {failures.length === 1 ? '' : 's'} from this device. They can&apos;t be recovered.
              Consider downloading a PDF first if you may need to re-enter them.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button color="inherit" onClick={() => setConfirmDiscardAll(false)}>
              Cancel
            </Button>
            <Button
              variant="contained"
              color="error"
              startIcon={<DeleteSweepIcon />}
              onClick={() => {
                void discardAll();
                setConfirmDiscardAll(false);
              }}
              data-testid="failed-sync-discard-all-confirm-btn"
            >
              Discard all
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
}
