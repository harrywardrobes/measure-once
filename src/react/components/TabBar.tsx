import React from 'react';

/**
 * <TabBar/> — replaces the retired `UI.renderTabBar` helper.
 *
 * Renders a `.ui-tabbar` with `.ui-tabbar-btn` buttons and optional `.tab-badge`
 * spans, reusing the existing CSS in `public/app-styles.css`. Unlike the old
 * vanilla helper (which required a global function name to survive an
 * `innerHTML` round-trip), this component takes a normal `onSelect` callback.
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
