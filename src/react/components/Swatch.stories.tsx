import type { Meta, StoryObj } from '@storybook/react';
import { Swatch } from './Swatch';

const meta: Meta<typeof Swatch> = {
  title: 'Components/Swatch',
  component: Swatch,
  tags: ['autodocs'],
};
export default meta;

type Story = StoryObj<typeof Swatch>;

export const Default: Story = {
  args: { name: '--paper', value: '#F6F1E7' },
};

export const Loading: Story = {
  args: { name: '--paper', loading: true },
};

export const Empty: Story = {
  args: { name: '--missing-token', value: '' },
};
