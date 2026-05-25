import { createTheme, type Theme } from '@mui/material/styles';

/**
 * Shared MUI theme for the React island.
 *
 * Intentionally close to MUI defaults — refining the palette / typography
 * to match the Measure Once brand is a later task. Keeping it minimal now
 * means new pages can adopt MUI without inheriting half-baked overrides.
 *
 * A few small choices we *do* make:
 *   - `typography.fontFamily` matches the rest of the app (`Open Sans`)
 *     so MUI components don't look like a foreign import.
 *   - `shape.borderRadius` aligns with the existing `--radius-md` token
 *     so MUI cards/buttons sit alongside legacy `.card` surfaces without
 *     a jarring radius mismatch.
 */
export const theme: Theme = createTheme({
  typography: {
    fontFamily: "'Open Sans', system-ui, -apple-system, Segoe UI, sans-serif",
  },
  shape: {
    borderRadius: 8,
  },
});

export default theme;
