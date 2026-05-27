import type { Meta, StoryObj } from '@storybook/react';
import { EmptyState } from './EmptyState';

const meta: Meta<typeof EmptyState> = {
  title: 'Components/EmptyState',
  tags: ['autodocs'],
  component: EmptyState,
  parameters: { layout: 'padded' },
  argTypes: {
    message: { control: 'text' },
    compact: { control: 'boolean' },
  },
};
export default meta;

type Story = StoryObj<typeof EmptyState>;

export const Default: Story = {
  args: { message: 'No results found.' },
};

export const Compact: Story = {
  args: { message: 'Nothing here yet.', compact: true },
};

export const LongMessage: Story = {
  args: {
    message:
      'There are no contacts in this view. Try clearing your filters or adding a new contact to get started.',
  },
};
