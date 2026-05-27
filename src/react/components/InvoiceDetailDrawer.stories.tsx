import React, { useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { InvoiceDetailDrawer } from './InvoiceDetailDrawer';
import type { InvoiceDetail } from './InvoiceDetailDrawer';

const meta: Meta = {
  title: 'Features/CustomerDetail/InvoiceDetailDrawer',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Drawer panel that opens when the user clicks an invoice row in InvoicesSection. ' +
          'Shows line items, payment meta, a PDF download link, and — for admins — ' +
          'editable due date / email / memo fields plus a Send to customer button.',
      },
    },
  },
};
export default meta;

type Story = StoryObj;

const INVOICE_MAP: Record<string, InvoiceDetail> = {
  'inv-001': {
    id: 'inv-001',
    docNumber: '1042',
    customerName: 'Mitchell Interiors',
    email: 'sarah.mitchell@example.com',
    balance: 0,
    totalAmt: 4800,
    dueDate: '2026-04-15',
    txnDate: '2026-03-15',
    syncToken: '2',
    memo: null,
    lines: [
      {
        description: 'Kitchen fitted units — full project',
        qty: 1,
        unitPrice: 4800,
        amount: 4800,
        detailType: 'SalesItemLineDetail',
      },
    ],
  },
  'inv-002': {
    id: 'inv-002',
    docNumber: '1067',
    customerName: 'Mitchell Interiors',
    email: 'sarah.mitchell@example.com',
    balance: 2350,
    totalAmt: 2350,
    dueDate: '2027-05-22',
    txnDate: '2026-04-22',
    syncToken: '3',
    memo: 'Thank you for choosing Measure Once.',
    lines: [
      {
        description: 'Initial survey & design consultation',
        qty: 1,
        unitPrice: 350,
        amount: 350,
        detailType: 'SalesItemLineDetail',
      },
      {
        description: 'Living room fitted wardrobes — materials',
        qty: 4,
        unitPrice: 250,
        amount: 1000,
        detailType: 'SalesItemLineDetail',
      },
      {
        description: 'Installation (day rate)',
        qty: 2,
        unitPrice: 500,
        amount: 1000,
        detailType: 'SalesItemLineDetail',
      },
    ],
  },
  'inv-003': {
    id: 'inv-003',
    docNumber: '1091',
    customerName: 'Mitchell Interiors',
    email: 'sarah.mitchell@example.com',
    balance: 600,
    totalAmt: 1200,
    dueDate: '2027-06-10',
    txnDate: '2026-05-10',
    syncToken: '1',
    memo: null,
    lines: [
      {
        description: 'Bedroom wardrobe installation',
        qty: 1,
        unitPrice: 1200,
        amount: 1200,
        detailType: 'SalesItemLineDetail',
      },
    ],
  },
};

const ALL_IDS = ['inv-001', 'inv-002', 'inv-003'];

function mockFetch(invoiceMap: Record<string, InvoiceDetail>) {
  return (url: string): Promise<Response> => {
    if (typeof url === 'string') {
      const match = url.match(/\/api\/quickbooks\/invoice\/([^/]+)$/);
      if (match) {
        const inv = invoiceMap[match[1]] ?? Object.values(invoiceMap)[0];
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(inv),
        } as Response);
      }
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response);
  };
}

function stubWindowHelpers() {
  const w = window as { showBottomConfirm?: (msg: string, cb: () => void) => void };
  if (!w.showBottomConfirm) {
    w.showBottomConfirm = (_msg: string, cb: () => void) => cb();
  }
}

interface DrawerDemoProps {
  isAdmin: boolean;
  startId?: string;
}

function DrawerAlwaysOpen({ isAdmin, startId = 'inv-002' }: DrawerDemoProps) {
  const originalFetch = useRef(window.fetch);
  const [invId, setInvId] = useState<string | null>(startId);

  useEffect(() => {
    stubWindowHelpers();
    window.fetch = mockFetch(INVOICE_MAP) as typeof window.fetch;
    return () => {
      window.fetch = originalFetch.current;
    };
  }, []);

  return (
    <InvoiceDetailDrawer
      open={true}
      invId={invId}
      allIds={ALL_IDS}
      onClose={() => {}}
      onNavigate={(id) => setInvId(id)}
      isAdmin={isAdmin}
    />
  );
}

function DrawerInteractive({ isAdmin, startId = 'inv-002' }: DrawerDemoProps) {
  const originalFetch = useRef(window.fetch);
  const [open, setOpen] = useState(false);
  const [invId, setInvId] = useState<string | null>(null);

  useEffect(() => {
    stubWindowHelpers();
    window.fetch = mockFetch(INVOICE_MAP) as typeof window.fetch;
    return () => {
      window.fetch = originalFetch.current;
    };
  }, []);

  return (
    <Box sx={{ p: 3 }}>
      {!open && (
        <Button variant="contained" onClick={() => { setInvId(startId); setOpen(true); }}>
          Open invoice drawer
        </Button>
      )}
      <InvoiceDetailDrawer
        open={open}
        invId={invId}
        allIds={ALL_IDS}
        onClose={() => setOpen(false)}
        onNavigate={(id) => setInvId(id)}
        isAdmin={isAdmin}
      />
    </Box>
  );
}

export const AdminView: Story = {
  name: 'Admin view — full actions',
  render: () => <DrawerAlwaysOpen isAdmin />,
  parameters: {
    docs: {
      description: {
        story:
          'Admin user sees the full drawer: line-item table, editable due date / customer email / memo ' +
          'fields with dirty-state highlighting, a Save changes button, and the Send to customer action. ' +
          'Navigation arrows cycle through three distinct invoices (paid → open → partial). ' +
          'The drawer is open immediately — no click required.',
      },
    },
  },
};

export const MemberView: Story = {
  name: 'Member view — read-only',
  render: () => <DrawerAlwaysOpen isAdmin={false} />,
  parameters: {
    docs: {
      description: {
        story:
          'Non-admin (member) sees the invoice summary and line items but the "Edit invoice" section ' +
          'and the "Send to customer" button are hidden. Only the Download PDF link is available. ' +
          'The drawer is open immediately — no click required.',
      },
    },
  },
};

export const PaidInvoice: Story = {
  name: 'Paid invoice — balance £0',
  render: () => <DrawerAlwaysOpen isAdmin startId="inv-001" />,
  parameters: {
    docs: {
      description: {
        story:
          'Invoice where `balance` is 0 — the "Balance due" field renders £0.00 ' +
          'and `invoiceStatus` returns `"paid"`. No overdue-red highlighting on the due date. ' +
          'The drawer is open immediately — no click required.',
      },
    },
  },
};

export const Interactive: Story = {
  name: 'Interactive — trigger button',
  render: () => <DrawerInteractive isAdmin />,
  parameters: {
    docs: {
      description: {
        story:
          'Demonstrates the trigger-button flow: click "Open invoice drawer" to open the panel, ' +
          'then close it with the × button or backdrop click. Use this variant to test open/close ' +
          'animation and the entry interaction.',
      },
    },
  },
};
