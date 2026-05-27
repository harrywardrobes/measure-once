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
  /*
   * Vite's default publicDir is 'public' (the project root's public/
   * directory). Without this override Vite copies every application HTML,
   * JS, and CSS file into the Storybook output folder alongside the
   * Storybook build artifacts. Setting publicDir: false suppresses that
   * wholesale copy; font assets are handled above via staticDirs instead.
   */
  viteFinal: async (config) => {
    config.publicDir = false;
    return config;
  },
};

export default config;
