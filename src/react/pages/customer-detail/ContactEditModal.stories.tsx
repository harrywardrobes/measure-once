import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { ContactEditModal } from './ContactEditModal';
import type { Contact } from './types';

const BASE_CONTACT: Contact = {
  id: '123456',
  properties: {
    firstname: 'Jane',
    lastname:  'Smith',
    email:     'jane@example.com',
    phone:     '',
    mobilephone: '',
    address: '14 Oak Street',
    city: 'London',
    zip: 'SW1A 1AA',
  },
};

const meta: Meta<typeof ContactEditModal> = {
  title: 'Customer Detail/ContactEditModal',
  component: ContactEditModal,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj<typeof ContactEditModal>;

function Wrapper({ contact }: { contact: Contact }) {
  const [open, setOpen] = useState(true);
  return (
    <Box>
      <Button variant="outlined" onClick={() => setOpen(true)}>Open modal</Button>
      <ContactEditModal
        contact={contact}
        open={open}
        onClose={() => setOpen(false)}
        onSaved={() => setOpen(false)}
      />
    </Box>
  );
}

export const DirectPhoneActive: Story = {
  name: 'Direct phone — shown in header',
  render: () => (
    <Wrapper contact={{
      ...BASE_CONTACT,
      properties: {
        ...BASE_CONTACT.properties,
        phone: '020 7946 0123',
        mobilephone: '07700 900456',
      },
    }} />
  ),
};

export const MobilePhoneActive: Story = {
  name: 'Mobile phone — shown in header (no direct phone)',
  render: () => (
    <Wrapper contact={{
      ...BASE_CONTACT,
      properties: {
        ...BASE_CONTACT.properties,
        phone: '',
        mobilephone: '07700 900456',
      },
    }} />
  ),
};

export const NoPhone: Story = {
  name: 'No phone — no indicator shown',
  render: () => (
    <Wrapper contact={{
      ...BASE_CONTACT,
      properties: {
        ...BASE_CONTACT.properties,
        phone: '',
        mobilephone: '',
      },
    }} />
  ),
};
