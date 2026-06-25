import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import { CheckBadgeIcon } from '../pages/customer-detail/CheckBadgeIcon';

const meta: Meta<typeof CheckBadgeIcon> = {
  title: 'Customer Detail/CheckBadgeIcon',
  component: CheckBadgeIcon,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof CheckBadgeIcon>;

export const Default: Story = {};

export const OnBadge: Story = {
  render: () => (
    <Box
      sx={{
        width: 20,
        height: 20,
        borderRadius: '50%',
        bgcolor: 'success.main',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <CheckBadgeIcon />
    </Box>
  ),
};

export const VariousColors: Story = {
  render: () => (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
      {['success.main', 'primary.main', 'secondary.main', 'warning.main', 'error.main'].map(
        (color) => (
          <Box
            key={color}
            sx={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              bgcolor: color,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CheckBadgeIcon />
          </Box>
        )
      )}
    </Box>
  ),
};
