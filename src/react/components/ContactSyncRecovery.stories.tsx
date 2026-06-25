import type { Meta, StoryObj } from '@storybook/react';
import { ContactSyncRecovery } from './ContactSyncRecovery';

const meta: Meta<typeof ContactSyncRecovery> = {
  title: 'Customers/ContactSyncRecovery',
  component: ContactSyncRecovery,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => {
      // Discard calls the global bottom-bar confirm; stub it so the story is
      // self-contained (mirrors PendingEditActions.stories).
      const w = window as unknown as { showBottomConfirm?: (msg: string, cb: () => void) => void };
      if (!w.showBottomConfirm) w.showBottomConfirm = (_msg, cb) => cb();
      return <Story />;
    },
  ],
};
export default meta;

type Story = StoryObj<typeof ContactSyncRecovery>;

export const FailedChange: Story = {
  name: 'Failed change (Retry / Discard)',
  args: { failedIds: [42] },
};

export const MultipleFailed: Story = {
  name: 'Multiple failed writes',
  args: { failedIds: [42, 43] },
};
