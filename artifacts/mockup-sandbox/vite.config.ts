import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import http from "http";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { mockupPreviewPlugin } from "./mockupPreviewPlugin";

/**
 * Vite plugin: proxy any request whose path does NOT start with /__mockup
 * (or a Vite-internal prefix) to the main Express app on port 5000.
 *
 * This means if someone's Replit preview pane is pointed at the mockup
 * sandbox port and they navigate to e.g. /customer-info/<token> or /login,
 * they get the real page instead of Vite's "wrong base URL" error page.
 */
function proxyMainAppPlugin(): import("vite").Plugin {
  const MAIN_APP_PORT = 5000;
  return {
    name: "proxy-main-app",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "/";
        // Let Vite handle its own internals and the /__mockup base path.
        if (
          url.startsWith("/__mockup") ||
          url.startsWith("/@") ||
          url.startsWith("/node_modules")
        ) {
          return next();
        }
        // Forward everything else to the main Express server.
        const options: http.RequestOptions = {
          hostname: "localhost",
          port: MAIN_APP_PORT,
          path: url,
          method: req.method,
          headers: { ...req.headers, host: `localhost:${MAIN_APP_PORT}` },
        };
        const proxy = http.request(options, (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res, { end: true });
        });
        proxy.on("error", () => {
          res.statusCode = 502;
          res.end("Main application is not running on port 5000.");
        });
        req.pipe(proxy, { end: true });
      });
    },
  };
}

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    proxyMainAppPlugin(),
    mockupPreviewPlugin(),
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
