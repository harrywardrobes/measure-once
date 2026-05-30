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

/**
 * ActiveIndicatorVisible — regression guard for the overflow-clip bug.
 *
 * The active tab uses `margin-bottom: -2px` so its bottom border overlaps the
 * container's `border-bottom`, visually replacing it with the plum accent.
 * That negative margin only escapes clipping because `.ui-tabbar` sets
 * `overflow-y: clip` (not `hidden`) together with `overflow-clip-margin: 2px`.
 *
 * Without those two properties the plum underline is silently invisible even
 * though every class is applied correctly.  This story renders the tab bar
 * inside a container with explicit bottom padding so the indicator is always
 * clearly visible — any regression that clips or removes it will be obvious at
 * a glance in the Storybook gallery or a Chromatic snapshot.
 */
export const ActiveIndicatorVisible: Story = {
  args: { tabs: TABS, activeKey: 'overview' },
  decorators: [
    (Story) => (
      // Extra bottom space makes the 2px plum border unmistakably visible.
      // If you ever see this story with no coloured underline on the active
      // tab, the overflow-clip-margin fix has been lost.
      <div style={{ paddingBottom: 24 }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        story:
          'Verifies that the plum bottom-border indicator on the active tab is visible. ' +
          'The indicator relies on `overflow-y: clip` + `overflow-clip-margin: 2px` in ' +
          '`.ui-tabbar`; without those properties the `margin-bottom: -2px` trick that ' +
          'overlaps the container border is silently clipped away.',
      },
    },
  },
};
