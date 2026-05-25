import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppThemeProvider } from './AppThemeProvider';
import { DesignSystemPage } from './pages/DesignSystemPage';
import { SearchSettingsPage } from './pages/SearchSettingsPage';
import { WorkshopSettingsPage } from './pages/WorkshopSettingsPage';
import { CustomersPage } from './pages/CustomersPage';
import { AdminTabsBar } from './components/AdminTabsBar';
import { AdminTeamPage } from './pages/admin/AdminTeamPage';
import { AdminPermissionsPage } from './pages/admin/AdminPermissionsPage';
import { AdminRequestsPage } from './pages/admin/AdminRequestsPage';
import { AdminAuditLogPage } from './pages/admin/AdminAuditLogPage';

/**
 * Every React mount goes through `AppThemeProvider` so the shared MUI
 * theme + `ScopedCssBaseline` apply everywhere. New mount points only
 * need to add an entry to `MOUNTS` below — the wrapper is automatic.
 */
function withTheme(node: React.ReactElement): React.ReactElement {
  return <AppThemeProvider>{node}</AppThemeProvider>;
}

/**
 * Entry point for the React island that co-exists with the legacy static
 * `public/` pages. Built by Vite into `public/react/main.js` with a stable
 * filename so admin.html can `<script>` it directly without a manifest.
 *
 * Mount strategy: we look for known mount points and render each that
 * exists. Today the admin Design System tab (`#tab-designsystem`) and the
 * admin Search settings tab (`#tab-search`) are on React; future ports add
 * their own `#tab-…` ids to the MOUNTS table below.
 *
 * The vite-dev playground (`src/react/index.html`) provides a `#root`
 * element so `npm run dev:react` still gives a standalone preview.
 */
const MOUNTS: Array<{ id: string; render: () => React.ReactElement }> = [
  { id: 'admin-mui-tabs-mount', render: () => <AdminTabsBar /> },
  { id: 'tab-designsystem',     render: () => <DesignSystemPage /> },
  { id: 'tab-search',           render: () => <SearchSettingsPage /> },
  { id: 'tab-workshop',         render: () => <WorkshopSettingsPage /> },
  { id: 'tab-customers',        render: () => <CustomersPage /> },
  { id: 'tab-team',             render: () => <AdminTeamPage /> },
  { id: 'tab-permissions',      render: () => <AdminPermissionsPage /> },
  { id: 'tab-requests',         render: () => <AdminRequestsPage /> },
  { id: 'tab-auditlog',         render: () => <AdminAuditLogPage /> },
];

function mountKnown(): number {
  let count = 0;
  for (const m of MOUNTS) {
    const el = document.getElementById(m.id);
    if (!el) continue;
    if (el.dataset.dsRendered === '1') { count++; continue; }
    el.dataset.dsRendered = '1';
    createRoot(el).render(withTheme(m.render()));
    count++;
  }
  return count;
}

function mount() {
  const mountedAny = mountKnown() > 0;
  if (mountedAny) return;

  // Vite dev-only standalone playground.
  const root = document.getElementById('root');
  if (root) {
    createRoot(root).render(withTheme(<DesignSystemPage />));
    return;
  }

  // No mount points exist yet — admin.html renders #tab-search /
  // #tab-designsystem / #tab-workshop into #page asynchronously after its
  // data fetches resolve, then calls window.__reactIslandMount()
  // synchronously right after setting #page.innerHTML so the React panels
  // render in the same tick. Nothing else to do here.
}

(window as unknown as { __reactIslandMount?: () => void }).__reactIslandMount = () => {
  mountKnown();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
