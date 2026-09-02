import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds to one self-contained index.html — src/web/server.ts serves that
// single file as-is, with no static-asset middleware of its own.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: 'dist',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 5000,
  },
  server: {
    // The built page is same-origin with /api in production (server.ts
    // serves both). In dev, forward to the real demo server so `npm run
    // dev` here talks to `npm run web` at the repo root.
    proxy: {
      '/api': {
        target: process.env.DEYCID_API_PROXY_TARGET ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
