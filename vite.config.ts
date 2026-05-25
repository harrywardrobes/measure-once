import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

/*
 * Vite build for the React island that co-exists with the legacy static
 * `public/` pages. The output lands in `public/react/` so the Express
 * server keeps serving everything from one directory — no rewrite of the
 * static-asset story required.
 *
 * `npm run dev:react` proxies to the running Express app so React pages
 * can reuse the existing `/api/*` surface during development.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/react'),
  base: '/react/',
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://localhost:5000',
    },
  },
  build: {
    outDir: resolve(__dirname, 'public/react'),
    emptyOutDir: true,
    sourcemap: true,
    /*
     * Stable filenames so `admin.html` can reference `/react/main.js`
     * directly — no manifest indirection in the Express server.
     */
    rollupOptions: {
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
