import type { Meta, StoryObj } from '@storybook/react';
import { PendingVisitCard } from '../pages/customer-detail/DesignVisitsList';
import type { PendingVisitEntry } from '../hooks/useOfflineVisitEntries';

const baseEntry: PendingVisitEntry = {
  id: 1,
  status: 'pending',
  isEdit: false,
  editVisitId: null,
  contactId: '12345',
  contactName: 'Jane Smith',
  visitDate: new Date('2026-06-08T10:30:00Z').toISOString(),
  createdAt: Date.parse('2026-06-08T10:30:00Z'),
  estimateTotalPence: 480000,
  queuedBody: null,
  baseVersion: null,
  baseUpdatedAt: null,
};

const meta: Meta<typeof PendingVisitCard> = {
  title: 'Customer Detail/PendingVisitCard',
  component: PendingVisitCard,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => {
      // The discard action calls the global bottom-bar confirm; stub it so the
      // story is self-contained (mirrors InvoiceDetailDrawer.stories).
      const w = window as unknown as { showBottomConfirm?: (msg: string, cb: () => void) => void };
      if (!w.showBottomConfirm) w.showBottomConfirm = (_msg, cb) => cb();
      return <Story />;
    },
  ],
};
export default meta;

type Story = StoryObj<typeof PendingVisitCard>;

export const Pending: Story = {
  name: 'Pending sync',
  args: { entry: baseEntry },
};

export const Syncing: Story = {
  args: { entry: { ...baseEntry, status: 'syncing' } },
};

export const Failed: Story = {
  name: 'Sync failed (Retry / Discard)',
  args: {
    entry: {
      ...baseEntry,
      status: 'failed',
      lastError: 'request failed (500)',
    },
  },
};
