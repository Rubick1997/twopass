import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The app is built to dist/ui and served by `twopass ui` (src/ui/server.ts).
// `pnpm dev:ui` runs this dev server and proxies /api to `twopass ui --no-open` on the default port.
// changeOrigin makes the proxied Host header 127.0.0.1:4777, which the server's Host check accepts.
// The write endpoints also check Origin, so a POST from this dev page (and only from it) gets the
// server's own origin. Other sites still can't send JSON here without a preflight the server refuses.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/ui', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4777',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const origin = req.headers.origin;
            if (origin && /^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin)) proxyReq.setHeader('origin', 'http://127.0.0.1:4777');
          });
        },
      },
    },
  },
});
