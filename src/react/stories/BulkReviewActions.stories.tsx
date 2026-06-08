import type { Meta, StoryObj } from '@storybook/react';
import { BulkReviewActions } from '../pages/customer-detail/CustomerInfoSubmissionsRail';
import type { PendingPhotoReviewEntry } from '../hooks/useOfflinePhotoReviewEntries';

function entry(over: Partial<PendingPhotoReviewEntry>): PendingPhotoReviewEntry {
  return {
    id: 0,
    status: 'failed',
    submissionId: 1001,
    contactId: '12345',
    outcome: 'not_suitable',
    createdAt: Date.parse('2026-06-08T10:30:00Z'),
    lastError: 'request failed (500)',
    ...over,
  };
}

const twoFailed: PendingPhotoReviewEntry[] = [
  entry({ id: 1, submissionId: 1001 }),
  entry({ id: 2, submissionId: 1002, outcome: 'rough_estimate_sent' }),
];

const meta: Meta<typeof BulkReviewActions> = {
  title: 'Customer Detail/BulkReviewActions',
  component: BulkReviewActions,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => {
      // Discard-all calls the global bottom-bar confirm; stub it so the story is
      // self-contained (mirrors BulkVisitActions / PendingReviewActions stories).
      const w = window as unknown as { showBottomConfirm?: (msg: string, cb: () => void) => void };
      if (!w.showBottomConfirm) w.showBottomConfirm = (_msg, cb) => cb();
      return <Story />;
    },
  ],
};
export default meta;

type Story = StoryObj<typeof BulkReviewActions>;

export const TwoFailed: Story = {
  name: 'Bulk Retry all / Discard all (2 failed)',
  args: { entries: twoFailed },
};

export const SingleFailedHidden: Story = {
  name: 'Hidden with only one failed entry',
  args: { entries: [entry({ id: 1 })] },
};
