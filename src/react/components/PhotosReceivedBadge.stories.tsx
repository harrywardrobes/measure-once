import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import { PhotosReceivedBadge } from './PhotosReceivedBadge';

const meta: Meta<typeof PhotosReceivedBadge> = {
  title: 'Components/PhotosReceivedBadge',
  component: PhotosReceivedBadge,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Small green pill that appears when a customer has submitted their upload form. ' +
          'Shown when `hs_lead_status === "AWAITING_PHOTOS"`. ' +
          'Clears automatically once the lead status advances past AWAITING_PHOTOS. ' +
          'Used on the Projects board card and the Customer Detail header.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof PhotosReceivedBadge>;

export const Shown: Story = {
  name: 'Shown (AWAITING_PHOTOS)',
  args: {
    leadStatus: 'AWAITING_PHOTOS',
  },
};

export const HiddenWrongStatus: Story = {
  name: 'Hidden — lead status not AWAITING_PHOTOS',
  args: {
    leadStatus: 'IN_PROGRESS',
  },
};

export const HiddenNoValues: Story = {
  name: 'Hidden — no lead status',
  args: {
    leadStatus: undefined,
  },
};

export const InContext: Story = {
  name: 'In context — shown next to a status pill',
  render: () => (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Chip
        component="span"
        label="Awaiting Photos"
        size="small"
        color="info"
        variant="outlined"
      />
      <PhotosReceivedBadge leadStatus="AWAITING_PHOTOS" />
    </Box>
  ),
};
