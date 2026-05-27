import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { TabBar } from './TabBar';

const meta: Meta<typeof TabBar> = {
  title: 'Components/TabBar',
  tags: ['autodocs'],
  component: TabBar,
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj<typeof TabBar>;

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'tasks', label: 'Tasks', badge: 3 },
  { key: 'notes', label: 'Notes' },
];

export const Default: Story = {
  args: { tabs: TABS, activeKey: 'overview' },
};

export const ActiveSecondTab: Story = {
  args: { tabs: TABS, activeKey: 'tasks' },
};

export const WithBadges: Story = {
  args: {
    tabs: [
      { key: 'inbox', label: 'Inbox', badge: 12 },
      { key: 'sent', label: 'Sent' },
      { key: 'drafts', label: 'Drafts', badge: 'new' },
    ],
    activeKey: 'inbox',
  },
};

export const Interactive: Story = {
  render: () => {
    const [active, setActive] = useState('overview');
    return <TabBar tabs={TABS} activeKey={active} onSelect={setActive} />;
  },
};
