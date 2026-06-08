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
import MergeTypeIcon from '@mui/icons-material/MergeType';
import { useOfflineConflicts } from '../hooks/useOfflineConflicts';
import type { ConflictEntry, OfflineArea } from '../lib/offlineQueue';

// ── Offline sync-conflict review ─────────────────────────────────────────────────
// When a queued offline edit replays onto a record that changed on the server,
// the sync engine keeps your edit (last-write-wins) but persists a conflict so
// you can see what was overwritten. This header pill appears only while there
// are unreviewed conflicts; clicking it opens a list where each can be dismissed.
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

function ConflictCard({ conflict, onDismiss }: { conflict: ConflictEntry; onDismiss: (id: number) => void }) {
  const hasVersions = conflict.baseVersion != null || conflict.serverVersion != null;
  const hasTimestamps = !!conflict.baseUpdatedAt || !!conflict.serverUpdatedAt;

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
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
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
        <Button
          size="small"
          variant="text"
          color="inherit"
          onClick={() => onDismiss(conflict.id)}
          data-testid="conflict-dismiss"
        >
          Dismiss
        </Button>
      </Stack>

      <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>
        Someone else changed this record while your edit was waiting to sync. Your change was
        applied anyway (last edit wins), overwriting the server copy below.
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
    </Box>
  );
}

export interface ConflictsReviewProps {
  /** Test/Storybook seam: inject conflicts + handlers instead of the live hook. */
  conflicts?: ConflictEntry[];
  onDismiss?: (id: number) => void | Promise<void>;
  onDismissAll?: () => void | Promise<void>;
  /** Force the dialog open (Storybook). */
  defaultOpen?: boolean;
}

export default function ConflictsReview(props: ConflictsReviewProps) {
  const live = useOfflineConflicts();
  const conflicts = props.conflicts ?? live.conflicts;
  const dismiss = props.onDismiss ?? live.dismiss;
  const dismissAll = props.onDismissAll ?? live.dismissAll;

  const [open, setOpen] = useState(!!props.defaultOpen);

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
            Your edits were kept (last edit wins). Review what was overwritten, then dismiss each
            once you've checked it.
          </Typography>
          <Stack spacing={2}>
            {conflicts.map((c) => (
              <ConflictCard key={c.id} conflict={c} onDismiss={(id) => void dismiss(id)} />
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            color="inherit"
            onClick={() => void dismissAll()}
            data-testid="conflicts-dismiss-all"
          >
            Dismiss all
          </Button>
          <Button variant="contained" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
