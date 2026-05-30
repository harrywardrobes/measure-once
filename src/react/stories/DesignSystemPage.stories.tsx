import type { Meta, StoryObj } from '@storybook/react';
import { DesignSystemPage } from '../pages/admin/DesignSystemPage';

const meta: Meta<typeof DesignSystemPage> = {
  title: 'Admin/DesignSystemPage',
  tags: ['autodocs'],
  component: DesignSystemPage,
  parameters: { layout: 'fullscreen' },
};
export default meta;

type Story = StoryObj<typeof DesignSystemPage>;

export const SkeletonsTab: Story = {
  name: 'Skeletons tab — all 14 entries',
};
