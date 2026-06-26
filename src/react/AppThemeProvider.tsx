import React from 'react';
import { ThemeProvider } from '@mui/material/styles';
import GlobalStyles from '@mui/material/GlobalStyles';
import ScopedCssBaseline from '@mui/material/ScopedCssBaseline';
import { theme, BRAND_COLORS, STAGE_COLORS, STATUS_COLORS, RADIUS } from './theme';
import { ToastProvider } from './contexts/ToastContext';
import { AuthProvider } from './contexts/AuthContext';

/**
 * Wraps every React mount in the shared MUI theme.
 *
 * We deliberately use `ScopedCssBaseline` rather than the global
 * `CssBaseline` because the React island co-exists with legacy vanilla
 * pages (`admin.html`, `customers.html`, …) that depend on their own
 * `public/app-styles.css` baseline. Scoping keeps MUI normalisation contained
 * to React-mounted subtrees so we don't reset typography or margins on
 * the surrounding page.
 *
 * `GlobalStyles` below injects the `:root` custom-property block into the
 * document `<head>` (not scoped) so the same design tokens are available to
 * every non-React page that uses `var(--orchid)`, `var(--paper)`, etc. The
 * values are derived at runtime from `src/react/theme.ts`, which is now the
 * single source of truth — no more manually-kept mirror in app-styles.css.
 *
 * BRAND_COLORS, STAGE_COLORS, and RADIUS tokens are derived automatically by
 * looping over the constants — adding a new entry to any of those objects in
 * theme.ts is sufficient to make it appear in the :root block.
 *
 * Every page / story should render its tree inside this provider — see
 * `src/react/README.md` for the convention.
 */

const TYPO = theme.typography;

/** camelCase → kebab-case, inserting a dash before digits that follow letters. */
function camelToKebab(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])(\d)/g, '$1-$2')
    .toLowerCase();
}

const rootTokens = {
  'color-scheme': 'light',

  /* ── Layout ─────────────────────────────────────────────────────────────── */
  '--header-h': 'calc(64px + env(safe-area-inset-top))',
  '--banner-h': '37px',

  /* ── Brand colours (auto-derived from BRAND_COLORS in theme.ts) ──────────
   *  camelCase key  →  --kebab-case var
   *  e.g. orchidDeep → --orchid-deep, ink1 → --ink-1                        */
  ...Object.fromEntries(
    Object.entries(BRAND_COLORS).map(([k, v]) => [`--${camelToKebab(k)}`, v])
  ),

  /* ── Shadows ─────────────────────────────────────────────────────────────── */
  '--shadow-sm': '0 1px 2px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.08)',
  '--shadow-md': '0 2px 4px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.10)',
  '--shadow-lg': '0 4px 8px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.12)',

  /* ── Radius (auto-derived from RADIUS in theme.ts) ───────────────────────
   *  key → --radius-<key>  e.g. xl → --radius-xl, 2xl → --radius-2xl       */
  ...Object.fromEntries(
    Object.entries(RADIUS).map(([k, v]) => [`--radius-${k}`, `${v}px`])
  ),

  /* ── Z-index ladder ──────────────────────────────────────────────────────── */
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

  /* ── Neutral / semantic surface tokens ───────────────────────────────────── */
  '--surface-card':     '#ffffff',
  '--surface-muted':    '#f5f4f2',
  '--surface-soft':     '#f9fafb',
  '--border-soft':      '#e2e1df',
  '--border-strong':    '#d4d3d0',
  '--shadow-card-xs':   '0 1px 2px rgba(0,0,0,.04)',
  '--shadow-card-sm':   '0 2px 6px rgba(0,0,0,.05)',
  '--shadow-modal':     '0 8px 32px rgba(0,0,0,0.18)',
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

  /* ── Brand action accents ────────────────────────────────────────────────── */
  '--brand-accent':       '#3d0f7a',
  '--brand-accent-hover': '#5a1fad',
  '--brand-accent-ring':  'rgba(61,15,122,.12)',

  /* ── Stage colours (auto-derived from STAGE_COLORS in theme.ts) ──────────
   *  For each stage key, bg / light / text sub-properties become
   *  --stage-<key>-bg, --stage-<key>-light, --stage-<key>-text              */
  ...Object.fromEntries(
    Object.entries(STAGE_COLORS).flatMap(([stage, colors]) =>
      (['bg', 'light', 'text'] as const).map(prop => [`--stage-${stage}-${prop}`, colors[prop]])
    )
  ),

  /* ── Typography scale ────────────────────────────────────────────────────── */
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

  /* ── Spacing unit ────────────────────────────────────────────────────────── */
  '--spacing-unit': 8,
};

export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      {/* Inject :root design tokens globally so vanilla pages share the same
          CSS custom properties as React islands. GlobalStyles targets the
          document <head>, not just the React subtree.  */}
      <GlobalStyles styles={{ ':root': rootTokens }} />
      <AuthProvider>
        <ToastProvider>
          <ScopedCssBaseline>{children}</ScopedCssBaseline>
        </ToastProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default AppThemeProvider;
