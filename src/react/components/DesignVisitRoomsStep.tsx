import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { FileUploadField } from './FileUploadField';

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
}: DesignVisitRoomsStepProps) {
  const [rooms, setRooms] = useState<InternalRoom[]>(() => {
    const src = initialRooms.length ? initialRooms : [{}];
    return src.map(r => makeInternalRoom({ ...r, images: (r as RoomData).images ?? [] }));
  });

  // Keyed by stable clientId — safe across reorder/remove operations.
  const [uploadingById, setUploadingById] = useState<Record<string, boolean>>({});
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
    const anyUploading = Object.values(uploadingById).some(Boolean);
    onUploadingChangeRef.current?.(anyUploading);
  }, [uploadingById]);

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
    setUploadingById(prev => { const n = { ...prev }; delete n[clientId]; return n; });
    setFileKeyById(prev => { const n = { ...prev }; delete n[clientId]; return n; });
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
    if (!files || !files.length) return;
    setUploadingById(prev => ({ ...prev, [clientId]: true }));

    const uploaded: RoomImage[] = [];
    for (const file of Array.from(files)) {
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result as string);
          fr.onerror = () => reject(new Error('FileReader error'));
          fr.readAsDataURL(file);
        });
        const resp = await fetch('/api/design-visits/uploads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.storageKey) throw new Error(data.error || 'Upload failed');
        uploaded.push({
          storageKey: data.storageKey,
          mimeType: data.mimeType || file.type,
          viewUrl: data.viewUrl || '',
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.warn('[design-visit] photo upload failed:', msg);
        const w = window as { toast?: (m: string) => void };
        if (typeof w.toast === 'function') {
          w.toast('Photo upload failed: ' + msg);
        }
      }
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

    // Bump key to reset the FileUploadField (clears selected-file display).
    setFileKeyById(prev => ({ ...prev, [clientId]: (prev[clientId] ?? 0) + 1 }));
    setUploadingById(prev => ({ ...prev, [clientId]: false }));
  }

  return (
    <Box>
      {rooms.map((room, idx) => {
        const { clientId, data } = room;
        const uploading = uploadingById[clientId] ?? false;

        return (
          <Box
            key={clientId}
            sx={{
              border: '1.5px solid #e5e7eb',
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
                  border: '1.5px solid #d1d5db',
                  borderRadius: '7px',
                  p: '3px',
                  color: '#6b7280',
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
                  border: '1.5px solid #d1d5db',
                  borderRadius: '7px',
                  p: '3px',
                  color: '#6b7280',
                  '&:disabled': { opacity: 0.35 },
                }}
              >
                <KeyboardArrowDownIcon sx={{ fontSize: '0.9rem' }} />
              </IconButton>
              <Typography
                sx={{ fontWeight: 700, fontSize: '.9rem', color: '#374151', flex: 1 }}
              >
                Room {idx + 1}
              </Typography>
              {rooms.length > 1 && (
                <Button
                  size="small"
                  onClick={() => removeRoom(clientId)}
                  sx={{
                    border: '1.5px solid #d1d5db',
                    borderRadius: '7px',
                    px: '10px',
                    py: '4px',
                    background: '#fff',
                    fontSize: '.8rem',
                    color: '#374151',
                    textTransform: 'none',
                    minWidth: 0,
                    '&:hover': {
                      background: '#fef2f2',
                      borderColor: '#fca5a5',
                      color: '#dc2626',
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
                  <Box component="span" sx={{ color: '#991b1b' }}>
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
                    <Box component="span" sx={{ color: '#991b1b' }}>
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

            {/* Photo upload — disabled while an upload is in progress for this room */}
            <FileUploadField
              key={fileKeyById[clientId] ?? 0}
              label="Photos (optional)"
              accept="image/*"
              multiple
              disabled={uploading}
              onChange={files => handleFilesSelected(clientId, files)}
            />
            {uploading && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
                <CircularProgress size={14} />
                <Typography variant="caption" color="text.secondary">
                  Uploading photos…
                </Typography>
              </Box>
            )}

            {/* Already-uploaded / existing photo thumbnails */}
            {data.images && data.images.length > 0 && (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
                {data.images.map((img, imgIdx) => (
                  <Box
                    key={imgIdx}
                    component="img"
                    src={img.viewUrl || img.storageKey || ''}
                    alt="Room photo"
                    sx={{
                      width: 64,
                      height: 64,
                      objectFit: 'cover',
                      borderRadius: '6px',
                      border: '1px solid #e5e7eb',
                    }}
                  />
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
          border: '2px dashed #d1d5db',
          borderRadius: '10px',
          py: '10px',
          background: 'transparent',
          fontSize: '.88rem',
          color: '#6b7280',
          textTransform: 'none',
          mt: '4px',
          '&:hover': {
            borderColor: '#8B2BFF',
            color: '#8B2BFF',
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
