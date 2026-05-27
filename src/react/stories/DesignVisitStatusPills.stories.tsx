import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { DESIGN_VISIT_STATUS_LABELS } from '../pages/customer-detail/types';
import { DesignVisitStatusPill } from '../pages/customer-detail/DesignVisitStatusPill';

const meta: Meta = {
  title: 'Components/DesignVisit Status Pills',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'All four design-visit status pills rendered side by side. ' +
          'Each pill reads its colours directly from `DESIGN_VISIT_STATUS_LABELS` in `types.ts`, ' +
          'so this story stays in sync automatically when tokens change.',
      },
    },
  },
};
export default meta;

type Story = StoryObj;

export const AllStates: Story = {
  name: 'All four states',
  render: () => (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Typography variant="body2" color="text.secondary">
        All four design visit status values from{' '}
        <code>DESIGN_VISIT_STATUS_LABELS</code>, rendered with their design
        tokens.
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        {Object.keys(DESIGN_VISIT_STATUS_LABELS).map((key) => (
          <Box
            key={key}
            sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.75 }}
          >
            <DesignVisitStatusPill status={key} />
            <Typography
              variant="caption"
              sx={{ color: 'text.disabled', fontFamily: 'monospace', fontSize: 10 }}
            >
              {key}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  ),
};

export const Draft: Story = {
  name: 'Draft',
  render: () => <DesignVisitStatusPill status="draft" />,
};

export const Submitted: Story = {
  name: 'Submitted',
  render: () => <DesignVisitStatusPill status="submitted" />,
};

export const SignedOff: Story = {
  name: 'Signed off',
  render: () => <DesignVisitStatusPill status="signed_off" />,
};

export const RevisionRequested: Story = {
  name: 'Revision requested',
  render: () => <DesignVisitStatusPill status="revision_requested" />,
};
