import React from 'react';
import { createRoot } from 'react-dom/client';
import { DesignSystemPage } from './pages/DesignSystemPage';
import { SearchSettingsPage } from './pages/SearchSettingsPage';
import { WorkshopSettingsPage } from './pages/WorkshopSettingsPage';

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
  { id: 'tab-designsystem', render: () => <DesignSystemPage /> },
  { id: 'tab-search',       render: () => <SearchSettingsPage /> },
  { id: 'tab-workshop',     render: () => <WorkshopSettingsPage /> },
];

function mountKnown(): number {
  let count = 0;
  for (const m of MOUNTS) {
    const el = document.getElementById(m.id);
    if (!el) continue;
    if (el.dataset.dsRendered === '1') { count++; continue; }
    el.dataset.dsRendered = '1';
    createRoot(el).render(m.render());
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
    createRoot(root).render(<DesignSystemPage />);
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
