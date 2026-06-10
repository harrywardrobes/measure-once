import type { Meta, StoryObj } from '@storybook/react';
import { UrgencyDot } from './UrgencyDot';

const meta: Meta<typeof UrgencyDot> = {
  title: 'Components/UrgencyDot',
  tags: ['autodocs'],
  component: UrgencyDot,
  parameters: { layout: 'centered' },
  argTypes: {
    urgency: {
      control: { type: 'select' },
      options: ['red', 'orange', null],
    },
  },
};
export default meta;

type Story = StoryObj<typeof UrgencyDot>;

export const Red: Story = {
  args: { urgency: 'red' },
};

export const Orange: Story = {
  args: { urgency: 'orange' },
};

export const Hidden: Story = {
  args: { urgency: null },
  name: 'Hidden (null)',
};
