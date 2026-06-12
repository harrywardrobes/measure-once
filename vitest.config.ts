import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/react/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'shared/**/*.test.{ts,tsx}'],
    alias: {
      '@': resolve(__dirname, 'src/react'),
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/react'),
    },
  },
});
