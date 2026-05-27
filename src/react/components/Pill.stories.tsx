import type { Meta, StoryObj } from '@storybook/react';
import { Pill } from './Pill';

const meta: Meta<typeof Pill> = {
  title: 'Components/Pill',
  component: Pill,
  parameters: { layout: 'centered' },
  argTypes: {
    variant: {
      control: { type: 'select' },
      options: ['neutral', 'success', 'danger', 'warn', 'info'],
    },
    label: { control: 'text' },
  },
};
export default meta;

type Story = StoryObj<typeof Pill>;

export const Neutral: Story = { args: { label: 'Neutral', variant: 'neutral' } };
export const Success: Story = { args: { label: 'Active', variant: 'success' } };
export const Danger:  Story = { args: { label: 'Blocked', variant: 'danger' } };
export const Warn:    Story = { args: { label: 'Pending', variant: 'warn' } };
export const Info:    Story = { args: { label: 'New', variant: 'info' } };

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Pill label="neutral" />
      <Pill label="success" variant="success" />
      <Pill label="danger" variant="danger" />
      <Pill label="warn" variant="warn" />
      <Pill label="info" variant="info" />
    </div>
  ),
};
