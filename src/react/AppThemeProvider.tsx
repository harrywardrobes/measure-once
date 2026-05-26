import React from 'react';
import { ThemeProvider } from '@mui/material/styles';
import GlobalStyles from '@mui/material/GlobalStyles';
import ScopedCssBaseline from '@mui/material/ScopedCssBaseline';
import { theme, BRAND_COLORS, STAGE_COLORS, RADIUS } from './theme';

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
 * Every page / story should render its tree inside this provider — see
 * `src/react/README.md` for the convention.
 */

const TYPO = theme.typography;

const rootTokens = {
  'color-scheme': 'light',

  /* ── Layout ─────────────────────────────────────────────────────────────── */
  '--header-h': 'calc(52px + env(safe-area-inset-top))',
  '--banner-h': '37px',

  /* ── Brand colours ───────────────────────────────────────────────────────── */
  '--paper':        BRAND_COLORS.paper,
  '--paper-deep':   BRAND_COLORS.paperDeep,
  '--stone':        BRAND_COLORS.stone,
  '--stone-light':  BRAND_COLORS.stoneLight,
  '--stone-deep':   BRAND_COLORS.stoneDeep,
  '--orchid':       BRAND_COLORS.orchid,
  '--orchid-deep':  BRAND_COLORS.orchidDeep,
  '--orchid-soft':  BRAND_COLORS.orchidSoft,
  '--orchid-tint':  BRAND_COLORS.orchidTint,
  '--plum':         BRAND_COLORS.plum,
  '--walnut':       BRAND_COLORS.walnut,
  '--ink-1':        BRAND_COLORS.ink1,
  '--ink-2':        BRAND_COLORS.ink2,
  '--ink-3':        BRAND_COLORS.ink3,
  '--ink-4':        BRAND_COLORS.ink4,

  /* ── Shadows ─────────────────────────────────────────────────────────────── */
  '--shadow-sm': '0 1px 3px rgba(30,24,14,0.10), 0 1px 2px rgba(30,24,14,0.06)',
  '--shadow-md': '0 4px 12px rgba(30,24,14,0.12), 0 2px 4px rgba(30,24,14,0.08)',
  '--shadow-lg': '0 8px 24px rgba(30,24,14,0.14), 0 4px 8px rgba(30,24,14,0.08)',

  /* ── Radius ──────────────────────────────────────────────────────────────── */
  '--radius-xs':   `${RADIUS.xs}px`,
  '--radius-sm':   `${RADIUS.sm}px`,
  '--radius-md':   `${RADIUS.md}px`,
  '--radius-lg':   `${RADIUS.lg}px`,
  '--radius-xl':   `${RADIUS.xl}px`,
  '--radius-2xl':  `${RADIUS['2xl']}px`,
  '--radius-3xl':  `${RADIUS['3xl']}px`,
  '--radius-pill': `${RADIUS.pill}px`,

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
  '--surface-muted':    '#f8f7f4',
  '--surface-soft':     '#f9fafb',
  '--border-soft':      '#e7e5e0',
  '--border-strong':    '#d6d3d1',
  '--shadow-card-xs':   '0 1px 3px rgba(0,0,0,.04)',
  '--shadow-card-sm':   '0 2px 6px rgba(0,0,0,.06)',
  '--shadow-modal':     '0 20px 60px rgba(0,0,0,0.25)',
  '--overlay-scrim':    'rgba(0,0,0,0.45)',

  /* ── Status colours ──────────────────────────────────────────────────────── */
  '--status-danger':        '#dc2626',
  '--status-danger-text':   '#991b1b',
  '--status-danger-bg':     '#fef2f2',
  '--status-danger-border': '#fecaca',
  '--status-success':       '#16a34a',
  '--status-success-text':  '#14532d',
  '--status-success-bg':    '#f0fdf4',
  '--status-success-border':'#86efac',
  '--status-warn-bg':       '#fef9c3',
  '--status-warn-border':   '#fde047',
  '--status-warn-text':     '#713f12',

  /* ── Brand action accents ────────────────────────────────────────────────── */
  '--brand-accent':       '#3d0f7a',
  '--brand-accent-hover': '#5a1fad',
  '--brand-accent-ring':  'rgba(61,15,122,.12)',

  /* ── Stage colours ───────────────────────────────────────────────────────── */
  '--stage-sales-bg':    STAGE_COLORS.sales.bg,
  '--stage-sales-light': STAGE_COLORS.sales.light,
  '--stage-sales-text':  STAGE_COLORS.sales.text,

  '--stage-designvisit-bg':    STAGE_COLORS.designvisit.bg,
  '--stage-designvisit-light': STAGE_COLORS.designvisit.light,
  '--stage-designvisit-text':  STAGE_COLORS.designvisit.text,

  '--stage-survey-bg':    STAGE_COLORS.survey.bg,
  '--stage-survey-light': STAGE_COLORS.survey.light,
  '--stage-survey-text':  STAGE_COLORS.survey.text,

  '--stage-order-bg':    STAGE_COLORS.order.bg,
  '--stage-order-light': STAGE_COLORS.order.light,
  '--stage-order-text':  STAGE_COLORS.order.text,

  '--stage-workshop-bg':    STAGE_COLORS.workshop.bg,
  '--stage-workshop-light': STAGE_COLORS.workshop.light,
  '--stage-workshop-text':  STAGE_COLORS.workshop.text,

  '--stage-packing-bg':    STAGE_COLORS.packing.bg,
  '--stage-packing-light': STAGE_COLORS.packing.light,
  '--stage-packing-text':  STAGE_COLORS.packing.text,

  '--stage-delivery-bg':    STAGE_COLORS.delivery.bg,
  '--stage-delivery-light': STAGE_COLORS.delivery.light,
  '--stage-delivery-text':  STAGE_COLORS.delivery.text,

  '--stage-installation-bg':    STAGE_COLORS.installation.bg,
  '--stage-installation-light': STAGE_COLORS.installation.light,
  '--stage-installation-text':  STAGE_COLORS.installation.text,

  '--stage-aftercare-bg':    STAGE_COLORS.aftercare.bg,
  '--stage-aftercare-light': STAGE_COLORS.aftercare.light,
  '--stage-aftercare-text':  STAGE_COLORS.aftercare.text,

  '--stage-customerservice-bg':    STAGE_COLORS.customerservice.bg,
  '--stage-customerservice-light': STAGE_COLORS.customerservice.light,
  '--stage-customerservice-text':  STAGE_COLORS.customerservice.text,

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
  '--typo-button-line-height': '1.75',

  '--typo-caption-font-size':   (TYPO.caption as { fontSize: string }).fontSize,
  '--typo-caption-font-weight': String((TYPO.caption as { fontWeight: number }).fontWeight),
  '--typo-caption-line-height': String((TYPO.caption as { lineHeight: number }).lineHeight),

  '--typo-overline-font-size':   (TYPO.overline as { fontSize: string }).fontSize,
  '--typo-overline-font-weight': String((TYPO.overline as { fontWeight: number }).fontWeight),
  '--typo-overline-line-height': '2.66',

  /* ── Spacing unit ────────────────────────────────────────────────────────── */
  '--spacing-unit': 8,
} as const;

export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      {/* Inject :root design tokens globally so vanilla pages share the same
          CSS custom properties as React islands. GlobalStyles targets the
          document <head>, not just the React subtree.  */}
      <GlobalStyles styles={{ ':root': rootTokens }} />
      <ScopedCssBaseline>{children}</ScopedCssBaseline>
    </ThemeProvider>
  );
}

export default AppThemeProvider;
