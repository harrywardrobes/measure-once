import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
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
          'Shown when `hs_lead_status === "AWAITING_PHOTOS"` **and** `hw_lead_substatus` contains `"AWPH_RECEIVED"`. ' +
          'Clears automatically once the lead status advances past AWAITING_PHOTOS. ' +
          'Used on the Projects board card and the Customer Detail header.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof PhotosReceivedBadge>;

export const Shown: Story = {
  name: 'Shown (AWAITING_PHOTOS + AWPH_RECEIVED)',
  args: {
    leadStatus: 'AWAITING_PHOTOS',
    hwSubstatus: 'AWPH_RECEIVED',
  },
};

export const HiddenWrongStatus: Story = {
  name: 'Hidden — lead status not AWAITING_PHOTOS',
  args: {
    leadStatus: 'IN_PROGRESS',
    hwSubstatus: 'AWPH_RECEIVED',
  },
};

export const HiddenMissingSubstatus: Story = {
  name: 'Hidden — substatus does not include AWPH_RECEIVED',
  args: {
    leadStatus: 'AWAITING_PHOTOS',
    hwSubstatus: 'SOME_OTHER_SUB',
  },
};

export const HiddenNoValues: Story = {
  name: 'Hidden — no lead status or substatus',
  args: {
    leadStatus: undefined,
    hwSubstatus: undefined,
  },
};

export const InContext: Story = {
  name: 'In context — shown next to a status pill',
  render: () => (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Box
        component="span"
        sx={{
          fontSize: '0.7rem',
          fontWeight: 700,
          px: '8px',
          py: '2px',
          borderRadius: '999px',
          background: '#e0f2fe',
          color: '#0369a1',
          border: '1px solid #bae6fd',
        }}
      >
        Awaiting Photos
      </Box>
      <PhotosReceivedBadge leadStatus="AWAITING_PHOTOS" hwSubstatus="AWPH_RECEIVED" />
    </Box>
  ),
};
