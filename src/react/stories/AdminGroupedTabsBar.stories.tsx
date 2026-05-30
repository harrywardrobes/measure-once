import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  AdminGroupedTabsBarInner,
  TAB_GROUPS,
} from '../components/AdminGroupedTabsBar';
import type { LegacyTab, GroupId } from '../components/AdminGroupedTabsBar';

const meta: Meta<typeof AdminGroupedTabsBarInner> = {
  title: 'Admin/AdminGroupedTabsBar',
  tags: ['autodocs'],
  component: AdminGroupedTabsBarInner,
  parameters: { layout: 'fullscreen' },
};
export default meta;

type Story = StoryObj<typeof AdminGroupedTabsBarInner>;

const ALL_TABS: LegacyTab[] = [
  { id: 'team',           label: 'Team',                hidden: false },
  { id: 'permissions',    label: 'Permissions & roles', hidden: false },
  { id: 'requests',       label: 'Pending Requests',    hidden: false },
  { id: 'auditlog',       label: 'Audit Log',           hidden: false },
  { id: 'cardactions',    label: 'Card Actions',        hidden: false },
  { id: 'actionhandlers', label: 'Action Handlers',     hidden: false },
  { id: 'designvisit',    label: 'Design Visit',        hidden: false },
  { id: 'search',         label: 'Search',              hidden: false },
  { id: 'workshop',       label: 'Workshop',            hidden: false },
  { id: 'settings',       label: 'Settings',            hidden: false },
  { id: 'devenv',         label: 'Dev Environment',     hidden: false },
];

const TABS_DEV_HIDDEN: LegacyTab[] = ALL_TABS.map((t) =>
  t.id === 'devenv' ? { ...t, hidden: true } : t,
);

const TABS_WITH_BADGES: LegacyTab[] = ALL_TABS.map((t) => {
  if (t.id === 'team')     return { ...t, count: '12' };
  if (t.id === 'requests') return { ...t, badge: '3' };
  return t;
});

// ── Interactive wrapper ───────────────────────────────────────────────────────

function Interactive({
  tabs,
  initialGroup,
  initialTab,
}: {
  tabs: LegacyTab[];
  initialGroup: GroupId;
  initialTab: string;
}) {
  const [activeGroupId, setActiveGroupId] = useState<GroupId>(initialGroup);
  const [activeTabId, setActiveTabId]     = useState<string>(initialTab);

  const handleGroupSelect = (groupId: GroupId) => {
    setActiveGroupId(groupId);
    const group = TAB_GROUPS.find((g) => g.id === groupId);
    if (group) {
      const first = group.tabIds.find(
        (tid) => !tabs.find((t) => t.id === tid)?.hidden,
      );
      if (first) setActiveTabId(first);
    }
  };

  return (
    <AdminGroupedTabsBarInner
      tabs={tabs}
      activeGroupId={activeGroupId}
      activeTabId={activeTabId}
      onGroupSelect={handleGroupSelect}
      onTabSelect={(tid) => setActiveTabId(tid)}
    />
  );
}

// ── Stories ───────────────────────────────────────────────────────────────────

export const PeopleGroupActive: Story = {
  name: 'Default — People group active',
  render: () => (
    <Interactive tabs={ALL_TABS} initialGroup="people" initialTab="team" />
  ),
};

export const ConfigurationGroupActive: Story = {
  name: 'Configuration group active',
  render: () => (
    <Interactive
      tabs={ALL_TABS}
      initialGroup="configuration"
      initialTab="cardactions"
    />
  ),
};

export const WithBadges: Story = {
  name: 'People group — sub-tabs with badges',
  render: () => (
    <Interactive
      tabs={TABS_WITH_BADGES}
      initialGroup="people"
      initialTab="team"
    />
  ),
};

export const DeveloperGroupHidden: Story = {
  name: 'Developer group hidden (devenv tab hidden)',
  render: () => (
    <Interactive
      tabs={TABS_DEV_HIDDEN}
      initialGroup="people"
      initialTab="team"
    />
  ),
};

export const IntegrationsGroupActive: Story = {
  name: 'Integrations group active',
  render: () => (
    <Interactive
      tabs={ALL_TABS}
      initialGroup="integrations"
      initialTab="settings"
    />
  ),
};
