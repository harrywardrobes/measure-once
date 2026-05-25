import React from 'react';
import { createRoot } from 'react-dom/client';
import { DesignSystemPage } from './pages/DesignSystemPage';

/**
 * Entry point for the React island that co-exists with the legacy static
 * `public/` pages. Built by Vite into `public/react/main.js` with a stable
 * filename so admin.html can `<script>` it directly without a manifest.
 *
 * Mount strategy: we look for known mount points in priority order and
 * render whichever exists. Today only the admin Design System tab is on
 * React (`#tab-designsystem`); future ports add their own `#tab-…` ids
 * here.
 *
 * The vite-dev playground (`src/react/index.html`) provides a `#root`
 * element so `npm run dev:react` still gives a standalone preview.
 */
function mount() {
  const designSystem = document.getElementById('tab-designsystem');
  if (designSystem) {
    if (designSystem.dataset.dsRendered === '1') return;
    designSystem.dataset.dsRendered = '1';
    createRoot(designSystem).render(<DesignSystemPage />);
    return;
  }

  const root = document.getElementById('root');
  if (root) {
    createRoot(root).render(<DesignSystemPage />);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
