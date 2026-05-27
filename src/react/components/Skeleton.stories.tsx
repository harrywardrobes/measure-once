import type { Meta, StoryObj } from '@storybook/react';
import { Skeleton } from './Skeleton';

const meta: Meta<typeof Skeleton> = {
  title: 'Components/Skeleton',
  tags: ['autodocs'],
  component: Skeleton,
  parameters: { layout: 'padded' },
  argTypes: {
    width: { control: 'text' },
    height: { control: 'text' },
  },
};
export default meta;

type Story = StoryObj<typeof Skeleton>;

export const Default: Story = { args: {} };

export const FixedWidth: Story = { args: { width: 200, height: 12 } };

export const Tall: Story = { args: { width: '50%', height: 24 } };

export const LoadingBlock: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 320 }}>
      <Skeleton width="60%" height={14} />
      <Skeleton width="90%" />
      <Skeleton width="80%" />
      <Skeleton width="40%" />
    </div>
  ),
};
