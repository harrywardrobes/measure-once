import React from 'react';
import { Box, Typography } from '@mui/material';
import { usePageTitle } from '../../hooks/usePageTitle';
import { useConnectionCheck } from '../../context/ConnectionToastContext';

export function SurveyVisitPage() {
  usePageTitle('Survey Visit · Measure Once');
  useConnectionCheck();

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h6" gutterBottom>
        Survey Visit
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Survey visit catalogue configuration will appear here.
      </Typography>
    </Box>
  );
}
