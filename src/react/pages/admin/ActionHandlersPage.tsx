import React from 'react';
import { Box, Card, CardContent, Stack, Typography } from '@mui/material';

/**
 * Admin → Action handlers tab (#tab-actionhandlers).
 *
 * Legacy `loadCardActionHandlersAdmin()` / `renderHandlersTable()` /
 * `refreshHandlerConflictsBanner()` write into
 * `#card-action-handlers-wrap` and `#card-action-handlers-conflict-banner`.
 * The test:card-action-handlers suite asserts those exact ids, plus
 * `.cah-backdrop`, `#cah-action-name`, `#cah-edit-err`, etc. inside modals
 * created by the same legacy JS. We render MUI chrome around the legacy
 * mount points.
 */

export function ActionHandlersPage() {
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
              <Typography variant="h6">Action handlers</Typography>
              <Typography variant="body2" color="text.secondary">
                Every action label from the Card actions table is listed here. Use{' '}
                <em>+ Add action</em> on a row to make that label clickable on Sales / Survey
                cards; the attached action's exact behaviour (which APIs are called, which
                calendars or emails are affected) is described inline once added.
              </Typography>
            </Box>
          </Box>

          <div
            id="card-action-handlers-conflict-banner"
            className="hidden adm-mb-12"
          />
          <div id="card-action-handlers-wrap">
            <p className="admin-msg admin-msg--muted">Loading…</p>
          </div>
        </CardContent>
      </Card>
    </Stack>
  );
}

export default ActionHandlersPage;
