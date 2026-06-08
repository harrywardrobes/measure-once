import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import CloudQueueIcon from '@mui/icons-material/CloudQueue';
import CloudSyncIcon from '@mui/icons-material/CloudSync';
import SyncProblemIcon from '@mui/icons-material/SyncProblem';
import { useOfflineQueue } from '../hooks/useOfflineQueue';

// ── Pending-sync indicator ───────────────────────────────────────────────────────
// Shows whenever the offline write queue has entries: queued edits waiting to
// replay, an in-progress sync, or writes that exhausted their retries and need
// attention. Independent of online/offline state — it can appear while syncing.
//
// Lazy-loaded by GlobalHeader so its code (plus the offline-queue hook and its
// icons) stays out of the always-loaded main.js bundle.
export default function SyncPill() {
  const { pending, syncing, failed } = useOfflineQueue();
  if (pending === 0 && syncing === 0 && failed === 0) return null;

  let tone: { color: string; bg: string; border: string };
  let Icon: typeof CloudQueueIcon;
  let label: string;
  let tooltip: string;

  if (failed > 0) {
    tone = { color: '#fca5a5', bg: 'rgba(239,68,68,0.16)', border: 'rgba(252,165,165,0.4)' };
    Icon = SyncProblemIcon;
    label = `${failed} failed`;
    tooltip = `${failed} change${failed === 1 ? '' : 's'} couldn't be synced after several attempts. They'll retry when you reconnect.`;
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

  return (
    <Tooltip title={tooltip}>
      <Box
        component="span"
        role="status"
        aria-live="polite"
        aria-label={tooltip}
        data-testid="sync-pill"
        sx={{
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
        }}
      >
        <Icon fontSize="small" />
        <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>{label}</Box>
      </Box>
    </Tooltip>
  );
}
