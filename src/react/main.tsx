import React, { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { AppThemeProvider } from './AppThemeProvider';
import { loadSearchSettings } from './lib/searchSettings';
import { IslandErrorBoundary } from './components/IslandErrorBoundary';
import { CardActionModalsHost } from './components/CardActionModalsHost';
import { ConnectServicesModal } from './components/modals/ConnectServicesModal';
import { ConnectionToastProvider, useConnectModal } from './context/ConnectionToastContext';
import { WorkflowDataProvider } from './context/WorkflowDataContext';
import { openCardActionModal } from './utils/cardActionModalRegistry';
import {
  PageLoadingSkeleton,
  CustomersPageSkeleton,
  HomePageSkeleton,
  ProfilePageSkeleton,
  AdminTeamPageSkeleton,
  AdminPermissionsPageSkeleton,
  AdminRequestsPageSkeleton,
  AdminAuditLogPageSkeleton,
  AdminSettingsPageSkeleton,
  AdminStagesPageSkeleton,
  CardActionsPageSkeleton,
  ActionHandlersPageSkeleton,
  ProjectsPageSkeleton,
} from './components/PageLoadingSkeleton';

/*
 * Shell components that are always present on every page are imported
 * statically — they're small and needed immediately on mount.
 */
import { GlobalHeader } from './components/GlobalHeader';
import { PageHeadingPanel } from './components/PageHeadingPanel';
import { BottomNav } from './components/BottomNav';
import { AdminGroupedTabsBar } from './components/AdminGroupedTabsBar';
import { BottomActionBar } from './components/BottomActionBar';
import { AppBootstrapProvider } from './contexts/AppBootstrapContext';
import { PUBLIC_ISLAND_IDS } from './lib/publicIslands';
import { registerServiceWorker, initOfflineSync } from './lib/registerServiceWorker';
import { runLegacyKeysSweep } from './lib/legacyKeysSweep';
const CommandPalette    = React.lazy(() => import('./components/CommandPalette').then(m => ({ default: m.CommandPalette })));
const AccessRequestGate = React.lazy(() => import('./components/AccessRequestGate').then(m => ({ default: m.AccessRequestGate })));

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
const SearchSettingsPage = React.lazy(() => import('./pages/SearchSettingsPage').then(m => ({ default: m.SearchSettingsPage })));
const GoogleMapsPage     = React.lazy(() => import('./pages/admin/GoogleMapsPage').then(m => ({ default: m.GoogleMapsPage })));
const CustomersPage      = React.lazy(() => import('./pages/CustomersPage').then(m => ({ default: m.CustomersPage })));
const HomePage           = React.lazy(() => import('./pages/HomePage').then(m => ({ default: m.HomePage })));
const ProfilePage        = React.lazy(() => import('./pages/ProfilePage').then(m => ({ default: m.ProfilePage })));
const SettingsPage       = React.lazy(() => import('./pages/admin/SettingsPage').then(m => ({ default: m.SettingsPage })));
const CardActionsPage    = React.lazy(() => import('./pages/admin/CardActionsPage').then(m => ({ default: m.CardActionsPage })));
const ActionHandlersPage = React.lazy(() => import('./pages/admin/ActionHandlersPage').then(m => ({ default: m.ActionHandlersPage })));
const HubSpotPage        = React.lazy(() => import('./pages/admin/HubSpotPage').then(m => ({ default: m.HubSpotPage })));
const QuickBooksSettingsPage = React.lazy(() => import('./pages/admin/QuickBooksSettingsPage').then(m => ({ default: m.QuickBooksSettingsPage })));
const DesignVisitPage    = React.lazy(() => import('./pages/admin/DesignVisitPage').then(m => ({ default: m.DesignVisitPage })));
const DevEnvironmentPage = React.lazy(() => import('./pages/admin/DevEnvironmentPage').then(m => ({ default: m.DevEnvironmentPage })));
const OfflineSupportPage = React.lazy(() => import('./pages/admin/OfflineSupportPage').then(m => ({ default: m.OfflineSupportPage })));
const EmailTemplatesPage = React.lazy(() => import('./pages/admin/EmailTemplatesPage'));
const WorkflowPage       = React.lazy(() => import('./pages/admin/WorkflowPage').then(m => ({ default: m.WorkflowPage })));
const StagesPage         = React.lazy(() => import('./pages/admin/StagesPage').then(m => ({ default: m.StagesPage })));
const AdminTeamPage      = React.lazy(() => import('./pages/admin/AdminTeamPage').then(m => ({ default: m.AdminTeamPage })));
const AdminPermissionsPage = React.lazy(() => import('./pages/admin/AdminPermissionsPage').then(m => ({ default: m.AdminPermissionsPage })));
const AdminRequestsPage  = React.lazy(() => import('./pages/admin/AdminRequestsPage').then(m => ({ default: m.AdminRequestsPage })));
const AdminAuditLogPage  = React.lazy(() => import('./pages/admin/AdminAuditLogPage').then(m => ({ default: m.AdminAuditLogPage })));
const IdeasPage              = React.lazy(() => import('./pages/IdeasPage').then(m => ({ default: m.IdeasPage })));
const CustomerDetailPage     = React.lazy(() => import('./pages/CustomerDetailPage').then(m => ({ default: m.CustomerDetailPage })));
const StandaloneInvoicesPage = React.lazy(() => import('./pages/StandaloneInvoicesPage').then(m => ({ default: m.StandaloneInvoicesPage })));
const ProjectsPage           = React.lazy(() => import('./pages/ProjectsPage').then(m => ({ default: m.ProjectsPage })));
const DesignVisitSignOffPage     = React.lazy(() => import('./pages/DesignVisitSignOffPage').then(m => ({ default: m.DesignVisitSignOffPage })));
const SurveyVisitSignOffPage     = React.lazy(() => import('./pages/SurveyVisitSignOffPage').then(m => ({ default: m.SurveyVisitSignOffPage })));
const CustomerInfoPage           = React.lazy(() => import('./pages/CustomerInfoPage').then(m => ({ default: m.CustomerInfoPage })));
const NotFoundPage               = React.lazy(() => import('./pages/NotFoundPage').then(m => ({ default: m.NotFoundPage })));
const AccessRestrictedPage       = React.lazy(() => import('./pages/AccessRestrictedPage').then(m => ({ default: m.AccessRestrictedPage })));

/**
 * Mounts that must NOT receive the ConnectionToastProvider:
 * - Public auth pages (no session, status endpoints return 401)
 * - Design-visit sign-off page (public, customer-facing)
 *
 * Derived directly from PUBLIC_ISLAND_IDS (src/react/lib/publicIslands.ts).
 * To add a new public island, add its id there and annotate the MOUNTS entry
 * below with `// public-island`.
 */
const CONN_TOAST_EXCLUDED = PUBLIC_ISLAND_IDS;

/**
 * Every React mount goes through `AppThemeProvider` so the shared MUI
 * theme + `ScopedCssBaseline` apply everywhere. New mount points only
 * need to add an entry to `MOUNTS` below — the wrapper is automatic.
 *
 * Lazy page components are wrapped in `Suspense` (fallback: nothing) so
 * the rest of the page is never blocked while a chunk downloads.
 *
 * Authenticated mounts are also wrapped in `ConnectionToastProvider` so
 * page components can call `useConnectionCheck()` / `useConnectionToast()`
 * to surface HubSpot / Google / QuickBooks / DB connection toasts.
 */
function withTheme(
  node: React.ReactElement,
  islandId: string,
  fallback: React.ReactElement = <PageLoadingSkeleton />,
  // Optional wrapper applied around the Suspense boundary (inside IslandErrorBoundary)
  // so the wrapper's useEffect hooks fire as soon as the island mounts — before the
  // lazy page chunk loads and the Suspense skeleton is replaced.
  preSuspenseWrap?: (children: React.ReactNode) => React.ReactElement,
): React.ReactElement {
  const withBootstrap = (
    <AppBootstrapProvider islandId={islandId}>{node}</AppBootstrapProvider>
  );
  const inner = CONN_TOAST_EXCLUDED.has(islandId)
    ? withBootstrap
    : <ConnectionToastProvider>{withBootstrap}</ConnectionToastProvider>;
  const suspensed = <Suspense fallback={fallback}>{inner}</Suspense>;
  const wrapped = preSuspenseWrap ? preSuspenseWrap(suspensed) : suspensed;
  return (
    <AppThemeProvider>
      <IslandErrorBoundary islandId={islandId}>
        {wrapped}
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
 * exists. The admin Search settings tab (`#tab-search`) and other tabs
 * are on React; future ports add their own `#tab-…` ids to the MOUNTS
 * table below.
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
const MOUNTS: Array<{
  id: string;
  render: () => React.ReactElement;
  fallback?: React.ReactElement;
  preSuspenseWrap?: (children: React.ReactNode) => React.ReactElement;
}> = [
  // public-island: islands below that carry this annotation are served on pages
  // accessible without an authenticated session.  Any mount tagged // public-island
  // MUST also have its id added to PUBLIC_ISLAND_IDS in
  // src/react/lib/publicIslands.ts — that is the single authoritative source.
  // Both CONN_TOAST_EXCLUDED (this file) and BOOTSTRAP_EXCLUDED
  // (src/react/contexts/AppBootstrapContext.tsx) are derived from it automatically.
  // scripts/check-public-island-bootstrap.mjs enforces the annotation ↔ Set sync.
  { id: 'login-root',           render: () => <LoginPage /> },           // public-island
  { id: 'set-password-root',    render: () => <SetPasswordPage /> },     // public-island
  { id: 'onboarding-root',      render: () => <OnboardingPage /> },      // public-island
  // chrome-global: these six mounts are declared statically in every HTML shell
  // so they appear on all pages simultaneously.  The duplicate-mount check in
  // scripts/check-mount-id-conflicts.mjs skips ids annotated with this comment.
  { id: 'access-gate-mount',     render: () => <AccessRequestGate />, fallback: <></> }, // chrome-global
  { id: 'app-header-mount',      render: () => <GlobalHeader /> },                       // chrome-global
  { id: 'page-heading-mount',    render: () => <PageHeadingPanel /> },                   // chrome-global
  { id: 'app-bottom-nav-mount',  render: () => <BottomNav /> },                          // chrome-global
  { id: 'app-bottom-bar-mount',  render: () => <BottomActionBar /> },                    // chrome-global
  { id: 'command-palette-mount', render: () => <CommandPalette />, fallback: <></> },    // chrome-global
  { id: 'trades-view',          render: () => <TradesPage /> },
  { id: 'home-view',            render: () => <HomePage />,     fallback: <HomePageSkeleton />, preSuspenseWrap: (c) => <WorkflowDataProvider>{c}</WorkflowDataProvider> },
  { id: 'profile-view',         render: () => <ProfilePage />,  fallback: <ProfilePageSkeleton /> },
  { id: 'admin-grouped-tabs-mount', render: () => <AdminGroupedTabsBar /> },
  { id: 'tab-search',           render: () => <SearchSettingsPage /> },
  { id: 'tab-customers',        render: () => <CustomersPage />, fallback: <CustomersPageSkeleton />, preSuspenseWrap: (c) => <WorkflowDataProvider>{c}</WorkflowDataProvider> },
  { id: 'tab-team',             render: () => <AdminTeamPage />, fallback: <AdminTeamPageSkeleton /> },
  { id: 'tab-permissions',      render: () => <AdminPermissionsPage />, fallback: <AdminPermissionsPageSkeleton /> },
  { id: 'tab-requests',         render: () => <AdminRequestsPage />,   fallback: <AdminRequestsPageSkeleton /> },
  { id: 'tab-auditlog',         render: () => <AdminAuditLogPage />,   fallback: <AdminAuditLogPageSkeleton /> },
  { id: 'tab-hubspot',           render: () => <HubSpotPage /> },
  { id: 'tab-quickbooks',        render: () => <QuickBooksSettingsPage /> },
  { id: 'tab-settings',         render: () => <SettingsPage />,        fallback: <AdminSettingsPageSkeleton /> },
  { id: 'tab-stages',           render: () => <StagesPage />,          fallback: <AdminStagesPageSkeleton /> },
  { id: 'tab-cardactions',      render: () => <CardActionsPage />,     fallback: <CardActionsPageSkeleton /> },
  { id: 'tab-actionhandlers',   render: () => <ActionHandlersPage />,  fallback: <ActionHandlersPageSkeleton /> },
  { id: 'tab-designvisit',      render: () => <DesignVisitPage /> },
  { id: 'tab-devenv',           render: () => <DevEnvironmentPage /> },
  { id: 'tab-maps',             render: () => <GoogleMapsPage /> },
  { id: 'tab-offline',          render: () => <OfflineSupportPage /> },
  { id: 'tab-emailtemplates',   render: () => <EmailTemplatesPage /> },
  { id: 'tab-workflow',         render: () => <WorkflowPage /> },
  { id: 'ideas-page-mount',       render: () => <IdeasPage /> },
  { id: 'customer-detail-root',   render: () => <CustomerDetailPage />, preSuspenseWrap: (c) => <WorkflowDataProvider>{c}</WorkflowDataProvider> },
  { id: 'invoices-page-mount',    render: () => <StandaloneInvoicesPage /> },
  { id: 'projects-view',          render: () => <ProjectsPage />, fallback: <ProjectsPageSkeleton /> },
  { id: 'dv-signoff-mount',           render: () => <DesignVisitSignOffPage /> }, // public-island
  { id: 'sv-signoff-mount',           render: () => <SurveyVisitSignOffPage /> }, // public-island
  { id: 'customer-info-mount',        render: () => <CustomerInfoPage /> },        // public-island
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
      createRoot(el).render(withTheme(m.render(), m.id, m.fallback, m.preSuspenseWrap));
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

function initCardActionModalsHost() {
  if (document.getElementById('card-action-modals-host')) return;
  const container = document.createElement('div');
  container.id = 'card-action-modals-host';
  document.body.appendChild(container);
  createRoot(container).render(
    <AppThemeProvider>
      <CardActionModalsHost />
    </AppThemeProvider>,
  );
}

function ConnectServicesModalHost() {
  const { open, highlightService, message, closeConnectModal } = useConnectModal();
  return (
    <ConnectServicesModal
      open={open}
      onClose={closeConnectModal}
      highlightService={highlightService}
      message={message}
    />
  );
}

function initConnectServicesModalHost() {
  if (document.getElementById('connect-services-modal-host')) return;

  // Mirror the same suppression policy as ConnectionToastProvider: skip pages
  // that only contain public/auth islands (login, set-password, onboarding,
  // customer-info, design-visit sign-off). On those pages the status endpoints
  // return 401, no error transitions occur, and the modal is never actionable.
  const hasAuthenticatedMount = MOUNTS.some(
    (m) => !CONN_TOAST_EXCLUDED.has(m.id) && !!document.getElementById(m.id),
  );
  if (!hasAuthenticatedMount) return;

  const container = document.createElement('div');
  container.id = 'connect-services-modal-host';
  document.body.appendChild(container);
  createRoot(container).render(
    <AppThemeProvider>
      <ConnectServicesModalHost />
    </AppThemeProvider>,
  );
}

function mount() {
  initCardActionModalsHost();
  initConnectServicesModalHost();
  const mountedAny = mountKnown() > 0;
  if (mountedAny) return;

  // No mount points exist yet — admin.html renders #tab-search /
  // other tab panels into #page asynchronously after its data fetches resolve,
  // then calls window.__reactIslandMount() synchronously right after setting
  // #page.innerHTML so the React panels render in the same tick.
  // Nothing else to do here.
}

(window as unknown as { __reactIslandMount?: () => void }).__reactIslandMount = () => {
  mountKnown();
};

// One-time global sweep: remove all legacy unscoped localStorage keys left
// over from before per-user key scoping was introduced.  Runs synchronously
// at boot so the keys are gone before any component mounts — even on pages
// whose per-component shims were never reached.
runLegacyKeysSweep();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}

loadSearchSettings();

// Register the offline service worker (no-op under the Vite dev server).
registerServiceWorker();

// Boot the offline write-queue sync engine (dynamically imported so `idb`
// stays out of the main bundle).
initOfflineSync();

/**
 * Global bridge so vanilla-JS call-sites and test probes can open the React
 * CardActionModalsHost without importing the TypeScript registry directly.
 * The host registers itself on mount via registerCardActionModalOpener; calls
 * before mount are silently ignored (same behaviour as openCardActionModal itself).
 */
(window as unknown as {
  openCardActionModal: typeof openCardActionModal;
}).openCardActionModal = openCardActionModal;
