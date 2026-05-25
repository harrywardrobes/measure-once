import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import { Skeleton } from './Skeleton';

const DELAY_MS = 200;

/**
 * Suspense fallback for lazy-loaded page panels.
 *
 * Stays invisible for DELAY_MS so fast connections never see a flash.
 * After the delay a few grey bars appear that loosely match a content area.
 */
export function PageLoadingSkeleton() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setVisible(true), DELAY_MS);
    return () => clearTimeout(id);
  }, []);

  if (!visible) return null;

  return (
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Skeleton height={20} width="45%" />
      <Skeleton height={14} width="80%" />
      <Skeleton height={14} width="65%" />
      <Skeleton height={14} width="72%" />
    </Box>
  );
}
