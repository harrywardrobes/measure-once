import React from 'react';
import { ThemeProvider } from '@mui/material/styles';
import ScopedCssBaseline from '@mui/material/ScopedCssBaseline';
import { theme } from './theme';

/**
 * Wraps every React mount in the shared MUI theme.
 *
 * We deliberately use `ScopedCssBaseline` rather than the global
 * `CssBaseline` because the React island co-exists with legacy vanilla
 * pages (`admin.html`, `customers.html`, …) that depend on their own
 * `public/style.css` baseline. Scoping keeps MUI normalisation contained
 * to React-mounted subtrees so we don't reset typography or margins on
 * the surrounding page.
 *
 * Every page / story should render its tree inside this provider — see
 * `src/react/README.md` for the convention.
 */
export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <ScopedCssBaseline>{children}</ScopedCssBaseline>
    </ThemeProvider>
  );
}

export default AppThemeProvider;
