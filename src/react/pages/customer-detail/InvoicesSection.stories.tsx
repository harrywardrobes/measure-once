import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import { InvoicesSection } from './InvoicesSection';
import type { Contact } from './types';
import type { QBInvoicesState } from '../../hooks/useQBInvoices';

const meta: Meta = {
  title: 'Features/CustomerDetail/InvoicesSection',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Invoice rail on the customer detail page. Shows a pulse-skeleton while QuickBooks data is loading, then the matched invoice list once loaded. Renders nothing when QB is known-disconnected.',
      },
    },
  },
};
export default meta;

type Story = StoryObj;

const mockContact: Contact = {
  id: 'contact-001',
  properties: {
    firstname: 'Sarah',
    lastname: 'Mitchell',
    email: 'sarah.mitchell@example.com',
    company: 'Mitchell Interiors',
  },
};

const loadingQB: QBInvoicesState = {
  connected: false,
  statusKnown: false,
  loading: true,
  loaded: false,
  loadError: false,
  error: null,
  errorCode: null,
  company: null,
  invoices: [],
};

const loadedQB: QBInvoicesState = {
  connected: true,
  statusKnown: true,
  loading: false,
  loaded: true,
  loadError: false,
  error: null,
  errorCode: null,
  company: 'Measure Once Ltd',
  invoices: [
    {
      id: 'inv-001',
      docNumber: '1042',
      txnDate: '2026-03-15',
      dueDate: '2026-04-15',
      totalAmt: 4800,
      balance: 0,
      email: 'sarah.mitchell@example.com',
      customerName: 'Mitchell Interiors',
    },
    {
      id: 'inv-002',
      docNumber: '1067',
      txnDate: '2026-04-22',
      dueDate: '2026-05-22',
      totalAmt: 2350,
      balance: 2350,
      email: 'sarah.mitchell@example.com',
      customerName: 'Mitchell Interiors',
    },
    {
      id: 'inv-003',
      docNumber: '1091',
      txnDate: '2026-05-10',
      dueDate: '2026-06-10',
      totalAmt: 1200,
      balance: 600,
      email: 'sarah.mitchell@example.com',
      customerName: 'Mitchell Interiors',
    },
  ],
};

const noInvoicesQB: QBInvoicesState = {
  connected: true,
  statusKnown: true,
  loading: false,
  loaded: true,
  loadError: false,
  error: null,
  errorCode: null,
  company: 'Measure Once Ltd',
  invoices: [],
};

const errorQB: QBInvoicesState = {
  connected: true,
  statusKnown: true,
  loading: false,
  loaded: false,
  loadError: true,
  error: 'QuickBooks token expired. Reconnect in Admin Settings.',
  errorCode: 'TOKEN_EXPIRED',
  company: null,
  invoices: [],
};

export const Loading: Story = {
  name: 'Loading skeleton',
  render: () => {
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'admin' };
    return (
      <Box sx={{ maxWidth: 480, p: 2 }}>
        <InvoicesSection contact={mockContact} qb={loadingQB} />
      </Box>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          'Pulse-skeleton shown while the QuickBooks status and invoice list are still loading (`loading: true` / `statusKnown: false`). Three shimmering rows represent the expected invoice list shape.',
      },
    },
  },
};

export const WithInvoices: Story = {
  name: 'Loaded — invoices matched',
  render: () => {
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'admin' };
    return (
      <Box sx={{ maxWidth: 480, p: 2 }}>
        <InvoicesSection contact={mockContact} qb={loadedQB} />
      </Box>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          'Fully loaded state with three sample invoices: one paid, one outstanding (future due date), and one partially paid. Clicking a row would open the detail drawer.',
      },
    },
  },
};

export const NoInvoices: Story = {
  name: 'Loaded — no invoices found',
  render: () => {
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'admin' };
    return (
      <Box sx={{ maxWidth: 480, p: 2 }}>
        <InvoicesSection contact={mockContact} qb={noInvoicesQB} />
      </Box>
    );
  },
  parameters: {
    docs: {
      description: {
        story: 'QB is connected and loaded but no invoices match this contact\'s email or company.',
      },
    },
  },
};

export const LoadError: Story = {
  name: 'Load error',
  render: () => {
    (window as { __moHeaderUser?: { privilege_level: string } }).__moHeaderUser = { privilege_level: 'admin' };
    return (
      <Box sx={{ maxWidth: 480, p: 2 }}>
        <InvoicesSection contact={mockContact} qb={errorQB} />
      </Box>
    );
  },
  parameters: {
    docs: {
      description: {
        story: 'Error state when the QB fetch fails (e.g. expired token). Shows the error message in danger colour.',
      },
    },
  },
};
