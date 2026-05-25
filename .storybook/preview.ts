import React from 'react';
import type { Preview } from '@storybook/react';
import { AppThemeProvider } from '../src/react/AppThemeProvider';

/*
 * Storybook loads the same stylesheets the production app uses, so every
 * component renders against the real tokens defined in `public/style.css`.
 * Tailwind utilities resolve through the JIT build in `public/tailwind.css`.
 *
 * Every story is wrapped in `AppThemeProvider` so MUI components render
 * with the same theme they will see in production.
 */
import '../public/style.css';
import '../public/tailwind.css';

const preview: Preview = {
  decorators: [
    (Story) => React.createElement(AppThemeProvider, null, React.createElement(Story)),
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
