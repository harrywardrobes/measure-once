import React from 'react';
import { Paper, Box, Typography } from '@mui/material';

interface ComponentShowcaseProps {
  name: string;
  children: React.ReactNode;
}

/**
 * Wraps a demo component in a labelled Paper card for display in the Design
 * System gallery. The `<h3>` heading is what the design-system-skeletons test
 * uses to locate each entry (it walks up to the nearest `.MuiPaper-root` and
 * counts `.MuiSkeleton-root` descendants).
 */
export function ComponentShowcase({ name, children }: ComponentShowcaseProps) {
  return (
    <Paper variant="outlined" sx={{ mb: 3 }}>
      <Box sx={{ px: 2, pt: 2, pb: 1 }}>
        <Typography variant="h6" component="h3">{name}</Typography>
      </Box>
      <Box>
        {children}
      </Box>
    </Paper>
  );
}
