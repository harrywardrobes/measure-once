import React, { useCallback, useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import { useToast } from '../../contexts/ToastContext';
import { broadcastCustomerInfoLinkChanged } from '../../utils/broadcastCustomerInfoLink';
import { ContactSearchPicker } from '../ContactSearchPicker';

interface InboxItem {
  id: number;
  created_at: string;
  photoUrls: string[];
}

function fmtDate(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

/** One inbox batch: thumbnails + assign-to-customer / discard. */
function InboxCard({
  item,
  onAssigned,
  onDiscarded,
}: {
  item: InboxItem;
  onAssigned: (id: number, contactName: string) => void;
  onDiscarded: (id: number) => void;
}) {
  const showToast = useToast();
  const [assigning, setAssigning] = useState(false);
  const [busy, setBusy] = useState(false);

  const assign = useCallback(async (contactId: string, contactName: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/photo-inbox/${item.id}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      broadcastCustomerInfoLinkChanged(contactId);
      onAssigned(item.id, contactName);
    } catch (e) {
      showToast((e as Error).message || 'Could not assign photos.', true);
      setBusy(false);
    }
  }, [busy, item.id, onAssigned, showToast]);

  const discard = useCallback(() => {
    window.showBottomConfirm(
      `Discard these ${item.photoUrls.length} photo${item.photoUrls.length === 1 ? '' : 's'}? This permanently deletes them.`,
      async () => {
        if (busy) return;
        setBusy(true);
        try {
          const r = await fetch(`/api/photo-inbox/${item.id}`, { method: 'DELETE' });
          if (!r.ok) {
            const b = (await r.json().catch(() => ({}))) as { error?: string };
            throw new Error(b.error || `HTTP ${r.status}`);
          }
          onDiscarded(item.id);
        } catch (e) {
          showToast((e as Error).message || 'Could not discard photos.', true);
          setBusy(false);
        }
      },
    );
  }, [busy, item.id, item.photoUrls.length, onDiscarded, showToast]);

  return (
    <Box
      data-testid={`inbox-card-${item.id}`}
      sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 1.5, opacity: busy ? 0.6 : 1 }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1, gap: 1 }}>
        <Typography variant="caption" color="text.secondary">
          {item.photoUrls.length} photo{item.photoUrls.length === 1 ? '' : 's'} · shared {fmtDate(item.created_at)}
        </Typography>
      </Stack>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))',
          gap: 0.75,
          mb: 1.5,
        }}
      >
        {item.photoUrls.map((url, i) => (
          <Box
            key={url}
            component="a"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            sx={{ display: 'block', aspectRatio: '1', borderRadius: 1, overflow: 'hidden', bgcolor: 'grey.100', border: '1px solid', borderColor: 'divider' }}
          >
            <Box component="img" src={url} alt={`Photo ${i + 1}`} loading="lazy" sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          </Box>
        ))}
      </Box>

      {!assigning ? (
        <Stack direction="row" spacing={1}>
          <Button size="small" variant="contained" disabled={busy} onClick={() => setAssigning(true)} data-testid={`inbox-assign-${item.id}`}>
            Assign to customer
          </Button>
          <Button size="small" color="error" disabled={busy} onClick={discard} data-testid={`inbox-discard-${item.id}`}>
            Discard
          </Button>
        </Stack>
      ) : (
        <Box>
          <ContactSearchPicker
            label="Assign to customer"
            onPick={(sel) => {
              if (sel) void assign(sel.id, sel.name);
            }}
          />
          <Button size="small" sx={{ mt: 1 }} disabled={busy} onClick={() => setAssigning(false)}>
            Cancel
          </Button>
        </Box>
      )}
    </Box>
  );
}

/**
 * Full-screen "Photo inbox" — the dedicated screen where photos shared into the
 * app (with no contact yet, via the Android share sheet or the iOS Shortcut)
 * are reviewed and assigned to a customer, or discarded. Lists only the current
 * user's own unassigned uploads.
 */
export function PhotoInboxModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const showToast = useToast();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    fetch('/api/photo-inbox', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as InboxItem[];
      })
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const handleAssigned = useCallback((id: number, contactName: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    showToast(`Photos assigned${contactName ? ` to ${contactName}` : ''}`);
  }, [showToast]);

  const handleDiscarded = useCallback((id: number) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    showToast('Photos discarded');
  }, [showToast]);

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      <AppBar position="sticky" color="default" elevation={1}>
        <Toolbar>
          <PhotoLibraryIcon sx={{ mr: 1.5, color: 'text.secondary' }} />
          <Typography variant="h6" sx={{ flex: 1 }}>Photo inbox</Typography>
          <IconButton onClick={load} aria-label="Refresh" disabled={loading} sx={{ mr: 0.5 }}>
            <RefreshIcon />
          </IconButton>
          <IconButton onClick={onClose} aria-label="Close" edge="end">
            <CloseIcon />
          </IconButton>
        </Toolbar>
      </AppBar>

      <Box sx={{ p: 2, maxWidth: 720, mx: 'auto', width: '100%' }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Photos you’ve shared into the app that aren’t linked to a customer yet.
          Assign each batch to a customer, or discard it.
        </Typography>

        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        )}
        {error && <Alert severity="error" sx={{ mb: 2 }}>Could not load the inbox: {error}</Alert>}
        {!loading && !error && items.length === 0 && (
          <Alert severity="info" data-testid="inbox-empty">
            Nothing to assign. Photos you share into the app from WhatsApp (or the camera)
            will appear here.
          </Alert>
        )}

        <Stack spacing={1.5}>
          {items.map((it) => (
            <InboxCard key={it.id} item={it} onAssigned={handleAssigned} onDiscarded={handleDiscarded} />
          ))}
        </Stack>
      </Box>
    </Dialog>
  );
}

export default PhotoInboxModal;
