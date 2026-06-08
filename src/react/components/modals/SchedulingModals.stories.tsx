import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { DeliveryWindowModal } from './DeliveryWindowModal';
import { InstallationSlotModal } from './InstallationSlotModal';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';

const meta: Meta = {
  title: 'Components/Modals/Scheduling',
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

const mockCtx: CardActionContext = {
  contactId: 'contact-123',
  contactName: 'Jane Smith',
  contactEmail: 'jane@example.com',
};

const emptyCtx: CardActionContext = {
  contactId: '',
  contactName: '',
  contactEmail: '',
};

const deliveryHandler: CardActionHandlerData = {
  id: 1,
  type: 'schedule_delivery_window',
  config: {},
  bindings: [],
};

const installationHandler: CardActionHandlerData = {
  id: 2,
  type: 'schedule_installation_slot',
  config: { defaultDurationMin: 240 },
  bindings: [],
};

function DeliveryWindowDemo({ ctx, handler }: { ctx: CardActionContext; handler: CardActionHandlerData }) {
  const [open, setOpen] = useState(false);
  return (
    <Box>
      <Button variant="contained" onClick={() => setOpen(true)}>
        Open delivery window modal
      </Button>
      <DeliveryWindowModal
        handler={handler}
        ctx={ctx}
        open={open}
        onClose={() => setOpen(false)}
      />
    </Box>
  );
}

function InstallationSlotDemo({ ctx, handler }: { ctx: CardActionContext; handler: CardActionHandlerData }) {
  const [open, setOpen] = useState(false);
  return (
    <Box>
      <Button variant="contained" onClick={() => setOpen(true)}>
        Open installation slot modal
      </Button>
      <InstallationSlotModal
        handler={handler}
        ctx={ctx}
        open={open}
        onClose={() => setOpen(false)}
      />
    </Box>
  );
}

export const DeliveryWindow: Story = {
  name: 'DeliveryWindowModal — with customer',
  render: () => <DeliveryWindowDemo ctx={mockCtx} handler={deliveryHandler} />,
};

export const DeliveryWindowNoCustomer: Story = {
  name: 'DeliveryWindowModal — no customer',
  render: () => <DeliveryWindowDemo ctx={emptyCtx} handler={deliveryHandler} />,
};

export const InstallationSlot: Story = {
  name: 'InstallationSlotModal — with customer',
  render: () => <InstallationSlotDemo ctx={mockCtx} handler={installationHandler} />,
};

export const InstallationSlotNoCustomer: Story = {
  name: 'InstallationSlotModal — no customer',
  render: () => <InstallationSlotDemo ctx={emptyCtx} handler={installationHandler} />,
};

export const BothSideBySide: Story = {
  name: 'Both modals side by side',
  render: () => (
    <Stack direction="row" spacing={3}>
      <Box>
        <Typography variant="subtitle2" gutterBottom>Delivery window (DateTimeRangePicker)</Typography>
        <DeliveryWindowDemo ctx={mockCtx} handler={deliveryHandler} />
      </Box>
      <Box>
        <Typography variant="subtitle2" gutterBottom>Installation slot (DateTimePicker + duration)</Typography>
        <InstallationSlotDemo ctx={mockCtx} handler={installationHandler} />
      </Box>
    </Stack>
  ),
};
