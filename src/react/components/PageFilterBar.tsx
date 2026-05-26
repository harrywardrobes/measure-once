import React from 'react';
import Box from '@mui/material/Box';
import type { SxProps, Theme } from '@mui/material/styles';

export interface PageFilterBarProps {
  children: React.ReactNode;
  sx?: SxProps<Theme>;
}

/**
 * PageFilterBar — thin horizontal layout wrapper used around any combination
 * of filter controls (StageTabGroup, FilterChipRow, SortSelect, etc.).
 *
 * Provides consistent padding, horizontal overflow scrolling, and hidden
 * scrollbars. Pass `sx` to add custom padding, borders, or backgrounds for
 * the specific page context.
 */
export function PageFilterBar({ children, sx }: PageFilterBarProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'nowrap',
        gap: 1,
        overflowX: 'auto',
        scrollbarWidth: 'none',
        '&::-webkit-scrollbar': { display: 'none' },
        WebkitOverflowScrolling: 'touch',
        ...sx,
      }}
    >
      {children}
    </Box>
  );
}

export default PageFilterBar;
