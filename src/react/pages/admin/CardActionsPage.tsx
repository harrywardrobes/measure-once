import React from 'react';
import { Box, Button, Card, CardContent, Stack, Typography } from '@mui/material';

/**
 * Admin → Card actions tab (#tab-cardactions).
 *
 * Legacy `loadCardActionsAdmin()` / `renderCardActionsTable()` write into
 * `#card-actions-table-wrap`; `saveAllCardActionLabels()` reads the inputs
 * from that subtree. We render MUI chrome and preserve the mount div.
 */

function callGlobal(name: string, ...args: unknown[]): void {
  const fn = (window as unknown as Record<string, unknown>)[name];
  if (typeof fn === 'function') (fn as (...a: unknown[]) => unknown)(...args);
}

export function CardActionsPage() {
  return (
    <Stack spacing={2}>
      <Card variant="outlined">
        <CardContent>
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 2,
              mb: 2,
            }}
          >
            <Box>
              <Typography variant="h6">Card action labels</Typography>
              <Typography variant="body2" color="text.secondary">
                The bottom strip on Sales &amp; Survey cards. One row per (stage × lead status);
                rows mirror the order of the Lead Statuses table in Settings and refresh
                automatically when that table is reordered or renamed.
              </Typography>
            </Box>
            <Button
              variant="contained"
              onClick={() => callGlobal('saveAllCardActionLabels')}
              sx={{ flexShrink: 0 }}
            >
              Save
            </Button>
          </Box>

          <div id="card-actions-table-wrap">
            <p className="admin-msg admin-msg--muted">Loading…</p>
          </div>
        </CardContent>
      </Card>
    </Stack>
  );
}

export default CardActionsPage;
