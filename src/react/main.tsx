import React, { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { AppThemeProvider } from './AppThemeProvider';
import { IslandErrorBoundary } from './components/IslandErrorBoundary';
import {
  PageLoadingSkeleton,
  CustomersPageSkeleton,
  CalendarPageSkeleton,
  HomePageSkeleton,
  ProfilePageSkeleton,
  AdminTeamPageSkeleton,
} from './components/PageLoadingSkeleton';

/*
 * Shell components that are always present on every page are imported
 * statically — they're small and needed immediately on mount.
 */
import { GlobalHeader } from './components/GlobalHeader';
import { PageHeadingPanel } from './components/PageHeadingPanel';
import { BottomNav } from './components/BottomNav';
import { AdminTabsBar } from './components/AdminTabsBar';

/*
 * Page-level components are lazy-imported so Vite emits a separate chunk
 * for each one. The browser only downloads a chunk when its mount point
 * (`#tab-…` / `#*-view`) is actually present in the DOM, which means each
 * page loads only the code it needs.
 *
 * New pages: add a React.lazy() entry here and a matching row in MOUNTS.
 */
const DesignSystemPage   = React.lazy(() => import('./pages/DesignSystemPage').then(m => ({ default: m.DesignSystemPage })));
const SearchSettingsPage = React.lazy(() => import('./pages/SearchSettingsPage').then(m => ({ default: m.SearchSettingsPage })));
const WorkshopSettingsPage = React.lazy(() => import('./pages/WorkshopSettingsPage').then(m => ({ default: m.WorkshopSettingsPage })));
const CustomersPage      = React.lazy(() => import('./pages/CustomersPage').then(m => ({ default: m.CustomersPage })));
const HomePage           = React.lazy(() => import('./pages/HomePage').then(m => ({ default: m.HomePage })));
const CalendarPage       = React.lazy(() => import('./pages/CalendarPage').then(m => ({ default: m.CalendarPage })));
const ProfilePage        = React.lazy(() => import('./pages/ProfilePage').then(m => ({ default: m.ProfilePage })));
const SettingsPage       = React.lazy(() => import('./pages/admin/SettingsPage').then(m => ({ default: m.SettingsPage })));
const CardActionsPage    = React.lazy(() => import('./pages/admin/CardActionsPage').then(m => ({ default: m.CardActionsPage })));
const ActionHandlersPage = React.lazy(() => import('./pages/admin/ActionHandlersPage').then(m => ({ default: m.ActionHandlersPage })));
const DesignVisitPage    = React.lazy(() => import('./pages/admin/DesignVisitPage').then(m => ({ default: m.DesignVisitPage })));
const DevEnvironmentPage = React.lazy(() => import('./pages/admin/DevEnvironmentPage').then(m => ({ default: m.DevEnvironmentPage })));
const AdminTeamPage      = React.lazy(() => import('./pages/admin/AdminTeamPage').then(m => ({ default: m.AdminTeamPage })));
const AdminPermissionsPage = React.lazy(() => import('./pages/admin/AdminPermissionsPage').then(m => ({ default: m.AdminPermissionsPage })));
const AdminRequestsPage  = React.lazy(() => import('./pages/admin/AdminRequestsPage').then(m => ({ default: m.AdminRequestsPage })));
const AdminAuditLogPage  = React.lazy(() => import('./pages/admin/AdminAuditLogPage').then(m => ({ default: m.AdminAuditLogPage })));

/**
 * Every React mount goes through `AppThemeProvider` so the shared MUI
 * theme + `ScopedCssBaseline` apply everywhere. New mount points only
 * need to add an entry to `MOUNTS` below — the wrapper is automatic.
 *
 * Lazy page components are wrapped in `Suspense` (fallback: nothing) so
 * the rest of the page is never blocked while a chunk downloads.
 */
function withTheme(
  node: React.ReactElement,
  islandId: string,
  fallback: React.ReactElement = <PageLoadingSkeleton />,
): React.ReactElement {
  return (
    <AppThemeProvider>
      <IslandErrorBoundary islandId={islandId}>
        <Suspense fallback={fallback}>{node}</Suspense>
      </IslandErrorBoundary>
    </AppThemeProvider>
  );
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
const MOUNTS: Array<{ id: string; render: () => React.ReactElement; fallback?: React.ReactElement }> = [
  { id: 'app-header-mount',     render: () => <GlobalHeader /> },
  { id: 'page-heading-mount',   render: () => <PageHeadingPanel /> },
  { id: 'app-bottom-nav-mount', render: () => <BottomNav /> },
  { id: 'home-view',            render: () => <HomePage />,     fallback: <HomePageSkeleton /> },
  { id: 'tab-calendar',         render: () => <CalendarPage />, fallback: <CalendarPageSkeleton /> },
  { id: 'profile-view',         render: () => <ProfilePage />,  fallback: <ProfilePageSkeleton /> },
  { id: 'admin-mui-tabs-mount', render: () => <AdminTabsBar /> },
  { id: 'tab-designsystem',     render: () => <DesignSystemPage /> },
  { id: 'tab-search',           render: () => <SearchSettingsPage /> },
  { id: 'tab-workshop',         render: () => <WorkshopSettingsPage /> },
  { id: 'tab-customers',        render: () => <CustomersPage />, fallback: <CustomersPageSkeleton /> },
  { id: 'tab-team',             render: () => <AdminTeamPage />, fallback: <AdminTeamPageSkeleton /> },
  { id: 'tab-permissions',      render: () => <AdminPermissionsPage /> },
  { id: 'tab-requests',         render: () => <AdminRequestsPage /> },
  { id: 'tab-auditlog',         render: () => <AdminAuditLogPage /> },
  { id: 'tab-settings',         render: () => <SettingsPage /> },
  { id: 'tab-cardactions',      render: () => <CardActionsPage /> },
  { id: 'tab-actionhandlers',   render: () => <ActionHandlersPage /> },
  { id: 'tab-designvisit',      render: () => <DesignVisitPage /> },
  { id: 'tab-devenv',           render: () => <DevEnvironmentPage /> },
];

function mountKnown(): number {
  let count = 0;
  for (const m of MOUNTS) {
    const el = document.getElementById(m.id);
    if (!el) continue;
    // Tab panels that are not currently active should not be mounted yet —
    // their chunk will be fetched only when the user first opens that tab
    // (switchTab in admin.html calls __reactIslandMount after activating
    // the panel, which comes back here and mounts it then).
    if (el.classList.contains('tab-panel') && !el.classList.contains('active')) {
      continue;
    }
    if (el.dataset.dsRendered === '1') { count++; continue; }
    el.dataset.dsRendered = '1';
    try {
      createRoot(el).render(withTheme(m.render(), m.id, m.fallback));
    } catch (err) {
      // Synchronous throw during initial render() — extremely rare, but if
      // it happens we want a visible message rather than a blank panel.
      // eslint-disable-next-line no-console
      console.error(`[react-island] "${m.id}" failed to mount:`, err);
      el.textContent = 'This panel failed to load — see the browser console.';
    }
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
    createRoot(root).render(withTheme(<DesignSystemPage />, 'root'));
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
