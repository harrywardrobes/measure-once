import React, { useEffect, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Box from '@mui/material/Box';
import Badge from '@mui/material/Badge';
import Chip from '@mui/material/Chip';

type LegacyTab = {
  id: string;
  label: string;
  count?: string;
  badge?: string;
  href?: string;
  hidden?: boolean;
};

function readLegacyTabs(): LegacyTab[] {
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

export function AdminTabsBar() {
  const [tabs, setTabs] = useState<LegacyTab[]>(() => readLegacyTabs());
  const [active, setActive] = useState<string | null>(() => readActiveTabId());

  useEffect(() => {
    const tabsRoot = document.querySelector('.tabs');
    if (!tabsRoot) return;

    // Hide legacy tab bar visually but keep it in the DOM so existing JS
    // (switchTab, tests, BroadcastChannel listeners) keeps working.
    (tabsRoot as HTMLElement).style.display = 'none';

    const refresh = () => {
      setTabs(readLegacyTabs());
      setActive(readActiveTabId());
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

  if (!tabs.length) return null;

  const handleChange = (_e: React.SyntheticEvent, value: string) => {
    if (value.startsWith('link:')) {
      window.location.href = value.slice('link:'.length);
      return;
    }
    const sw = (window as unknown as { switchTab?: (id: string) => void }).switchTab;
    if (typeof sw === 'function') sw(value);
    // Some tabs do lazy data-loading via inline onclick; click the legacy
    // button to preserve that side-effect, then update React state.
    const legacyBtn = document.querySelector<HTMLElement>(
      `.tabs .tab-btn[data-tab="${value}"]`,
    );
    if (legacyBtn) legacyBtn.click();
    setActive(value);
  };

  const visible = tabs.filter((t) => !t.hidden);
  const currentValue = active && visible.find((t) => t.id === active) ? active : visible[0]?.id;

  return (
    <AppBar
      position="static"
      color="default"
      elevation={0}
      sx={{
        backgroundColor: 'background.paper',
        borderBottom: 1,
        borderColor: 'divider',
        mb: 2,
      }}
    >
      <Toolbar disableGutters sx={{ minHeight: 48, px: 1 }}>
        <Tabs
          value={currentValue || false}
          onChange={handleChange}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          sx={{ minHeight: 48 }}
        >
          {visible.map((t) => (
            <Tab
              key={t.id}
              value={t.id}
              sx={{ minHeight: 48, textTransform: 'none', fontWeight: 600 }}
              label={
                <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                  <span>{t.label}</span>
                  {t.count ? (
                    <Chip
                      size="small"
                      label={t.count}
                      sx={{ height: 18, fontSize: 11 }}
                    />
                  ) : null}
                  {t.badge ? (
                    <Badge
                      color="error"
                      badgeContent={t.badge}
                      sx={{ '& .MuiBadge-badge': { position: 'static', transform: 'none' } }}
                    />
                  ) : null}
                </Box>
              }
            />
          ))}
        </Tabs>
      </Toolbar>
    </AppBar>
  );
}

export default AdminTabsBar;
