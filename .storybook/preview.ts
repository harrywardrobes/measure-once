import type { Preview } from '@storybook/react';

/*
 * Storybook loads the same stylesheets the production app uses, so every
 * component renders against the real tokens defined in `public/style.css`.
 * Tailwind utilities resolve through the JIT build in `public/tailwind.css`.
 */
import '../public/style.css';
import '../public/tailwind.css';

const preview: Preview = {
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
