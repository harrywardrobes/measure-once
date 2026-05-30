import React from 'react';
import { ThemeProvider } from '@mui/material/styles';
import GlobalStyles from '@mui/material/GlobalStyles';
import ScopedCssBaseline from '@mui/material/ScopedCssBaseline';
import { theme, BRAND_COLORS, STAGE_COLORS, STATUS_COLORS, RADIUS } from './theme';
import { ToastProvider } from './contexts/ToastContext';

/**
 * Storybook-only theme wrapper.
 *
 * Provides the same MUI theme, GlobalStyles design tokens, and ToastProvider
 * as AppThemeProvider, but deliberately omits AuthProvider.  AuthProvider
 * calls fetch('/api/auth/user') and related endpoints on every mount; in the
 * static Storybook build these requests hit the live Express server without a
 * session cookie and hang or return 401s, leaving stories in a perpetual
 * loading state.
 *
 * Omitting AuthProvider is safe because useAuth() already has a no-provider
 * fallback that reads window.__moHeaderUser and returns loading:false — all
 * hooks (usePrivilege, usePrefs, etc.) degrade gracefully.
 *
 * The remaining fetch calls that components make on mount (usePrefs →
 * /api/users/me/prefs, BottomNav → /api/nav-role-config) are intercepted by
 * the global fetch stub in .storybook/preview.ts so they resolve immediately
 * with empty stub data.
 *
 * DO NOT import this file outside .storybook/.
 */

const TYPO = theme.typography;

function camelToKebab(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])(\d)/g, '$1-$2')
    .toLowerCase();
}

const rootTokens = {
  'color-scheme': 'light',
  '--header-h': 'calc(52px + env(safe-area-inset-top))',
  '--banner-h': '37px',
  ...Object.fromEntries(
    Object.entries(BRAND_COLORS).map(([k, v]) => [`--${camelToKebab(k)}`, v])
  ),
  '--shadow-sm': '0 1px 3px rgba(30,24,14,0.10), 0 1px 2px rgba(30,24,14,0.06)',
  '--shadow-md': '0 4px 12px rgba(30,24,14,0.12), 0 2px 4px rgba(30,24,14,0.08)',
  '--shadow-lg': '0 8px 24px rgba(30,24,14,0.14), 0 4px 8px rgba(30,24,14,0.08)',
  ...Object.fromEntries(
    Object.entries(RADIUS).map(([k, v]) => [`--radius-${k}`, `${v}px`])
  ),
  '--z-base':     1,
  '--z-raised':   5,
  '--z-sticky':   20,
  '--z-nav':      90,
  '--z-header':   100,
  '--z-dropdown': 300,
  '--z-panel':    900,
  '--z-overlay':  1000,
  '--z-modal':    9000,
  '--z-toast':    9500,
  '--z-tooltip':  9999,
  '--surface-card':     '#ffffff',
  '--surface-muted':    '#f8f7f4',
  '--surface-soft':     '#f9fafb',
  '--border-soft':      '#e7e5e0',
  '--border-strong':    '#d6d3d1',
  '--shadow-card-xs':   '0 1px 3px rgba(0,0,0,.04)',
  '--shadow-card-sm':   '0 2px 6px rgba(0,0,0,.06)',
  '--shadow-modal':     '0 20px 60px rgba(0,0,0,0.25)',
  '--overlay-scrim':    'rgba(0,0,0,0.45)',
  /* ── Status colours (auto-derived from STATUS_COLORS in theme.ts) ───────── */
  ...Object.fromEntries(
    Object.entries(STATUS_COLORS).flatMap(([key, colors]) => {
      const prefix = `--status-${camelToKebab(key)}`;
      const entries: [string, string | undefined][] = [
        [`${prefix}-bg`, colors.bg],
        [`${prefix}-text`, colors.text],
      ];
      if (colors.border) entries.push([`${prefix}-border`, colors.border]);
      return entries.filter((e): e is [string, string] => e[1] !== undefined);
    })
  ),
  '--error': 'var(--status-danger-text)',
  '--brand-accent':       '#3d0f7a',
  '--brand-accent-hover': '#5a1fad',
  '--brand-accent-ring':  'rgba(61,15,122,.12)',
  ...Object.fromEntries(
    Object.entries(STAGE_COLORS).flatMap(([stage, colors]) =>
      (['bg', 'light', 'text'] as const).map(prop => [`--stage-${stage}-${prop}`, colors[prop]])
    )
  ),
  '--typo-h1-font-size':   (TYPO.h1 as { fontSize: string }).fontSize,
  '--typo-h1-font-weight': String((TYPO.h1 as { fontWeight: number }).fontWeight),
  '--typo-h1-line-height': String((TYPO.h1 as { lineHeight: number }).lineHeight),
  '--typo-h2-font-size':   (TYPO.h2 as { fontSize: string }).fontSize,
  '--typo-h2-font-weight': String((TYPO.h2 as { fontWeight: number }).fontWeight),
  '--typo-h2-line-height': String((TYPO.h2 as { lineHeight: number }).lineHeight),
  '--typo-h3-font-size':   (TYPO.h3 as { fontSize: string }).fontSize,
  '--typo-h3-font-weight': String((TYPO.h3 as { fontWeight: number }).fontWeight),
  '--typo-h3-line-height': String((TYPO.h3 as { lineHeight: number }).lineHeight),
  '--typo-h4-font-size':   (TYPO.h4 as { fontSize: string }).fontSize,
  '--typo-h4-font-weight': String((TYPO.h4 as { fontWeight: number }).fontWeight),
  '--typo-h4-line-height': String((TYPO.h4 as { lineHeight: number }).lineHeight),
  '--typo-h5-font-size':   (TYPO.h5 as { fontSize: string }).fontSize,
  '--typo-h5-font-weight': String((TYPO.h5 as { fontWeight: number }).fontWeight),
  '--typo-h5-line-height': String((TYPO.h5 as { lineHeight: number }).lineHeight),
  '--typo-h6-font-size':   (TYPO.h6 as { fontSize: string }).fontSize,
  '--typo-h6-font-weight': String((TYPO.h6 as { fontWeight: number }).fontWeight),
  '--typo-h6-line-height': String((TYPO.h6 as { lineHeight: number }).lineHeight),
  '--typo-subtitle1-font-size':   (TYPO.subtitle1 as { fontSize: string }).fontSize,
  '--typo-subtitle1-font-weight': String((TYPO.subtitle1 as { fontWeight: number }).fontWeight),
  '--typo-subtitle1-line-height': String((TYPO.subtitle1 as { lineHeight: number }).lineHeight),
  '--typo-subtitle2-font-size':   (TYPO.subtitle2 as { fontSize: string }).fontSize,
  '--typo-subtitle2-font-weight': String((TYPO.subtitle2 as { fontWeight: number }).fontWeight),
  '--typo-subtitle2-line-height': String((TYPO.subtitle2 as { lineHeight: number }).lineHeight),
  '--typo-body1-font-size':   (TYPO.body1 as { fontSize: string }).fontSize,
  '--typo-body1-font-weight': String((TYPO.body1 as { fontWeight: number }).fontWeight),
  '--typo-body1-line-height': String((TYPO.body1 as { lineHeight: number }).lineHeight),
  '--typo-body2-font-size':   (TYPO.body2 as { fontSize: string }).fontSize,
  '--typo-body2-font-weight': String((TYPO.body2 as { fontWeight: number }).fontWeight),
  '--typo-body2-line-height': String((TYPO.body2 as { lineHeight: number }).lineHeight),
  '--typo-button-font-size':   (TYPO.button as { fontSize: string }).fontSize,
  '--typo-button-font-weight': String((TYPO.button as { fontWeight: number }).fontWeight),
  '--typo-button-line-height': String((TYPO.button as { lineHeight: number }).lineHeight),
  '--typo-caption-font-size':   (TYPO.caption as { fontSize: string }).fontSize,
  '--typo-caption-font-weight': String((TYPO.caption as { fontWeight: number }).fontWeight),
  '--typo-caption-line-height': String((TYPO.caption as { lineHeight: number }).lineHeight),
  '--typo-overline-font-size':   (TYPO.overline as { fontSize: string }).fontSize,
  '--typo-overline-font-weight': String((TYPO.overline as { fontWeight: number }).fontWeight),
  '--typo-overline-line-height': String((TYPO.overline as { lineHeight: number }).lineHeight),
  '--spacing-unit': 8,
};

export function StorybookThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <GlobalStyles styles={{ ':root': rootTokens }} />
      <ToastProvider>
        <ScopedCssBaseline>{children}</ScopedCssBaseline>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default StorybookThemeProvider;
