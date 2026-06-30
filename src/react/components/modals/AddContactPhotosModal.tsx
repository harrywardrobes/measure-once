import React, { useEffect, useRef, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import AddPhotoAlternateIcon from '@mui/icons-material/AddPhotoAlternate';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import { useToast } from '../../contexts/ToastContext';
import { broadcastCustomerInfoLinkChanged } from '../../utils/broadcastCustomerInfoLink';
import { ContactSearchPicker } from '../ContactSearchPicker';

// Keep these in lockstep with the server limits in customer-info.js
// (MAX_PHOTO_FILES / MAX_PHOTO_BYTES) so the client rejects over-limit
// selections before wasting an upload round-trip.
const MAX_FILES = 15;
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB
const ACCEPT = 'image/*,application/pdf';
const ACCEPT_RE = /^(image\/|application\/pdf$)/i;

interface AddContactPhotosModalProps {
  open: boolean;
  onClose: () => void;
  /** When known (detail page / customers-list row), the upload target. When
   *  omitted, the modal shows a customer picker first. */
  contactId?: string | null;
  contactName?: string | null;
  /** Called after a successful upload with the resolved contact + photo count. */
  onUploaded?: (result: { contactId: string; count: number }) => void;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/**
 * Staff-facing "Add photos" modal. Uploads selected image/PDF files straight
 * onto a contact (POST /api/customer-info/by-contact/:id/photos), where they are
 * folded into the contact's existing photo set and surfaced by
 * CustomerInfoSubmissionsRail. Reused by the customer detail page, the Customers
 * list, and Home — Home/list launches without a contactId, so the modal shows a
 * customer picker first.
 *
 * File selections are not draft-saved: File objects are not serialisable to
 * localStorage, so there is nothing to persist between mounts. The modal resets
 * its selection whenever it closes.
 */
export function AddContactPhotosModal({
  open,
  onClose,
  contactId: fixedContactId,
  contactName: fixedContactName,
  onUploaded,
}: AddContactPhotosModalProps) {
  const showToast = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const contactId = fixedContactId || picked?.id || '';
  const contactName = fixedContactName || picked?.name || '';
  const needsPicker = !fixedContactId;

  // Reset everything when the modal closes so a re-open starts clean.
  useEffect(() => {
    if (!open) {
      setPicked(null);
      setFiles([]);
      setUploading(false);
      setError('');
      if (inputRef.current) inputRef.current.value = '';
    }
  }, [open]);

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setError('');
    const incoming = Array.from(list);
    const rejected: string[] = [];
    const accepted: File[] = [];
    for (const f of incoming) {
      if (!ACCEPT_RE.test(f.type)) {
        rejected.push(`${f.name} (unsupported type)`);
        continue;
      }
      if (f.size > MAX_FILE_BYTES) {
        rejected.push(`${f.name} (over ${fmtBytes(MAX_FILE_BYTES)})`);
        continue;
      }
      accepted.push(f);
    }
    setFiles((prev) => {
      const merged = [...prev, ...accepted];
      if (merged.length > MAX_FILES) {
        rejected.push(`only the first ${MAX_FILES} files are kept`);
        return merged.slice(0, MAX_FILES);
      }
      return merged;
    });
    if (rejected.length) {
      setError(`Some files were skipped: ${rejected.join(', ')}.`);
    }
    // Allow re-selecting the same file again after a remove.
    if (inputRef.current) inputRef.current.value = '';
  }

  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleUpload() {
    if (!contactId) {
      setError('Choose a customer first.');
      return;
    }
    if (files.length === 0) {
      setError('Add at least one photo.');
      return;
    }
    setUploading(true);
    setError('');
    try {
      const fd = new FormData();
      for (const f of files) fd.append('photos', f, f.name);
      // No Content-Type header — the browser sets the multipart boundary.
      const res = await fetch(
        `/api/customer-info/by-contact/${encodeURIComponent(contactId)}/photos`,
        { method: 'POST', body: fd },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Upload failed (HTTP ${res.status}).`);
      }
      const data = (await res.json().catch(() => ({}))) as { keys?: string[] };
      const count = Array.isArray(data.keys) ? data.keys.length : files.length;
      // Tell the contact's photo rail (and other tabs) to refetch.
      broadcastCustomerInfoLinkChanged(contactId);
      showToast(
        `${count} photo${count === 1 ? '' : 's'} added${contactName ? ` to ${contactName}` : ''}`,
      );
      onUploaded?.({ contactId, count });
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  return (
    <Dialog open={open} onClose={uploading ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        Add photos{fixedContactName ? ` — ${fixedContactName}` : ''}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {error && <Alert severity="warning" data-testid="add-photos-error">{error}</Alert>}

          {needsPicker && (
            <Box>
              <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', display: 'block', mb: 0.75 }}>
                Customer
              </Typography>
              {picked ? (
                <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>{picked.name}</Typography>
                  <Button size="small" onClick={() => setPicked(null)} disabled={uploading}>
                    Change
                  </Button>
                </Stack>
              ) : (
                <ContactSearchPicker onPick={setPicked} />
              )}
            </Box>
          )}

          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            data-testid="add-photos-input"
            onChange={(e) => addFiles(e.target.files)}
          />

          <Button
            variant="outlined"
            startIcon={<AddPhotoAlternateIcon />}
            onClick={() => inputRef.current?.click()}
            disabled={uploading || (needsPicker && !picked)}
            data-testid="add-photos-choose-btn"
          >
            {files.length ? 'Add more photos' : 'Choose photos'}
          </Button>

          {files.length > 0 && (
            <Box>
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5 }}>
                {files.length} file{files.length === 1 ? '' : 's'} · {fmtBytes(totalBytes)}
              </Typography>
              <Stack spacing={0.5} data-testid="add-photos-file-list">
                {files.map((f, i) => (
                  <Stack
                    key={`${f.name}-${i}`}
                    direction="row"
                    sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1 }}
                  >
                    <Typography variant="body2" noWrap sx={{ minWidth: 0, flex: 1 }}>
                      {f.name}
                    </Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary', flexShrink: 0 }}>
                      {fmtBytes(f.size)}
                    </Typography>
                    <IconButton
                      size="small"
                      onClick={() => removeFile(i)}
                      disabled={uploading}
                      aria-label={`Remove ${f.name}`}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                ))}
              </Stack>
            </Box>
          )}

          {uploading && <LinearProgress data-testid="add-photos-progress" />}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={uploading}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleUpload}
          disabled={uploading || !contactId || files.length === 0}
          data-testid="add-photos-upload-btn"
        >
          {uploading ? 'Uploading…' : `Upload${files.length ? ` ${files.length}` : ''}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default AddContactPhotosModal;
