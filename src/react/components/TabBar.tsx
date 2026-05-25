import React from 'react';

/**
 * <TabBar/> — React equivalent of `UI.renderTabBar` in `public/components.js`.
 *
 * Renders the same `.ui-tabbar` markup with `.ui-tabbar-btn` buttons and the
 * `.tab-badge` badge span so it reuses the existing CSS in `public/style.css`.
 * When the legacy helper is finally retired, this component is the drop-in
 * replacement. Unlike the vanilla helper (which takes a global function name
 * so it can survive an `innerHTML` round-trip), the React version takes a
 * normal `onSelect` callback.
 */
export interface TabBarTab {
  key: string;
  label: React.ReactNode;
  badge?: React.ReactNode;
}

export interface TabBarProps {
  tabs: TabBarTab[];
  activeKey?: string;
  onSelect?: (key: string) => void;
  className?: string;
}

export function TabBar({ tabs, activeKey, onSelect, className }: TabBarProps) {
  if (!Array.isArray(tabs)) return null;
  const cls = ['ui-tabbar', className].filter(Boolean).join(' ');
  return (
    <div className={cls} role="tablist">
      {tabs.map((t) => {
        const isActive = t.key === activeKey;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            className={`ui-tabbar-btn${isActive ? ' is-active' : ''}`}
            data-tab-key={t.key}
            aria-selected={isActive}
            onClick={onSelect ? () => onSelect(t.key) : undefined}
          >
            {t.label}
            {t.badge != null && t.badge !== '' ? (
              <>
                {' '}
                <span className="tab-badge">{t.badge}</span>
              </>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export default TabBar;
