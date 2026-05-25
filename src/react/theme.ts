import { createTheme, type Theme } from '@mui/material/styles';

/**
 * Shared MUI theme for the React island.
 *
 * This file is the canonical definition of Measure Once's design tokens.
 * The hex values in `public/style.css` `:root` are kept in lockstep with
 * the constants below so legacy (non-React) pages stay visually identical
 * to the MUI components on the Design System tab. If you change a value
 * here, mirror it in `:root` of `public/style.css` (and vice-versa).
 *
 * The Design System tab on the admin page introspects this object to
 * render its swatches / typography / radius cards, so anything added to
 * `palette.brand`, `palette.stage`, or `shape.radius` automatically shows
 * up on the page without further wiring.
 */

// ── Brand colour scales ────────────────────────────────────────────────
export const BRAND_COLORS = {
  paper:      '#F6F1E7',
  paperDeep:  '#EDE5D4',
  stone:      '#D9D2C2',
  stoneLight: '#E8E3D8',
  stoneDeep:  '#B8AE99',
  orchid:     '#8B2BFF',
  orchidDeep: '#6A12D9',
  orchidSoft: '#A968FF',
  orchidTint: '#F3EAFF',
  plum:       '#200842',
  walnut:     '#8A5A3B',
  ink1:       '#141413',
  ink2:       '#3C3A34',
  ink3:       '#6B6860',
  ink4:       '#97927F',
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

// ── Radius scale (matches --radius-* in public/style.css) ──────────────
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
    button:   { fontFamily: FONT_FAMILY, fontWeight: 600, fontSize: '0.88rem',  textTransform: 'none' },
    caption:  { fontFamily: FONT_FAMILY, fontWeight: 400, fontSize: '0.72rem',  lineHeight: 1.4 },
    overline: { fontFamily: FONT_FAMILY, fontWeight: 700, fontSize: '0.68rem',  letterSpacing: '0.08em', textTransform: 'uppercase' },
  },
});

export default theme;
