import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { STATUS_COLORS } from '../theme';
import { CatalogueDropdowns } from './CatalogueDropdowns';
import { RoomImageUploader, type RoomImage } from './RoomImageUploader';
import type { UploadStatus } from './FileUploadField';

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

export interface RoomEditorCardProps {
  data: RoomData;
  /** Zero-based position; used for the "Room N" heading and reorder buttons. */
  index: number;
  /** Total number of rooms (controls reorder/remove button enablement). */
  total: number;
  doorStyles: DoorStyleOption[];
  demo?: boolean;
  uploadStatus: UploadStatus;
  uploadProgress?: number;
  fileKey: number;
  onUpdate: (patch: Partial<RoomData>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onFilesSelected: (files: FileList | null) => void;
  onStatusReset: () => void;
  onImageError: (imgIdx: number) => void;
  onRemoveImage: (imgIdx: number) => void;
}

/**
 * Editable card for one room: name, door style, dimensions, unit
 * count/price, notes, and photos. Stateless — the parent owns the room list
 * and upload state. Shared so any visit type can collect per-room details
 * without duplicating this form.
 */
export function RoomEditorCard({
  data,
  index,
  total,
  doorStyles,
  demo,
  uploadStatus,
  uploadProgress,
  fileKey,
  onUpdate,
  onMove,
  onRemove,
  onFilesSelected,
  onStatusReset,
  onImageError,
  onRemoveImage,
}: RoomEditorCardProps) {
  return (
    <Box
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
          disabled={index === 0}
          onClick={() => onMove(-1)}
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
          disabled={index === total - 1}
          onClick={() => onMove(1)}
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
          Room {index + 1}
        </Typography>
        {total > 1 && (
          <Button
            size="small"
            onClick={onRemove}
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
        onChange={e => onUpdate({ roomName: e.target.value })}
        sx={{ mb: 1.5 }}
      />

      {/* Door style */}
      <CatalogueDropdowns
        dropdowns={[
          {
            label: 'Door style',
            value: data.doorStyleId,
            options: doorStyles,
            onChange: (v) => onUpdate({ doorStyleId: v }),
          },
        ]}
      />

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
            onUpdate({ widthMm: parseInt(e.target.value, 10) || null })
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
            onUpdate({ heightMm: parseInt(e.target.value, 10) || null })
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
            onUpdate({ depthMm: parseInt(e.target.value, 10) || null })
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
            onUpdate({
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
            onUpdate({
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
        onChange={e => onUpdate({ notes: e.target.value })}
        sx={{ mb: 1.5 }}
      />

      {/* Photos */}
      <RoomImageUploader
        images={data.images}
        uploadStatus={uploadStatus}
        uploadProgress={uploadProgress}
        fileKey={fileKey}
        demo={demo}
        onFilesSelected={onFilesSelected}
        onStatusReset={onStatusReset}
        onImageError={onImageError}
        onRemoveImage={onRemoveImage}
      />
    </Box>
  );
}

export default RoomEditorCard;
