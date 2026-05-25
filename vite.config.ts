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
 *
 * Bundle strategy
 * ───────────────
 * manualChunks splits third-party code into stable, separately-cacheable
 * files. Page components are lazy-imported in main.tsx so each page only
 * downloads the chunk(s) it actually mounts. The always-loaded entry
 * (main.js) therefore contains only the mount-detection runtime and the
 * small shared UI shell (GlobalHeader, BottomNav, PageHeadingPanel,
 * AppThemeProvider, IslandErrorBoundary).
 *
 * Always-loaded chunks (every page, confirmed via bundle analysis):
 *   main.js           mount detection + shell UI    ~8 kB gzip
 *   vendor            react + react-dom + @mui/*   ~160 kB gzip
 *   vendor-mui-icons  icons used by GlobalHeader    ~5 kB gzip
 *                     and BottomNav (always present)
 *                     ─────────────────────────────────────────
 *                     TOTAL always-loaded          ~173 kB gzip
 *
 * Lazy chunks (downloaded only when needed):
 *   vendor-zxcvbn     zxcvbn password-strength library (~819 kB / 398 kB
 *                     gzip). Kept in its own named chunk for cacheability.
 *                     Never preloaded by main.js. Loaded on demand inside
 *                     ProfilePage via loadZxcvbn() — fires only when the
 *                     user types into a password field.
 *   chunks/<page>-*   one chunk per lazily-imported page component
 *                     (Rollup creates these automatically from React.lazy()
 *                     calls in main.tsx; no manual grouping needed)
 *   everything else   node_modules Rollup doesn't recognise above are split
 *                     automatically
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
     * zxcvbn (~819 kB minified) is dynamically imported only on the profile
     * page when the user types a password — it never blocks initial page
     * load. Raise the warning limit to acknowledge this one known-large
     * lazy chunk rather than suppress a meaningful signal for new regressions.
     */
    chunkSizeWarningLimit: 850,
    /*
     * Stable filenames so `admin.html` can reference `/react/main.js`
     * directly — no manifest indirection in the Express server.
     */
    rollupOptions: {
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;

          // zxcvbn is large; give it its own named chunk so it's clearly
          // identifiable and doesn't get bundled with the vendor baseline.
          if (id.includes('node_modules/zxcvbn')) {
            return 'vendor-zxcvbn';
          }

          // MUI icons are large and tree-shaken; keep them in their own
          // chunk so adding/removing an icon doesn't bust the core vendor
          // bundle.
          if (id.includes('/@mui/icons-material/')) {
            return 'vendor-mui-icons';
          }

          // React runtime + MUI core + Emotion are merged into one chunk.
          // MUI imports React internally, so splitting them creates Rollup
          // circular-chunk warnings; keeping them together avoids that and
          // still gives long-lived caching for this stable group.
          if (
            id.includes('/react-dom/') ||
            id.includes('/react/') ||
            id.includes('/scheduler/') ||
            id.includes('/@mui/') ||
            id.includes('/@emotion/')
          ) {
            return 'vendor';
          }

          // All other node_modules: let Rollup split them automatically.
          return undefined;
        },
      },
    },
  },
});
