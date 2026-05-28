import { createTheme, type Theme } from '@mui/material/styles';

/**
 * Shared MUI theme for the React island.
 *
 * This file is the canonical definition of Measure Once's design tokens.
 * `AppThemeProvider` (src/react/AppThemeProvider.tsx) derives a `GlobalStyles`
 * `:root` injection from the constants below so every non-React page that uses
 * `var(--orchid)`, `var(--paper)`, `var(--stage-sales-bg)`, etc. stays in sync
 * automatically — no manual mirror in `public/app-styles.css` needed.
 *
 * The Design System tab on the admin page introspects this object to
 * render its swatches / typography / radius cards, so anything added to
 * `palette.brand`, `palette.stage`, or `shape.radius` automatically shows
 * up on the page without further wiring.
 *
 * When adding a new token: update BRAND_COLORS / STAGE_COLORS / RADIUS below.
 * AppThemeProvider.tsx derives its rootTokens entries automatically by looping
 * over those constants, so no manual --<name> entry is needed there.
 * public/tokens.css is generated automatically by scripts/generate-tokens-css.mjs
 * (runs as part of every build) — no manual edit needed there either.
 */

// ── Brand colour scales ────────────────────────────────────────────────
export const BRAND_COLORS = {
  paper:           '#F6F1E7',
  paperDeep:       '#EDE5D4',
  stone:           '#D9D2C2',
  stoneLight:      '#E8E3D8',
  stoneDeep:       '#B8AE99',
  orchid:          '#8B2BFF',
  orchidDeep:      '#6A12D9',
  orchidPress:     '#7a1fe0',
  orchidSoft:      '#A968FF',
  orchidTint:      '#F3EAFF',
  orchidTintDeep:  '#EDE8FF',
  orchidTintHover: '#E0D8FF',
  plum:            '#200842',
  plumLight:       '#3d0f7a',
  pageBackground:  '#f8f7f4',
  walnut:          '#8A5A3B',
  ink1:            '#141413',
  ink2:            '#3C3A34',
  ink3:            '#6B6860',
  ink4:            '#97927F',
} as const;

// ── Neutral grey scale (Tailwind-compatible, for UI surface colours) ───
export const NEUTRAL_COLORS = {
  50:  '#f9fafb',
  100: '#f3f4f6',
  200: '#e5e7eb',
  300: '#d1d5db',
  400: '#9ca3af',
  500: '#6b7280',
  600: '#4b5563',
  700: '#374151',
  800: '#1f2937',
  900: '#111827',
} as const;

// ── Status pill colours ────────────────────────────────────────────────
export const STATUS_COLORS: Record<string, { bg: string; text: string; border?: string }> = {
  neutral:      { bg: NEUTRAL_COLORS[100],  text: NEUTRAL_COLORS[700] },
  warning:      { bg: '#fef3c7', text: '#92400e', border: '#fbbf24' },
  warningLight: { bg: '#fffbeb', text: '#92400e' },
  warningActive: { bg: '#fde68a', text: '#92400e' },
  error:        { bg: '#fee2e2', text: '#991b1b', border: '#fca5a5' },
  errorLight:   { bg: '#fef2f2', text: '#991b1b' },
  chunkError:   { bg: '#fff7ed', text: '#9a3412' },
  success:      { bg: '#dcfce7', text: '#166534' },
  successLight: { bg: '#f0fdf4', text: '#166534' },
  successDeep:  { bg: '#d1fae5', text: '#065f46' },
  info:         { bg: '#dbeafe', text: '#1d4ed8' },
  infoLight:    { bg: '#eff6ff', text: '#1e40af' },
  violet:       { bg: '#ede9fe', text: '#5b21b6' },
};

// ── Calendar event type colours ────────────────────────────────────────
export const CALENDAR_EVENT_COLORS: Record<string, { label: string; color: string }> = {
  design:       { label: 'Design visit',  color: '#3b82f6' },
  survey:       { label: 'Survey',        color: '#f59e0b' },
  installation: { label: 'Installation', color: '#10b981' },
  remedial:     { label: 'Remedial',      color: '#ef4444' },
  workshop:     { label: 'Workshop time', color: '#8b5cf6' },
  other:        { label: 'Other',         color: NEUTRAL_COLORS[500] },
};

// ── Third-party provider brand colours ─────────────────────────────────
export const PROVIDER_COLORS = {
  google:          '#4285F4',
  microsoft:       '#0078D4',
  apple:           '#1C1C1E',
  whatsApp:        '#25D366',
  quickBooks:      '#2ca01c',
  quickBooksHover: '#208015',
} as const;

// ── Stage / semantic colours (lead-status pills, nav, badges) ──────────
export interface StageColor { bg: string; light: string; text: string; }

export const STAGE_COLORS: Record<string, StageColor> = {
  sales:           { bg: '#8B2BFF', light: '#F3EAFF', text: '#6A12D9' },
  designvisit:     { bg: '#0d9488', light: '#ccfbf1', text: '#0f766e' },
  survey:          { bg: '#d97706', light: '#fef3c7', text: '#b45309' },
  order:           { bg: '#2563eb', light: '#dbeafe', text: '#1d4ed8' },
  workshop:        { bg: '#dc2626', light: '#fee2e2', text: '#b91c1c' },
  packing:         { bg: '#059669', light: '#d1fae5', text: '#047857' },
  delivery:        { bg: '#0891b2', light: '#cffafe', text: '#0e7490' },
  installation:    { bg: '#8A5A3B', light: '#fdf6ee', text: '#5c3820' },
  aftercare:       { bg: '#200842', light: '#ede0ff', text: '#3d0f7a' },
  customerservice: { bg: '#475569', light: '#f1f5f9', text: '#1e293b' },
};

// ── Radius scale (drives --radius-* CSS custom properties via AppThemeProvider) ─
export const RADIUS = {
  xs:   2,
  sm:   4,
  md:   6,
  lg:   8,
  xl:   10,
  '2xl': 12,
  '3xl': 14,
  pill: 999,
} as const;

// ── MUI module augmentation ────────────────────────────────────────────
declare module '@mui/material/styles' {
  interface Palette {
    brand: typeof BRAND_COLORS;
    stage: Record<string, StageColor>;
  }
  interface PaletteOptions {
    brand?: typeof BRAND_COLORS;
    stage?: Record<string, StageColor>;
  }
  interface Theme {
    radius: typeof RADIUS;
  }
  interface ThemeOptions {
    radius?: typeof RADIUS;
  }
}

const FONT_FAMILY = "'Open Sans', system-ui, -apple-system, Segoe UI, sans-serif";

export const theme: Theme = createTheme({
  palette: {
    mode: 'light',
    primary:   { main: BRAND_COLORS.orchid, dark: BRAND_COLORS.orchidDeep, light: BRAND_COLORS.orchidSoft, contrastText: '#ffffff' },
    secondary: { main: BRAND_COLORS.plum, contrastText: '#ffffff' },
    background: { default: BRAND_COLORS.paper, paper: '#ffffff' },
    text: { primary: BRAND_COLORS.ink1, secondary: BRAND_COLORS.ink3, disabled: BRAND_COLORS.ink4 },
    divider: BRAND_COLORS.stone,
    brand: BRAND_COLORS,
    stage: STAGE_COLORS,
  },
  shape: {
    borderRadius: RADIUS.lg,
  },
  radius: RADIUS,
  typography: {
    fontFamily: FONT_FAMILY,
    h1:       { fontFamily: FONT_FAMILY, fontWeight: 700, fontSize: '2rem',     lineHeight: 1.2 },
    h2:       { fontFamily: FONT_FAMILY, fontWeight: 700, fontSize: '1.5rem',   lineHeight: 1.25 },
    h3:       { fontFamily: FONT_FAMILY, fontWeight: 700, fontSize: '1.25rem',  lineHeight: 1.3 },
    h4:       { fontFamily: FONT_FAMILY, fontWeight: 700, fontSize: '1.125rem', lineHeight: 1.35 },
    h5:       { fontFamily: FONT_FAMILY, fontWeight: 700, fontSize: '1rem',     lineHeight: 1.4 },
    h6:       { fontFamily: FONT_FAMILY, fontWeight: 700, fontSize: '0.875rem', lineHeight: 1.45 },
    subtitle1:{ fontFamily: FONT_FAMILY, fontWeight: 600, fontSize: '0.95rem',  lineHeight: 1.5 },
    subtitle2:{ fontFamily: FONT_FAMILY, fontWeight: 600, fontSize: '0.82rem',  lineHeight: 1.5 },
    body1:    { fontFamily: FONT_FAMILY, fontWeight: 400, fontSize: '0.95rem',  lineHeight: 1.55 },
    body2:    { fontFamily: FONT_FAMILY, fontWeight: 400, fontSize: '0.82rem',  lineHeight: 1.55 },
    button:   { fontFamily: FONT_FAMILY, fontWeight: 600, fontSize: '0.88rem',  lineHeight: 1.75, textTransform: 'none' },
    caption:  { fontFamily: FONT_FAMILY, fontWeight: 400, fontSize: '0.72rem',  lineHeight: 1.4 },
    overline: { fontFamily: FONT_FAMILY, fontWeight: 700, fontSize: '0.68rem',  lineHeight: 2.66, letterSpacing: '0.08em', textTransform: 'uppercase' },
  },
  components: {
    MuiButton: {
      defaultProps: {
        disableElevation: true,
        variant: 'outlined',
      },
    },
  },
});

export default theme;
