import type { Meta, StoryObj } from '@storybook/react';
import { BulkVisitActions } from '../pages/customer-detail/DesignVisitsList';
import type { PendingVisitEntry } from '../hooks/useOfflineVisitEntries';

function entry(over: Partial<PendingVisitEntry>): PendingVisitEntry {
  return {
    id: 0,
    status: 'failed',
    isEdit: false,
    editVisitId: null,
    contactId: '12345',
    contactName: 'Jane Smith',
    visitDate: new Date('2026-06-08T10:30:00Z').toISOString(),
    createdAt: Date.parse('2026-06-08T10:30:00Z'),
    estimateTotalPence: 480000,
    lastError: 'request failed (500)',
    queuedBody: null,
    baseVersion: null,
    baseUpdatedAt: null,
    ...over,
  };
}

const twoFailed: PendingVisitEntry[] = [
  entry({ id: 1 }),
  entry({ id: 2, isEdit: true, editVisitId: 4321 }),
];

const meta: Meta<typeof BulkVisitActions> = {
  title: 'Customer Detail/BulkVisitActions',
  component: BulkVisitActions,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => {
      // Discard-all calls the global bottom-bar confirm; stub it so the story is
      // self-contained (mirrors PendingEditActions / PendingVisitCard stories).
      const w = window as unknown as { showBottomConfirm?: (msg: string, cb: () => void) => void };
      if (!w.showBottomConfirm) w.showBottomConfirm = (_msg, cb) => cb();
      return <Story />;
    },
  ],
};
export default meta;

type Story = StoryObj<typeof BulkVisitActions>;

export const TwoFailed: Story = {
  name: 'Bulk Retry all / Discard all (2 failed)',
  args: { entries: twoFailed },
};

export const SingleFailedHidden: Story = {
  name: 'Hidden with only one failed entry',
  args: { entries: [entry({ id: 1 })] },
};
