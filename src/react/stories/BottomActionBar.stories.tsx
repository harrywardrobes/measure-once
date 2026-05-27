import React, { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { BottomActionBar } from '../components/BottomActionBar';

const meta: Meta = {
  title: 'Navigation/BottomActionBar',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Fixed bottom bar exposed via `window.showBottomUndo`, `window.showBottomConfirm`, and `window.showUnsavedChangesBar`. Mount it once globally; trigger via the window API from anywhere.',
      },
    },
  },
};
export default meta;

type Story = StoryObj;

function BottomBarHost({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{ minHeight: 200, p: 3, position: 'relative' }}>
      {children}
      <BottomActionBar />
    </Box>
  );
}

export const UndoMode: Story = {
  name: 'Undo bar',
  render: () => {
    function Show() {
      useEffect(() => {
        setTimeout(() => {
          window.showBottomUndo('Stage changed to Survey', () => {
            console.log('[story] undo triggered');
          });
        }, 200);
      }, []);
      return (
        <Stack spacing={2}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>Undo bar</Typography>
          <Typography variant="body2" color="text.secondary">
            Appears automatically. Auto-dismisses after 5 seconds.
          </Typography>
          <Button variant="outlined" onClick={() => window.showBottomUndo('Stage changed to Survey', () => console.log('[story] undo'))}>
            Show undo bar again
          </Button>
        </Stack>
      );
    }
    return <BottomBarHost><Show /></BottomBarHost>;
  },
};

export const ConfirmMode: Story = {
  name: 'Confirm bar',
  render: () => {
    function Show() {
      useEffect(() => {
        setTimeout(() => {
          window.showBottomConfirm('Delete this customer record?', () => {
            console.log('[story] confirmed');
            window.closeBottomBar();
          });
        }, 200);
      }, []);
      return (
        <Stack spacing={2}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>Confirm bar</Typography>
          <Typography variant="body2" color="text.secondary">
            Shows Cancel + Confirm buttons. Does not auto-dismiss.
          </Typography>
          <Button variant="outlined" onClick={() => window.showBottomConfirm('Delete this customer record?', () => { console.log('[story] confirmed'); window.closeBottomBar(); })}>
            Show confirm bar again
          </Button>
        </Stack>
      );
    }
    return <BottomBarHost><Show /></BottomBarHost>;
  },
};

export const UnsavedMode: Story = {
  name: 'Unsaved changes bar',
  render: () => {
    function Show() {
      useEffect(() => {
        setTimeout(() => {
          window.showUnsavedChangesBar(
            () => { console.log('[story] save'); window.closeBottomBar(); },
            () => { console.log('[story] discard'); window.closeBottomBar(); },
          );
        }, 200);
      }, []);
      return (
        <Stack spacing={2}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>Unsaved changes bar</Typography>
          <Typography variant="body2" color="text.secondary">
            Shows Discard + Save &amp; leave buttons.
          </Typography>
          <Button
            variant="outlined"
            onClick={() => window.showUnsavedChangesBar(
              () => { console.log('[story] save'); window.closeBottomBar(); },
              () => { console.log('[story] discard'); window.closeBottomBar(); },
            )}
          >
            Show unsaved bar again
          </Button>
        </Stack>
      );
    }
    return <BottomBarHost><Show /></BottomBarHost>;
  },
};
