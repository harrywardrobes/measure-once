import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx|js|jsx|mdx)'],
  addons: ['@storybook/addon-essentials'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  /*
   * Mirror the font assets so `@font-face` rules in style.css resolve inside
   * Storybook. We deliberately avoid copying the whole `public/` directory
   * because the Storybook output itself lives at `public/storybook` and a
   * full copy would recurse into self (ERR_FS_CP_EINVAL).
   */
  staticDirs: [{ from: '../public/fonts', to: '/fonts' }],
  docs: { autodocs: 'tag' },
};

export default config;
