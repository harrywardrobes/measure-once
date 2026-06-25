import type { Meta, StoryObj } from '@storybook/react';
import { BulkContactActions } from './BulkContactActions';
import type { ContactSyncState } from '../hooks/useOfflineContactEntries';

function makeMap(entries: Array<[string, ContactSyncState]>): Map<string, ContactSyncState> {
  return new Map(entries);
}

const twoFailedMap = makeMap([
  ['contact-001', { status: 'failed', failedIds: [10, 11] }],
  ['contact-002', { status: 'failed', failedIds: [12] }],
]);

const oneFailedMap = makeMap([
  ['contact-001', { status: 'failed', failedIds: [10] }],
]);

const emptyMap = makeMap([]);

const meta: Meta<typeof BulkContactActions> = {
  title: 'Customers/BulkContactActions',
  component: BulkContactActions,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => {
      // Discard-all calls the global bottom-bar confirm; stub it so the story is
      // self-contained (mirrors BulkVisitActions / PendingEditActions stories).
      const w = window as unknown as { showBottomConfirm?: (msg: string, cb: () => void) => void };
      if (!w.showBottomConfirm) w.showBottomConfirm = (_msg, cb) => cb();
      return <Story />;
    },
  ],
};
export default meta;

type Story = StoryObj<typeof BulkContactActions>;

export const TwoFailed: Story = {
  name: 'Bulk Retry all / Discard all (2 failed contacts)',
  args: { contactSyncMap: twoFailedMap },
};

export const ManyFailed: Story = {
  name: 'Bulk Retry all / Discard all (3 failed contacts)',
  args: {
    contactSyncMap: makeMap([
      ['contact-001', { status: 'failed', failedIds: [10, 11] }],
      ['contact-002', { status: 'failed', failedIds: [12] }],
      ['contact-003', { status: 'failed', failedIds: [13] }],
    ]),
  },
};

export const SingleFailedHidden: Story = {
  name: 'Hidden with only one failed contact',
  args: { contactSyncMap: oneFailedMap },
};

export const NoFailuresHidden: Story = {
  name: 'Hidden with no failures',
  args: { contactSyncMap: emptyMap },
};
