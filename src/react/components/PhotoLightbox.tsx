import React, { useCallback, useEffect } from 'react';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/material/Box';
import CloseIcon from '@mui/icons-material/Close';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';
import ArrowForwardIosIcon from '@mui/icons-material/ArrowForwardIos';

export interface LightboxPhoto {
  src: string;
  alt: string;
  /** Optional room name shown in the lightbox caption when navigating multi-room visits. */
  roomLabel?: string;
}

export interface PhotoLightboxProps {
  open: boolean;
  photos: LightboxPhoto[];
  initialIndex?: number;
  onClose: () => void;
}

/**
 * Full-screen photo lightbox. Opens over the page with a dark backdrop and
 * shows a single photo at a time. Keyboard arrow keys navigate between photos;
 * Escape closes via MUI Dialog's built-in handler.
 */
export function PhotoLightbox({ open, photos, initialIndex = 0, onClose }: PhotoLightboxProps) {
  const [index, setIndex] = React.useState(initialIndex);

  React.useEffect(() => {
    if (open) setIndex(initialIndex);
  }, [open, initialIndex]);

  const hasPrev = index > 0;
  const hasNext = index < photos.length - 1;

  const goNext = useCallback(() => {
    if (hasNext) setIndex(i => i + 1);
  }, [hasNext]);

  const goPrev = useCallback(() => {
    if (hasPrev) setIndex(i => i - 1);
  }, [hasPrev]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') goNext();
      if (e.key === 'ArrowLeft') goPrev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, goNext, goPrev]);

  const current = photos[index];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen
      aria-label={current ? `Photo viewer: ${current.alt}` : 'Photo viewer'}
      slotProps={{
        paper: {
          sx: {
            bgcolor: 'rgba(0,0,0,0.92)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
          },
        },
        backdrop: {
          sx: { bgcolor: 'rgba(0,0,0,0.92)' },
        },
      }}
    >
      {/* Close button */}
      <IconButton
        onClick={onClose}
        aria-label="Close photo viewer"
        size="large"
        sx={{
          position: 'absolute',
          top: 12,
          right: 12,
          color: '#fff',
          bgcolor: 'rgba(0,0,0,0.4)',
          '&:hover': { bgcolor: 'rgba(0,0,0,0.65)' },
          zIndex: 10,
        }}
      >
        <CloseIcon />
      </IconButton>

      {/* Photo counter / room label */}
      {(photos.length > 1 || current?.roomLabel) && (() => {
        const roomLabel = current?.roomLabel;
        let counter: React.ReactNode = null;
        if (roomLabel) {
          const roomTotal = photos.filter(p => p.roomLabel === roomLabel).length;
          const roomPos = photos.slice(0, index + 1).filter(p => p.roomLabel === roomLabel).length;
          counter = (
            <>
              {roomLabel}
              <Box component="span" sx={{ ml: 0.75, opacity: 0.7 }}>
                — {roomPos} / {roomTotal}
              </Box>
            </>
          );
        } else {
          counter = `${index + 1} / ${photos.length}`;
        }
        return (
          <Box
            sx={{
              position: 'absolute',
              top: 16,
              left: '50%',
              transform: 'translateX(-50%)',
              color: '#fff',
              fontSize: '0.8rem',
              fontWeight: 500,
              bgcolor: 'rgba(0,0,0,0.4)',
              borderRadius: 2,
              px: 1.5,
              py: 0.5,
              userSelect: 'none',
              zIndex: 10,
              textAlign: 'center',
              whiteSpace: 'nowrap',
            }}
          >
            {counter}
          </Box>
        );
      })()}

      {/* Prev button */}
      {hasPrev && (
        <IconButton
          onClick={goPrev}
          aria-label="Previous photo"
          size="large"
          sx={{
            position: 'absolute',
            left: 12,
            color: '#fff',
            bgcolor: 'rgba(0,0,0,0.4)',
            '&:hover': { bgcolor: 'rgba(0,0,0,0.65)' },
            zIndex: 10,
          }}
        >
          <ArrowBackIosNewIcon />
        </IconButton>
      )}

      {/* Image */}
      {current && (
        <Box
          component="img"
          src={current.src}
          alt={current.alt}
          sx={{
            maxWidth: '90vw',
            maxHeight: '88vh',
            objectFit: 'contain',
            borderRadius: 1,
            boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
            display: 'block',
            userSelect: 'none',
          }}
        />
      )}

      {/* Next button */}
      {hasNext && (
        <IconButton
          onClick={goNext}
          aria-label="Next photo"
          size="large"
          sx={{
            position: 'absolute',
            right: 12,
            color: '#fff',
            bgcolor: 'rgba(0,0,0,0.4)',
            '&:hover': { bgcolor: 'rgba(0,0,0,0.65)' },
            zIndex: 10,
          }}
        >
          <ArrowForwardIosIcon />
        </IconButton>
      )}
    </Dialog>
  );
}
