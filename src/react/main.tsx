import React, { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { AppThemeProvider } from './AppThemeProvider';
import { IslandErrorBoundary } from './components/IslandErrorBoundary';
import {
  DesignVisitRoomsStep,
  type DesignVisitRoomsStepProps,
} from './components/DesignVisitRoomsStep';
import {
  PageLoadingSkeleton,
  CustomersPageSkeleton,
  CalendarPageSkeleton,
  HomePageSkeleton,
  ProfilePageSkeleton,
  SalesBoardPageSkeleton,
  AdminTeamPageSkeleton,
  AdminPermissionsPageSkeleton,
  AdminRequestsPageSkeleton,
  AdminAuditLogPageSkeleton,
  AdminSettingsPageSkeleton,
  CardActionsPageSkeleton,
  ActionHandlersPageSkeleton,
} from './components/PageLoadingSkeleton';

/*
 * Shell components that are always present on every page are imported
 * statically — they're small and needed immediately on mount.
 */
import { GlobalHeader } from './components/GlobalHeader';
import { PageHeadingPanel } from './components/PageHeadingPanel';
import { BottomNav } from './components/BottomNav';
import { AdminTabsBar } from './components/AdminTabsBar';
import { BottomActionBar } from './components/BottomActionBar';

/*
 * Page-level components are lazy-imported so Vite emits a separate chunk
 * for each one. The browser only downloads a chunk when its mount point
 * (`#tab-…` / `#*-view`) is actually present in the DOM, which means each
 * page loads only the code it needs.
 *
 * New pages: add a React.lazy() entry here and a matching row in MOUNTS.
 */
const LoginPage          = React.lazy(() => import('./pages/auth/LoginPage').then(m => ({ default: m.LoginPage })));
const SetPasswordPage    = React.lazy(() => import('./pages/auth/SetPasswordPage').then(m => ({ default: m.SetPasswordPage })));
const OnboardingPage     = React.lazy(() => import('./pages/auth/OnboardingPage').then(m => ({ default: m.OnboardingPage })));
const TradesPage         = React.lazy(() => import('./pages/TradesPage').then(m => ({ default: m.TradesPage })));
const DesignSystemPage   = React.lazy(() => import('./pages/DesignSystemPage').then(m => ({ default: m.DesignSystemPage })));
const SearchSettingsPage = React.lazy(() => import('./pages/SearchSettingsPage').then(m => ({ default: m.SearchSettingsPage })));
const WorkshopSettingsPage = React.lazy(() => import('./pages/WorkshopSettingsPage').then(m => ({ default: m.WorkshopSettingsPage })));
const CustomersPage      = React.lazy(() => import('./pages/CustomersPage').then(m => ({ default: m.CustomersPage })));
const SalesBoardPage     = React.lazy(() => import('./pages/SalesBoardPage').then(m => ({ default: m.SalesBoardPage })));
const SurveyBoardPage    = React.lazy(() => import('./pages/SurveyBoardPage').then(m => ({ default: m.SurveyBoardPage })));
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
const IdeasPage              = React.lazy(() => import('./pages/IdeasPage').then(m => ({ default: m.IdeasPage })));
const CustomerDetailPage     = React.lazy(() => import('./pages/CustomerDetailPage').then(m => ({ default: m.CustomerDetailPage })));
const StandaloneInvoicesPage = React.lazy(() => import('./pages/StandaloneInvoicesPage').then(m => ({ default: m.StandaloneInvoicesPage })));
const ProjectsPage           = React.lazy(() => import('./pages/ProjectsPage').then(m => ({ default: m.ProjectsPage })));
const DatabaseAdminPage          = React.lazy(() => import('./pages/admin/DatabaseAdminPage').then(m => ({ default: m.DatabaseAdminPage })));
const DesignVisitSignOffPage     = React.lazy(() => import('./pages/DesignVisitSignOffPage').then(m => ({ default: m.DesignVisitSignOffPage })));
const NotFoundPage               = React.lazy(() => import('./pages/NotFoundPage').then(m => ({ default: m.NotFoundPage })));
const AccessRestrictedPage       = React.lazy(() => import('./pages/AccessRestrictedPage').then(m => ({ default: m.AccessRestrictedPage })));

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
/**
 * IMPORTANT: every `id` in this table must be unique across *all* HTML pages
 * that load `main.js`. If a page's own wrapper div reuses an id that is also
 * a mount target here (e.g. a page body div with `id="tab-customers"`),
 * `mountKnown` will render a React island into that wrapper — replacing its
 * children, including any nested mount points — before those nested mounts
 * can be reached. The nested components then render into a detached DOM node
 * and are invisible to users. Keep page-level structural ids (app-body,
 * *-page-body, etc.) distinct from the React mount ids listed below.
 */
const MOUNTS: Array<{ id: string; render: () => React.ReactElement; fallback?: React.ReactElement }> = [
  { id: 'login-root',           render: () => <LoginPage /> },
  { id: 'set-password-root',    render: () => <SetPasswordPage /> },
  { id: 'onboarding-root',      render: () => <OnboardingPage /> },
  { id: 'app-header-mount',      render: () => <GlobalHeader /> },
  { id: 'page-heading-mount',    render: () => <PageHeadingPanel /> },
  { id: 'app-bottom-nav-mount',  render: () => <BottomNav /> },
  { id: 'app-bottom-bar-mount',  render: () => <BottomActionBar /> },
  { id: 'trades-view',          render: () => <TradesPage /> },
  { id: 'home-view',            render: () => <HomePage />,     fallback: <HomePageSkeleton /> },
  { id: 'tab-calendar',         render: () => <CalendarPage />, fallback: <CalendarPageSkeleton /> },
  { id: 'profile-view',         render: () => <ProfilePage />,  fallback: <ProfilePageSkeleton /> },
  { id: 'admin-mui-tabs-mount', render: () => <AdminTabsBar /> },
  { id: 'tab-designsystem',     render: () => <DesignSystemPage /> },
  { id: 'tab-search',           render: () => <SearchSettingsPage /> },
  { id: 'tab-workshop',         render: () => <WorkshopSettingsPage /> },
  { id: 'tab-customers',        render: () => <CustomersPage />, fallback: <CustomersPageSkeleton /> },
  { id: 'sales-board-mount',    render: () => <SalesBoardPage />, fallback: <SalesBoardPageSkeleton /> },
  { id: 'survey-board-mount',   render: () => <SurveyBoardPage /> },
  { id: 'tab-team',             render: () => <AdminTeamPage />, fallback: <AdminTeamPageSkeleton /> },
  { id: 'tab-permissions',      render: () => <AdminPermissionsPage />, fallback: <AdminPermissionsPageSkeleton /> },
  { id: 'tab-requests',         render: () => <AdminRequestsPage />,   fallback: <AdminRequestsPageSkeleton /> },
  { id: 'tab-auditlog',         render: () => <AdminAuditLogPage />,   fallback: <AdminAuditLogPageSkeleton /> },
  { id: 'tab-settings',         render: () => <SettingsPage />,        fallback: <AdminSettingsPageSkeleton /> },
  { id: 'tab-cardactions',      render: () => <CardActionsPage />,     fallback: <CardActionsPageSkeleton /> },
  { id: 'tab-actionhandlers',   render: () => <ActionHandlersPage />,  fallback: <ActionHandlersPageSkeleton /> },
  { id: 'tab-designvisit',      render: () => <DesignVisitPage /> },
  { id: 'tab-devenv',           render: () => <DevEnvironmentPage /> },
  { id: 'ideas-page-mount',       render: () => <IdeasPage /> },
  { id: 'customer-detail-root',   render: () => <CustomerDetailPage /> },
  { id: 'invoices-page-mount',    render: () => <StandaloneInvoicesPage /> },
  { id: 'projects-view',          render: () => <ProjectsPage /> },
  { id: 'db-page-mount',              render: () => <DatabaseAdminPage /> },
  { id: 'dv-signoff-mount',           render: () => <DesignVisitSignOffPage /> },
  { id: 'not-found-root',             render: () => <NotFoundPage /> },
  { id: 'access-restricted-root',     render: () => <AccessRestrictedPage /> },
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

/**
 * Imperative mounting function exposed for the vanilla-JS design-visit wizard.
 * Called from card-action-handlers.js when the wizard reaches Step 2 (Rooms).
 *
 * Returns a handle with:
 *   update(newProps)  — re-render with updated props (e.g. fresh doorStyles
 *                       after a BroadcastChannel catalogue change)
 *   unmount()         — tear down the React tree when leaving Step 2
 */
(window as unknown as {
  mountDesignVisitRoomsStep: (
    container: HTMLElement,
    props: DesignVisitRoomsStepProps,
  ) => { update: (p: Partial<DesignVisitRoomsStepProps>) => void; unmount: () => void };
}).mountDesignVisitRoomsStep = (container, props) => {
  const root = createRoot(container);
  let current: DesignVisitRoomsStepProps = { ...props };

  function doRender() {
    root.render(
      <AppThemeProvider>
        <IslandErrorBoundary islandId="dv-rooms-step">
          <DesignVisitRoomsStep {...current} />
        </IslandErrorBoundary>
      </AppThemeProvider>,
    );
  }

  doRender();

  return {
    update(newProps: Partial<DesignVisitRoomsStepProps>) {
      current = { ...current, ...newProps };
      doRender();
    },
    unmount() {
      root.unmount();
    },
  };
};
