import React, { useEffect, useState, useCallback } from 'react';
import { TabBar } from './TabBar';
import type { TabBarTab } from './TabBar';

// ── Group / tab mapping ────────────────────────────────────────────────────────

export type GroupId = 'people' | 'configuration' | 'developer';

export interface TabGroup {
  id: GroupId;
  label: string;
  /** Ordered list of legacy data-tab values that belong to this group. */
  tabIds: string[];
}

export const TAB_GROUPS: TabGroup[] = [
  {
    id: 'people',
    label: 'People',
    tabIds: ['team', 'permissions', 'requests', 'auditlog'],
  },
  {
    id: 'configuration',
    label: 'Configuration',
    tabIds: ['cardactions', 'actionhandlers', 'designvisit', 'workshop', 'emailtemplates'],
  },
  {
    id: 'developer',
    label: 'Developer',
    tabIds: ['settings', 'devenv', 'search', 'offline'],
  },
];

// ── Legacy DOM reading (mirrors AdminTabsBar) ─────────────────────────────────

export type LegacyTab = {
  id: string;
  label: string;
  count?: string;
  badge?: string;
  href?: string;
  hidden?: boolean;
};

export function readLegacyTabs(): LegacyTab[] {
  const tabsRoot = document.querySelector('.tabs');
  if (!tabsRoot) return [];
  const items: LegacyTab[] = [];
  tabsRoot.querySelectorAll<HTMLElement>('.tab-btn').forEach((el) => {
    const id = el.dataset.tab;
    const href = (el as HTMLAnchorElement).getAttribute('href') || undefined;
    if (!id && !href) return;
    const countEl = el.querySelector<HTMLElement>('.count-muted');
    const badgeEl = el.querySelector<HTMLElement>('.tab-badge');
    const labelText =
      Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent || '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+&amp;\s+/g, ' & ')
        .replace(/\s+/g, ' ')
        .trim() || (el.textContent || '').trim();
    items.push({
      id: id || `link:${href}`,
      label: labelText,
      count: countEl?.textContent?.trim() || undefined,
      badge: badgeEl?.textContent?.trim() || undefined,
      href,
      hidden: el.hidden,
    });
  });
  return items;
}

function readActiveTabId(): string | null {
  const active = document.querySelector<HTMLElement>('.tabs .tab-btn.active');
  return active?.dataset.tab || null;
}

// ── Helper: find which group a tab belongs to ─────────────────────────────────

function groupForTab(tabId: string | null): GroupId | null {
  if (!tabId) return null;
  const group = TAB_GROUPS.find((g) => g.tabIds.includes(tabId));
  return group?.id ?? null;
}

function firstVisibleTabInGroup(groupId: GroupId, tabs: LegacyTab[]): string | null {
  const group = TAB_GROUPS.find((g) => g.id === groupId);
  if (!group) return null;
  for (const tabId of group.tabIds) {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab && !tab.hidden) return tabId;
  }
  return null;
}

// ── Presentational inner component (usable in Storybook) ─────────────────────

export interface AdminGroupedTabsBarInnerProps {
  tabs: LegacyTab[];
  activeTabId: string | null;
  activeGroupId: GroupId | null;
  onGroupSelect: (groupId: GroupId) => void;
  onTabSelect: (tabId: string) => void;
}

export function AdminGroupedTabsBarInner({
  tabs,
  activeTabId,
  activeGroupId,
  onGroupSelect,
  onTabSelect,
}: AdminGroupedTabsBarInnerProps) {
  const tabMap = new Map(tabs.map((t) => [t.id, t]));

  // Build group-level TabBar entries; hide the Developer group if all its
  // sub-tabs are hidden (mirrors the legacy `hidden` attribute behaviour).
  const groupTabs: TabBarTab[] = TAB_GROUPS.flatMap((g) => {
    const allHidden = g.tabIds.every((tid) => tabMap.get(tid)?.hidden !== false);
    if (allHidden) return [];
    return [{ key: g.id, label: g.label }];
  });

  // Determine active group — default to first visible group if nothing saved.
  const resolvedGroupId: GroupId | null =
    activeGroupId && groupTabs.some((g) => g.key === activeGroupId)
      ? activeGroupId
      : (groupTabs[0]?.key as GroupId) ?? null;

  // Build sub-tab entries for the active group.
  const activeGroup = TAB_GROUPS.find((g) => g.id === resolvedGroupId);
  const subTabs: TabBarTab[] = (activeGroup?.tabIds ?? []).flatMap((tabId) => {
    const t = tabMap.get(tabId);
    if (!t || t.hidden) return [];

    // Label may include a count in parentheses (e.g. "Team (3)")
    const labelNode: React.ReactNode = t.count ? (
      <>
        {t.label} <span className="count-muted">{t.count}</span>
      </>
    ) : (
      t.label
    );

    return [{ key: tabId, label: labelNode, badge: t.badge || undefined }];
  });

  // Resolve active sub-tab — fall back to first visible sub-tab if the saved
  // tab doesn't belong to the currently selected group.
  const subTabKeys = new Set(subTabs.map((s) => s.key));
  const resolvedSubTabId: string | null =
    activeTabId && subTabKeys.has(activeTabId)
      ? activeTabId
      : (subTabs[0]?.key ?? null);

  if (!groupTabs.length) return null;

  return (
    <div className="admin-grouped-tabs">
      <TabBar
        tabs={groupTabs}
        activeKey={resolvedGroupId ?? undefined}
        onSelect={(key) => onGroupSelect(key as GroupId)}
        className="admin-grouped-tabs__groups"
      />
      {subTabs.length > 0 && (
        <TabBar
          tabs={subTabs}
          activeKey={resolvedSubTabId ?? undefined}
          onSelect={onTabSelect}
          className="admin-grouped-tabs__subtabs"
        />
      )}
    </div>
  );
}

// ── Full component with DOM observation ───────────────────────────────────────

export function AdminGroupedTabsBar() {
  const [tabs, setTabs] = useState<LegacyTab[]>(() => readLegacyTabs());
  const [activeTabId, setActiveTabId] = useState<string | null>(() => readActiveTabId());
  const [activeGroupId, setActiveGroupId] = useState<GroupId | null>(() => {
    try {
      const saved = localStorage.getItem('adminActiveGroup') as GroupId | null;
      if (saved && TAB_GROUPS.some((g) => g.id === saved)) return saved;
    } catch (_) {}
    return null;
  });

  useEffect(() => {
    const tabsRoot = document.querySelector('.tabs');
    if (!tabsRoot) return;

    // Hide legacy tab bar visually but keep it in the DOM so existing JS
    // (switchTab, tests, BroadcastChannel listeners) keeps working.
    (tabsRoot as HTMLElement).style.display = 'none';

    const refresh = () => {
      setTabs(readLegacyTabs());
      setActiveTabId(readActiveTabId());
    };
    refresh();

    const mo = new MutationObserver(refresh);
    mo.observe(tabsRoot, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['class', 'hidden'],
    });
    return () => mo.disconnect();
  }, []);

  const handleGroupSelect = useCallback(
    (groupId: GroupId) => {
      setActiveGroupId(groupId);
      try { localStorage.setItem('adminActiveGroup', groupId); } catch (_) {}

      // Auto-select the first visible sub-tab in the newly selected group.
      const firstTab = firstVisibleTabInGroup(groupId, tabs);
      if (firstTab) {
        activateLegacyTab(firstTab);
        setActiveTabId(firstTab);
      }
    },
    [tabs],
  );

  const handleTabSelect = useCallback((tabId: string) => {
    activateLegacyTab(tabId);
    setActiveTabId(tabId);
    // Keep group in sync in case an external caller changes the active tab
    // (e.g. the page restoring from localStorage on load).
    const gid = groupForTab(tabId);
    if (gid) {
      setActiveGroupId(gid);
      try { localStorage.setItem('adminActiveGroup', gid); } catch (_) {}
    }
  }, []);

  // Expose a global so external callers (Command Palette, etc.) can
  // programmatically switch to a group without touching React internals.
  // The wrapper validates the string is a known GroupId before delegating.
  useEffect(() => {
    window.adminSwitchGroup = (groupId: string) => {
      if (TAB_GROUPS.some((g) => g.id === groupId)) {
        handleGroupSelect(groupId as GroupId);
      }
    };
    return () => { delete window.adminSwitchGroup; };
  }, [handleGroupSelect]);

  // Alt+1…4 keyboard shortcuts — jump to the Nth visible group.
  // Ignored when focus is inside an interactive input element.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const n = parseInt(e.key, 10);
      if (isNaN(n) || n < 1 || n > 4) return;
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT' ||
          (active as HTMLElement).isContentEditable)
      ) return;
      // Build ordered list of visible groups (mirrors AdminGroupedTabsBarInner).
      const tabMap = new Map(tabs.map((t) => [t.id, t]));
      const visibleGroups = TAB_GROUPS.filter(
        (g) => !g.tabIds.every((tid) => tabMap.get(tid)?.hidden !== false),
      );
      const target = visibleGroups[n - 1];
      if (!target) return;
      e.preventDefault();
      handleGroupSelect(target.id);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [tabs, handleGroupSelect]);

  // Keep activeGroupId in sync whenever activeTabId changes.
  //
  // This covers two important cases that the explicit handlers don't catch:
  //   1. admin.html restores adminActiveTab via switchTab(savedTab) *after*
  //      React has already mounted — the MutationObserver updates activeTabId
  //      but nothing else would update activeGroupId.
  //   2. Any external switchTab() call (BroadcastChannel, tests, etc.) that
  //      crosses a group boundary.
  //
  // When the user clicks a group or sub-tab, handleGroupSelect/handleTabSelect
  // already set activeGroupId directly (fast path), so this effect is a no-op
  // in that case (same value, no re-render).
  useEffect(() => {
    if (!activeTabId) return;
    const gid = groupForTab(activeTabId);
    if (!gid) return;
    setActiveGroupId(gid);
    try { localStorage.setItem('adminActiveGroup', gid); } catch (_) {}
  }, [activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AdminGroupedTabsBarInner
      tabs={tabs}
      activeTabId={activeTabId}
      activeGroupId={activeGroupId}
      onGroupSelect={handleGroupSelect}
      onTabSelect={handleTabSelect}
    />
  );
}

// ── Legacy tab activation helper ──────────────────────────────────────────────

function activateLegacyTab(tabId: string) {
  const sw = (window as unknown as { switchTab?: (id: string) => void }).switchTab;
  if (typeof sw === 'function') sw(tabId);
  // Some tabs do lazy data-loading via inline onclick; click the legacy button
  // to preserve that side-effect.
  const legacyBtn = document.querySelector<HTMLElement>(
    `.tabs .tab-btn[data-tab="${tabId}"]`,
  );
  if (legacyBtn) legacyBtn.click();
}

export default AdminGroupedTabsBar;
