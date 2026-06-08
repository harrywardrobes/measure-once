import type { Meta, StoryObj } from '@storybook/react';
import { PendingReviewActions } from '../pages/customer-detail/CustomerInfoSubmissionsRail';
import type { PendingPhotoReviewEntry } from '../hooks/useOfflinePhotoReviewEntries';

const failedReview: PendingPhotoReviewEntry = {
  id: 9,
  status: 'failed',
  submissionId: 4321,
  contactId: '12345',
  outcome: 'not_suitable',
  createdAt: Date.parse('2026-06-08T10:30:00Z'),
  lastError: 'request failed (500)',
};

const meta: Meta<typeof PendingReviewActions> = {
  title: 'Customer Detail/PendingReviewActions',
  component: PendingReviewActions,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => {
      // The discard action calls the global bottom-bar confirm; stub it so the
      // story is self-contained (mirrors PendingEditActions.stories).
      const w = window as unknown as { showBottomConfirm?: (msg: string, cb: () => void) => void };
      if (!w.showBottomConfirm) w.showBottomConfirm = (_msg, cb) => cb();
      return <Story />;
    },
  ],
};
export default meta;

type Story = StoryObj<typeof PendingReviewActions>;

export const FailedReview: Story = {
  name: 'Failed photo review (Retry / Discard)',
  args: { entry: failedReview },
};
