import type { Meta, StoryObj } from '@storybook/react';
import { PendingEditActions } from '../pages/customer-detail/DesignVisitsList';
import type { PendingVisitEntry } from '../hooks/useOfflineVisitEntries';

const failedEdit: PendingVisitEntry = {
  id: 7,
  status: 'failed',
  isEdit: true,
  editVisitId: 4321,
  contactId: '12345',
  contactName: 'Jane Smith',
  visitDate: new Date('2026-06-08T10:30:00Z').toISOString(),
  createdAt: Date.parse('2026-06-08T10:30:00Z'),
  estimateTotalPence: 480000,
  lastError: 'request failed (500)',
  queuedBody: null,
  baseVersion: null,
  baseUpdatedAt: null,
};

const meta: Meta<typeof PendingEditActions> = {
  title: 'Customer Detail/PendingEditActions',
  component: PendingEditActions,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => {
      // The discard action calls the global bottom-bar confirm; stub it so the
      // story is self-contained (mirrors PendingVisitCard.stories).
      const w = window as unknown as { showBottomConfirm?: (msg: string, cb: () => void) => void };
      if (!w.showBottomConfirm) w.showBottomConfirm = (_msg, cb) => cb();
      return <Story />;
    },
  ],
};
export default meta;

type Story = StoryObj<typeof PendingEditActions>;

export const FailedEdit: Story = {
  name: 'Failed edit (Retry / Discard)',
  args: { entry: failedEdit },
};
