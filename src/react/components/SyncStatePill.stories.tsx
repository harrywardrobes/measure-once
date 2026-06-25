import type { Meta, StoryObj } from '@storybook/react';
import { SyncStatePill } from './SyncStatePill';

const meta: Meta<typeof SyncStatePill> = {
  title: 'Offline/SyncStatePill',
  component: SyncStatePill,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  args: { status: 'pending' },
  argTypes: {
    status: {
      control: 'select',
      options: ['pending', 'syncing', 'failed', 'synced'],
    },
  },
};
export default meta;

type Story = StoryObj<typeof SyncStatePill>;

export const PendingSync: Story = { args: { status: 'pending' } };
export const Syncing: Story = { args: { status: 'syncing' } };
export const SyncFailed: Story = { args: { status: 'failed' } };
export const Synced: Story = { args: { status: 'synced' } };
