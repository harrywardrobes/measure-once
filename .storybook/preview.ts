import React from 'react';
import type { Preview } from '@storybook/react';
import { StorybookThemeProvider } from '../src/react/StorybookThemeProvider';

/*
 * Storybook loads the same stylesheets the production app uses, so every
 * component renders against the real tokens defined in `public/tokens.css`
 * and `public/app-styles.css`.
 * Tailwind utilities resolve through the JIT build in `public/tailwind.css`.
 *
 * Every story is wrapped in StorybookThemeProvider — a slim variant of
 * AppThemeProvider that provides the MUI theme and design tokens but omits
 * AuthProvider.  AuthProvider fetches /api/auth/user and related endpoints
 * on every mount; in the static Storybook build these requests hit the live
 * Express server without a session cookie and hang, leaving stories in a
 * permanent loading state.  useAuth() already has a no-provider fallback
 * (loading:false, user:null) so all hooks resolve safely without a provider.
 *
 * The fetch stub below intercepts the remaining per-component API calls that
 * fire on mount (usePrefs → /api/users/me/prefs, BottomNav →
 * /api/nav-role-config) and resolves them immediately with empty stub data so
 * no network traffic escapes into the Storybook iframe.
 */
import '../public/tokens.css';
import '../public/app-styles.css';
import '../public/tailwind.css';

/* ── Storybook fetch stub ─────────────────────────────────────────────────
 * Intercepts unauthenticated API calls that components fire on mount.
 * Returns minimal stub payloads so components skip loading states and render
 * immediately.  Only affects the Storybook iframe — production code is
 * unchanged.
 * ─────────────────────────────────────────────────────────────────────── */
const STUB_RESPONSES: Record<string, unknown> = {
  '/api/users/me/prefs':  {},
  '/api/nav-role-config': {},
};

const _nativeFetch = window.fetch.bind(window);
window.fetch = function storybookFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : (input as Request).url;
  const pathname = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0];
  if (Object.prototype.hasOwnProperty.call(STUB_RESPONSES, pathname)) {
    const body = JSON.stringify(STUB_RESPONSES[pathname]);
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  return _nativeFetch(input, init);
};

const preview: Preview = {
  decorators: [
    (Story) => React.createElement(StorybookThemeProvider, null, React.createElement(Story)),
  ],
  parameters: {
    backgrounds: {
      default: 'paper',
      values: [
        { name: 'paper', value: '#F6F1E7' },
        { name: 'chalk', value: '#FBFAF5' },
        { name: 'ink',   value: '#141413' },
      ],
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date:  /Date$/,
      },
    },
  },
};

export default preview;
