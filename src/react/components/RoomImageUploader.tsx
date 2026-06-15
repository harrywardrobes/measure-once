import React from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import { FileUploadField, UploadStatus } from './FileUploadField';

export interface RoomImage {
  storageKey: string;
  mimeType: string | null;
  viewUrl: string;
}

export interface RoomImageUploaderProps {
  images: RoomImage[];
  uploadStatus: UploadStatus;
  uploadProgress?: number;
  /** Bumped by the parent to reset the FileUploadField after each upload batch. */
  fileKey: number;
  /**
   * When true the upload control is hidden (read-only demo mode): no writes
   * are allowed. Existing thumbnails are still shown.
   */
  demo?: boolean;
  onFilesSelected: (files: FileList | null) => void;
  onStatusReset: () => void;
  onImageError: (imgIdx: number) => void;
  onRemoveImage: (imgIdx: number) => void;
}

/**
 * Photo upload + thumbnail grid for a single room. Stateless — the parent owns
 * the image list and upload status. Shared so any visit type can collect room
 * photos without duplicating the upload/thumbnail UI.
 */
export function RoomImageUploader({
  images,
  uploadStatus,
  uploadProgress,
  fileKey,
  demo,
  onFilesSelected,
  onStatusReset,
  onImageError,
  onRemoveImage,
}: RoomImageUploaderProps) {
  return (
    <>
      {/* Photo upload — hidden in demo mode (no writes allowed) */}
      {!demo && (
        <FileUploadField
          key={fileKey}
          label="Photos (optional)"
          accept="image/*"
          multiple
          uploadStatus={uploadStatus}
          progress={uploadProgress}
          resetDelay={1500}
          onStatusReset={onStatusReset}
          onChange={onFilesSelected}
        />
      )}

      {/* Already-uploaded / existing photo thumbnails */}
      {images && images.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
          {images.map((img, imgIdx) => (
            <Box
              key={imgIdx}
              sx={{ position: 'relative', width: 64, height: 64, flexShrink: 0 }}
            >
              <Box
                component="img"
                src={img.viewUrl || img.storageKey || ''}
                alt="Room photo"
                onError={() => onImageError(imgIdx)}
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
                onClick={() => onRemoveImage(imgIdx)}
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
    </>
  );
}

export default RoomImageUploader;
