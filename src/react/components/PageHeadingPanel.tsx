import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

declare global {
  interface Window {
    PAGE_TITLES?: Record<string, string>;
  }
}

/**
 * Per-page heading panel rendered into the `#page-heading-mount`
 * placeholder injected by `public/chrome.js` immediately below the
 * AppBar.
 *
 * Behaviour mirrors the previous vanilla template:
 *   - Title resolved from `window.PAGE_TITLES[location.pathname]`.
 *   - Suppressed on `/admin*` and on `/customers/:id` (those pages
 *     render their own heading / use a fixed-layout shell).
 *   - Action slot exposed as `#page-heading-action` for legacy consumers
 *     (e.g. CustomersPage portals a "+ New customer" button into it).
 *     The slot collapses when empty.
 */
export function PageHeadingPanel() {
  const [path, setPath] = useState<string>(() => window.location.pathname);

  useEffect(() => {
    const onNav = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
    window.addEventListener('mo:navigation', onNav as EventListener);
    return () => {
      window.removeEventListener('popstate', onNav);
      window.removeEventListener('hashchange', onNav);
      window.removeEventListener('mo:navigation', onNav as EventListener);
    };
  }, []);

  const suppressed =
    path === '/admin' ||
    path.startsWith('/admin/') ||
    /^\/customers\/[^/]+/.test(path) ||
    path === '/sales' ||
    path === '/survey';
  const title = (window.PAGE_TITLES || {})[path] || '';

  if (!title || suppressed) return null;

  return (
    <Box
      id="page-heading-panel"
      role="region"
      aria-label={title}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1.5,
        maxWidth: 640,
        width: '100%',
        mx: 'auto',
        px: 2,
        pt: 2,
        pb: 1,
        boxSizing: 'border-box',
      }}
    >
      <Typography
        component="h1"
        id="page-heading-title"
        sx={{
          m: 0,
          fontFamily: "'Anton', system-ui, sans-serif",
          fontSize: '1.6rem',
          lineHeight: 1.15,
          letterSpacing: '0.01em',
          color: 'var(--ink-1)',
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {title}
      </Typography>
      <Box
        id="page-heading-action"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          flexShrink: 0,
          '&:empty': { display: 'none' },
        }}
      />
    </Box>
  );
}

export default PageHeadingPanel;
