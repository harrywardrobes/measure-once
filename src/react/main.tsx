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

  // Mount points may not exist yet — admin.html renders #tab-search /
  // #tab-designsystem into #page asynchronously after its data fetches
  // resolve, which happens *after* this deferred module script executes.
  // Observe the DOM and try again whenever new nodes appear, stopping as
  // soon as we've mounted every entry in MOUNTS. admin.html also calls
  // window.__reactIslandMount() synchronously right after it sets
  // #page.innerHTML so the React panels render in the same tick — the
  // observer is a belt-and-braces fallback for other future mount sites.
  const observer = new MutationObserver(() => {
    const mounted = MOUNTS.every(m => {
      const el = document.getElementById(m.id);
      return el && el.dataset.dsRendered === '1';
    });
    mountKnown();
    if (mounted) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

(window as unknown as { __reactIslandMount?: () => void }).__reactIslandMount = () => {
  mountKnown();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
