import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

const meta: Meta = {
  title: 'Layout/MUI Layout',
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

export const BoxStory: Story = {
  name: 'Box',
  render: () => (
    <Stack spacing={2}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>Box — the core layout primitive</Typography>
      <Typography variant="body2" color="text.secondary">
        Use Box with <code>sx</code> for one-off layout. Maps directly to MUI's theme tokens.
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Box sx={{ p: 2, bgcolor: 'primary.light', color: 'primary.dark', borderRadius: 1 }}>p=2 primary.light</Box>
        <Box sx={{ p: 2, bgcolor: 'background.default', border: 1, borderColor: 'divider', borderRadius: 1 }}>bg default</Box>
        <Box sx={{ p: 2, bgcolor: 'secondary.main', color: '#fff', borderRadius: 1 }}>secondary.main</Box>
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 1,
        }}
      >
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <Paper key={n} variant="outlined" sx={{ p: 1.5, textAlign: 'center' }}>
            <Typography variant="caption">Cell {n}</Typography>
          </Paper>
        ))}
      </Box>
    </Stack>
  ),
};

export const StackStory: Story = {
  name: 'Stack',
  render: () => (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>Stack — column (default)</Typography>
        <Stack spacing={1}>
          {['First item', 'Second item', 'Third item'].map((label) => (
            <Paper key={label} variant="outlined" sx={{ p: 1.5 }}>
              <Typography variant="body2">{label}</Typography>
            </Paper>
          ))}
        </Stack>
      </Box>

      <Box>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>Stack — row with divider</Typography>
        <Stack direction="row" spacing={2} divider={<Divider orientation="vertical" flexItem />} sx={{ alignItems: 'center' }}>
          <Typography variant="body2">Sales</Typography>
          <Typography variant="body2">Design Visit</Typography>
          <Typography variant="body2">Survey</Typography>
          <Typography variant="body2">Order</Typography>
        </Stack>
      </Box>

      <Box>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>Stack — responsive direction</Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          {['Column on xs', 'Row on sm+', 'Responsive'].map((label) => (
            <Paper key={label} variant="outlined" sx={{ p: 2, flex: 1 }}>
              <Typography variant="body2">{label}</Typography>
            </Paper>
          ))}
        </Stack>
      </Box>

      <Box>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>Stack — flexWrap with gap</Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {['Sales', 'Design Visit', 'Survey', 'Order', 'Workshop', 'Packing', 'Delivery', 'Installation'].map((label) => (
            <Paper key={label} variant="outlined" sx={{ p: 1 }}>
              <Typography variant="caption">{label}</Typography>
            </Paper>
          ))}
        </Box>
      </Box>
    </Stack>
  ),
};

export const ContainerStory: Story = {
  name: 'Container',
  render: () => (
    <Stack spacing={3}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>Container — max-width constraints</Typography>
      {(['xs', 'sm', 'md', 'lg'] as const).map((size) => (
        <Box key={size}>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', mb: 0.5, display: 'block' }}>
            maxWidth="{size}"
          </Typography>
          <Container maxWidth={size} disableGutters>
            <Paper variant="outlined" sx={{ p: 1.5, textAlign: 'center', bgcolor: 'background.default' }}>
              <Typography variant="body2" color="text.secondary">Container content · maxWidth "{size}"</Typography>
            </Paper>
          </Container>
        </Box>
      ))}
    </Stack>
  ),
};

export const DividerStory: Story = {
  name: 'Divider',
  render: () => (
    <Stack spacing={3} sx={{ maxWidth: 500 }}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>Divider — horizontal</Typography>
      <Stack spacing={1}>
        <Typography variant="body2">Section A content</Typography>
        <Divider />
        <Typography variant="body2">Section B content</Typography>
        <Divider />
        <Typography variant="body2">Section C content</Typography>
      </Stack>

      <Typography variant="h6" sx={{ fontWeight: 700 }}>Divider — with text</Typography>
      <Divider>OR</Divider>
      <Divider><Typography variant="caption" color="text.secondary">FILTERS</Typography></Divider>

      <Typography variant="h6" sx={{ fontWeight: 700 }}>Divider — vertical (in flex row)</Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, height: 32 }}>
        <Typography variant="body2">Option A</Typography>
        <Divider orientation="vertical" flexItem />
        <Typography variant="body2">Option B</Typography>
        <Divider orientation="vertical" flexItem />
        <Typography variant="body2">Option C</Typography>
      </Box>
    </Stack>
  ),
};
