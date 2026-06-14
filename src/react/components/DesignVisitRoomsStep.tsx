import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { FileUploadField, UploadStatus } from './FileUploadField';
import { BRAND_COLORS, STATUS_COLORS } from '../theme';

export interface RoomImage {
  storageKey: string;
  mimeType: string | null;
  viewUrl: string;
}

export interface RoomData {
  roomName: string;
  doorStyleId: string;
  widthMm: number | null;
  heightMm: number | null;
  depthMm: number | null;
  unitCount: number;
  unitPricePence: number;
  notes: string;
  images: RoomImage[];
}

export interface DoorStyleOption {
  id: string | number;
  name: string;
}

export interface DesignVisitRoomsStepProps {
  initialRooms: RoomData[];
  doorStyles: DoorStyleOption[];
  onRoomsChange: (rooms: RoomData[]) => void;
  onUploadingChange?: (isUploading: boolean) => void;
  /** Called with each storage key immediately after a successful upload. */
  onNewUpload?: (storageKey: string) => void;
  /** Called with a storage key when a photo is removed (the DELETE is already fired by the step). */
  onImageRemoved?: (storageKey: string) => void;
  /**
   * When true the step runs in read-only demo mode: photo upload and delete
   * API calls are suppressed.  The upload control is hidden so the admin can
   * see the rooms form layout without accidentally triggering writes.
   */
  demo?: boolean;
}

/**
 * Internal room representation — wraps the public RoomData with a stable
 * client-side ID so upload state and results are always routed to the correct
 * room even if rooms are reordered or removed while an upload is in flight.
 */
type InternalRoom = {
  clientId: string;
  data: RoomData;
};

function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `room-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeInternalRoom(data?: Partial<RoomData>): InternalRoom {
  return {
    clientId: newClientId(),
    data: {
      roomName: '',
      doorStyleId: '',
      widthMm: null,
      heightMm: null,
      depthMm: null,
      unitCount: 1,
      unitPricePence: 0,
      notes: '',
      images: [],
      ...data,
    },
  };
}

function toPublic(rooms: InternalRoom[]): RoomData[] {
  return rooms.map(r => r.data);
}

export function DesignVisitRoomsStep({
  initialRooms,
  doorStyles,
  onRoomsChange,
  onUploadingChange,
  onNewUpload,
  onImageRemoved,
  demo,
}: DesignVisitRoomsStepProps) {
  const [rooms, setRooms] = useState<InternalRoom[]>(() => {
    const src = initialRooms.length ? initialRooms : [{}];
    return src.map(r => makeInternalRoom({ ...r, images: (r as RoomData).images ?? [] }));
  });

  // Keyed by stable clientId — safe across reorder/remove operations.
  const [uploadStatusById, setUploadStatusById] = useState<Record<string, UploadStatus>>({});
  // Upload progress percentage (0-100) per room, shown during 'uploading' status.
  const [uploadProgressById, setUploadProgressById] = useState<Record<string, number>>({});
  // Bump to reset FileUploadField after each upload batch completes.
  const [fileKeyById, setFileKeyById] = useState<Record<string, number>>({});

  const onRoomsChangeRef = useRef(onRoomsChange);
  const onUploadingChangeRef = useRef(onUploadingChange);
  useEffect(() => { onRoomsChangeRef.current = onRoomsChange; }, [onRoomsChange]);
  useEffect(() => { onUploadingChangeRef.current = onUploadingChange; }, [onUploadingChange]);

  useEffect(() => {
    onRoomsChangeRef.current(toPublic(rooms));
  }, [rooms]);

  useEffect(() => {
    const anyUploading = Object.values(uploadStatusById).some(s => s === 'uploading');
    onUploadingChangeRef.current?.(anyUploading);
  }, [uploadStatusById]);

  function updateRoomData(clientId: string, patch: Partial<RoomData>) {
    setRooms(prev =>
      prev.map(r => r.clientId === clientId ? { ...r, data: { ...r.data, ...patch } } : r)
    );
  }

  function addRoom() {
    setRooms(prev => [...prev, makeInternalRoom()]);
  }

  function removeRoom(clientId: string) {
    setRooms(prev => prev.filter(r => r.clientId !== clientId));
    setUploadStatusById(prev => { const n = { ...prev }; delete n[clientId]; return n; });
    setUploadProgressById(prev => { const n = { ...prev }; delete n[clientId]; return n; });
    setFileKeyById(prev => { const n = { ...prev }; delete n[clientId]; return n; });
  }

  // Tracks re-sign attempts per opaque storage key so a genuinely broken image
  // (not just an expired URL) cannot loop the sign endpoint forever. Attempts
  // reset after a long gap so a real TTL expiry (e.g. an hours-long editing
  // session) is always re-signable again.
  const resignStateRef = useRef<Map<string, { attempts: number; ts: number }>>(new Map());

  /**
   * Lazily refresh an expired thumbnail. The signed `viewUrl` for an
   * online-uploaded photo is short-lived (~1h); if the wizard stays open past
   * that TTL the browser fails to load the thumbnail. On that failure we
   * re-derive a fresh signed URL for the opaque key and swap it in, so previews
   * keep working through long editing sessions.
   *
   * Offline-captured photos keep a `data:` URI in `storageKey` and render
   * directly — they are never re-signed (a failed data URI is genuinely broken).
   */
  function handleImageError(clientId: string, imgIdx: number) {
    setRooms(prev => {
      const room = prev.find(r => r.clientId === clientId);
      const img = room?.data.images[imgIdx];
      const key = img?.storageKey || '';
      if (!key.startsWith('obj:')) return prev; // data URI / legacy URL — can't re-sign

      const now = Date.now();
      const state = resignStateRef.current.get(key) || { attempts: 0, ts: 0 };
      // Reset the attempt counter after 5 min of quiet so a later genuine
      // expiry can be re-signed again.
      if (now - state.ts > 5 * 60 * 1000) state.attempts = 0;
      if (state.attempts >= 3) return prev; // give up — key is genuinely broken
      state.attempts += 1;
      state.ts = now;
      resignStateRef.current.set(key, state);

      void (async () => {
        try {
          const r = await fetch('/api/design-visits/sign-image-urls', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ storageKeys: [key] }),
          });
          if (!r.ok) return;
          const data = await r.json();
          const fresh = data?.urls?.[key];
          if (typeof fresh !== 'string' || !fresh) return;
          setRooms(curr =>
            curr.map(rm =>
              rm.clientId !== clientId
                ? rm
                : {
                    ...rm,
                    data: {
                      ...rm.data,
                      images: rm.data.images.map((im, i) =>
                        i === imgIdx && im.storageKey === key ? { ...im, viewUrl: fresh } : im
                      ),
                    },
                  }
            )
          );
        } catch {
          // Offline or server error — leave the broken thumbnail; the underlying
          // image data still re-submits correctly on save.
        }
      })();

      return prev;
    });
  }

  function removeImage(clientId: string, imgIdx: number) {
    let removedKey: string | null = null;
    setRooms(prev =>
      prev.map(r => {
        if (r.clientId !== clientId) return r;
        const img = r.data.images[imgIdx];
        if (img) removedKey = img.storageKey;
        return { ...r, data: { ...r.data, images: r.data.images.filter((_, i) => i !== imgIdx) } };
      })
    );
    if (removedKey) {
      const key = removedKey;
      onImageRemoved?.(key);
      if (!demo) {
        fetch(`/api/design-visits/uploads/${encodeURIComponent(key)}`, { method: 'DELETE' })
          .catch(err => console.warn('[design-visit] photo delete failed:', err));
      }
    }
  }

  function moveRoom(clientId: string, dir: -1 | 1) {
    setRooms(prev => {
      const idx = prev.findIndex(r => r.clientId === clientId);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  /**
   * Upload files for a specific room, identified by stable `clientId`.
   *
   * The upload result is applied via a functional setRooms update that finds
   * the room by clientId, not by array position. This means reordering or
   * removing rooms during the upload cannot attach images to the wrong room
   * or silently drop them.
   */
  async function handleFilesSelected(clientId: string, files: FileList | null) {
    if (demo) return;
    if (!files || !files.length) return;
    setUploadStatusById(prev => ({ ...prev, [clientId]: 'uploading' }));
    setUploadProgressById(prev => ({ ...prev, [clientId]: 0 }));

    const fileArray = Array.from(files);
    const totalFiles = fileArray.length;

    const uploaded: RoomImage[] = [];
    let hadError = false;
    for (let i = 0; i < fileArray.length; i++) {
      const file = fileArray[i];
      const basePct = (i / totalFiles) * 100;

      // Read the file as a data URL first. This doubles as the offline payload:
      // when we cannot reach the upload endpoint we keep this data URI on the
      // image so the (queued) design-visit submit carries the bytes inline, and
      // the server materialises them into object storage on reconnect.
      let dataUrl: string;
      try {
        dataUrl = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result as string);
          fr.onerror = () => reject(new Error('FileReader error'));
          fr.readAsDataURL(file);
        });
      } catch (err: unknown) {
        hadError = true;
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.warn('[design-visit] photo read failed:', msg);
        const w = window as { toast?: (m: string) => void };
        if (typeof w.toast === 'function') w.toast('Could not read photo: ' + msg);
        continue;
      }

      // Keep the photo inline (no server upload). Used when offline or when the
      // upload request fails at the network level — the bytes ride along in the
      // queued submit instead of being dropped.
      const keepInline = () => {
        uploaded.push({ storageKey: dataUrl, mimeType: file.type || null, viewUrl: dataUrl });
        setUploadProgressById(prev => ({
          ...prev,
          [clientId]: Math.round(((i + 1) / totalFiles) * 100),
        }));
      };

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        keepInline();
        continue;
      }

      let data: { storageKey?: string; mimeType?: string; viewUrl?: string; error?: string; status?: number };
      try {
        const body = JSON.stringify({ dataUrl });
        data = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/design-visits/uploads');
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.upload.onprogress = (evt) => {
            if (evt.lengthComputable) {
              const filePct = (evt.loaded / evt.total) * (100 / totalFiles);
              setUploadProgressById(prev => ({
                ...prev,
                [clientId]: Math.round(basePct + filePct),
              }));
            }
          };
          xhr.onload = () => {
            setUploadProgressById(prev => ({
              ...prev,
              [clientId]: Math.round(((i + 1) / totalFiles) * 100),
            }));
            try {
              resolve({ ...JSON.parse(xhr.responseText), status: xhr.status });
            } catch {
              reject(new Error('Invalid JSON response'));
            }
          };
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.onabort = () => reject(new Error('Upload aborted'));
          xhr.send(body);
        });
      } catch (netErr: unknown) {
        // Network-level failure (connection lost mid-upload, abort). Treat like
        // offline: keep the photo inline so the queued submit still carries it.
        const msg = netErr instanceof Error ? netErr.message : 'unknown error';
        console.warn('[design-visit] photo upload network error, keeping inline:', msg);
        keepInline();
        continue;
      }

      if ((data.status !== undefined && data.status >= 400) || !data.storageKey) {
        // Server rejected the upload (e.g. too large / unsupported type). This
        // would fail again on replay, so surface it rather than queue a doomed
        // photo.
        hadError = true;
        const msg = data.error || 'Upload failed';
        console.warn('[design-visit] photo upload rejected:', msg);
        const w = window as { toast?: (m: string) => void };
        if (typeof w.toast === 'function') w.toast('Photo upload failed: ' + msg);
        continue;
      }

      const newImg: RoomImage = {
        storageKey: data.storageKey,
        mimeType: data.mimeType || file.type,
        viewUrl: data.viewUrl || '',
      };
      onNewUpload?.(newImg.storageKey);
      uploaded.push(newImg);
    }

    if (uploaded.length > 0) {
      // Find room by stable clientId — safe even if the room was reordered or
      // other rooms were removed while this upload was in flight.
      setRooms(prev =>
        prev.map(r =>
          r.clientId === clientId
            ? { ...r, data: { ...r.data, images: [...(r.data.images || []), ...uploaded] } }
            : r
        )
      );
    }

    const finalStatus: UploadStatus = hadError ? 'error' : 'success';
    // Bump key to reset the FileUploadField (clears selected-file display),
    // then let resetDelay/onStatusReset on the field return it to idle.
    setFileKeyById(prev => ({ ...prev, [clientId]: (prev[clientId] ?? 0) + 1 }));
    setUploadStatusById(prev => ({ ...prev, [clientId]: finalStatus }));
    setUploadProgressById(prev => { const n = { ...prev }; delete n[clientId]; return n; });
  }

  return (
    <Box>
      {rooms.map((room, idx) => {
        const { clientId, data } = room;
        const uploadStatus = uploadStatusById[clientId] ?? 'idle';
        const uploadProgress = uploadProgressById[clientId];

        return (
          <Box
            key={clientId}
            sx={{
              border: '1.5px solid var(--neutral-200)',
              borderRadius: '10px',
              p: '14px',
              mb: '12px',
            }}
          >
            {/* Header row: reorder buttons, room title, remove */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: '10px' }}>
              <IconButton
                size="small"
                title="Move up"
                disabled={idx === 0}
                onClick={() => moveRoom(clientId, -1)}
                sx={{
                  border: '1.5px solid var(--neutral-300)',
                  borderRadius: '7px',
                  p: '3px',
                  color: 'var(--neutral-500)',
                  '&:disabled': { opacity: 0.35 },
                }}
              >
                <KeyboardArrowUpIcon sx={{ fontSize: '0.9rem' }} />
              </IconButton>
              <IconButton
                size="small"
                title="Move down"
                disabled={idx === rooms.length - 1}
                onClick={() => moveRoom(clientId, 1)}
                sx={{
                  border: '1.5px solid var(--neutral-300)',
                  borderRadius: '7px',
                  p: '3px',
                  color: 'var(--neutral-500)',
                  '&:disabled': { opacity: 0.35 },
                }}
              >
                <KeyboardArrowDownIcon sx={{ fontSize: '0.9rem' }} />
              </IconButton>
              <Typography
                sx={{ fontWeight: 700, fontSize: '.9rem', color: 'var(--neutral-700)', flex: 1 }}
              >
                Room {idx + 1}
              </Typography>
              {rooms.length > 1 && (
                <Button
                  size="small"
                  onClick={() => removeRoom(clientId)}
                  sx={{
                    border: '1.5px solid var(--neutral-300)',
                    borderRadius: '7px',
                    px: '10px',
                    py: '4px',
                    bgcolor: 'background.paper',
                    fontSize: '.8rem',
                    color: 'var(--neutral-700)',
                    textTransform: 'none',
                    minWidth: 0,
                    '&:hover': {
                      background: STATUS_COLORS.errorLight.bg,
                      borderColor: STATUS_COLORS.error.border,
                      color: 'error.main',
                    },
                  }}
                >
                  Remove
                </Button>
              )}
            </Box>

            {/* Room name */}
            <TextField
              label={
                <>
                  Room name{' '}
                  <Box component="span" sx={{ color: STATUS_COLORS.error.text }}>
                    *
                  </Box>
                </>
              }
              size="small"
              fullWidth
              slotProps={{ htmlInput: { maxLength: 200 } }}
              placeholder="e.g. Kitchen"
              value={data.roomName}
              onChange={e => updateRoomData(clientId, { roomName: e.target.value })}
              sx={{ mb: 1.5 }}
            />

            {/* Door style */}
            {doorStyles.length > 0 && (
              <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
                <InputLabel>Door style</InputLabel>
                <Select
                  label="Door style"
                  value={data.doorStyleId ? String(data.doorStyleId) : ''}
                  onChange={e => updateRoomData(clientId, { doorStyleId: e.target.value })}
                >
                  <MenuItem value="">— none —</MenuItem>
                  {doorStyles.map(ds => (
                    <MenuItem key={ds.id} value={String(ds.id)}>
                      {ds.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            {/* Dimensions */}
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr',
                gap: '10px',
                mb: 1.5,
              }}
            >
              <TextField
                label="Width (mm)"
                size="small"
                type="number"
                slotProps={{ htmlInput: { min: 0 } }}
                placeholder="e.g. 3500"
                value={data.widthMm ?? ''}
                onChange={e =>
                  updateRoomData(clientId, { widthMm: parseInt(e.target.value, 10) || null })
                }
              />
              <TextField
                label="Height (mm)"
                size="small"
                type="number"
                slotProps={{ htmlInput: { min: 0 } }}
                placeholder="e.g. 2400"
                value={data.heightMm ?? ''}
                onChange={e =>
                  updateRoomData(clientId, { heightMm: parseInt(e.target.value, 10) || null })
                }
              />
              <TextField
                label="Depth (mm)"
                size="small"
                type="number"
                slotProps={{ htmlInput: { min: 0 } }}
                placeholder="e.g. 600"
                value={data.depthMm ?? ''}
                onChange={e =>
                  updateRoomData(clientId, { depthMm: parseInt(e.target.value, 10) || null })
                }
              />
            </Box>

            {/* Unit count + unit price */}
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '12px',
                mb: 1.5,
              }}
            >
              <TextField
                label={
                  <>
                    Unit count{' '}
                    <Box component="span" sx={{ color: STATUS_COLORS.error.text }}>
                      *
                    </Box>
                  </>
                }
                size="small"
                type="number"
                slotProps={{ htmlInput: { min: 1 } }}
                value={data.unitCount}
                onChange={e =>
                  updateRoomData(clientId, {
                    unitCount: Math.max(1, parseInt(e.target.value, 10) || 1),
                  })
                }
              />
              <TextField
                label="Unit price (£)"
                size="small"
                type="number"
                slotProps={{ htmlInput: { min: 0, step: '0.01' } }}
                placeholder="0.00"
                value={data.unitPricePence ? (data.unitPricePence / 100).toFixed(2) : ''}
                onChange={e =>
                  updateRoomData(clientId, {
                    unitPricePence: Math.round(parseFloat(e.target.value) * 100) || 0,
                  })
                }
              />
            </Box>

            {/* Notes */}
            <TextField
              label="Room notes"
              size="small"
              fullWidth
              multiline
              rows={2}
              slotProps={{ htmlInput: { maxLength: 2000 } }}
              placeholder="Any additional notes for this room…"
              value={data.notes || ''}
              onChange={e => updateRoomData(clientId, { notes: e.target.value })}
              sx={{ mb: 1.5 }}
            />

            {/* Photo upload — hidden in demo mode (no writes allowed) */}
            {!demo && (
              <FileUploadField
                key={fileKeyById[clientId] ?? 0}
                label="Photos (optional)"
                accept="image/*"
                multiple
                uploadStatus={uploadStatus}
                progress={uploadProgress}
                resetDelay={1500}
                onStatusReset={() => setUploadStatusById(prev => ({ ...prev, [clientId]: 'idle' }))}
                onChange={files => handleFilesSelected(clientId, files)}
              />
            )}

            {/* Already-uploaded / existing photo thumbnails */}
            {data.images && data.images.length > 0 && (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
                {data.images.map((img, imgIdx) => (
                  <Box
                    key={imgIdx}
                    sx={{ position: 'relative', width: 64, height: 64, flexShrink: 0 }}
                  >
                    <Box
                      component="img"
                      src={img.viewUrl || img.storageKey || ''}
                      alt="Room photo"
                      onError={() => handleImageError(clientId, imgIdx)}
                      sx={{
                        width: 64,
                        height: 64,
                        objectFit: 'cover',
                        borderRadius: '6px',
                        border: '1px solid var(--neutral-200)',
                        display: 'block',
                      }}
                    />
                    <IconButton
                      size="small"
                      title="Remove photo"
                      onClick={() => removeImage(clientId, imgIdx)}
                      sx={{
                        position: 'absolute',
                        top: -6,
                        right: -6,
                        width: 18,
                        height: 18,
                        p: 0,
                        background: 'var(--neutral-700)',
                        color: 'common.white',
                        borderRadius: '50%',
                        '&:hover': {
                          background: 'error.main',
                        },
                      }}
                    >
                      <CloseIcon sx={{ fontSize: '0.65rem' }} />
                    </IconButton>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        );
      })}

      {/* Add room */}
      <Button
        fullWidth
        onClick={addRoom}
        sx={{
          border: '2px dashed var(--neutral-300)',
          borderRadius: '10px',
          py: '10px',
          background: 'transparent',
          fontSize: '.88rem',
          color: 'var(--neutral-500)',
          textTransform: 'none',
          mt: '4px',
          '&:hover': {
            borderColor: BRAND_COLORS.orchid,
            color: BRAND_COLORS.orchid,
            background: 'transparent',
          },
        }}
      >
        + Add room
      </Button>
    </Box>
  );
}

export default DesignVisitRoomsStep;
