import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  // relative asset URLs (./assets/…): the phone shell runs the same build below a folder (app/index.html)
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../server/src/protocol.ts'),
      '@catalog': path.resolve(__dirname, '../server/src/models/catalog.ts'),
      // the phone shell's channel code (web-standard APIs only); index.ts, never the core's tests (they use node:*)
      '@anywhere': path.resolve(__dirname, '../server/src/remote/anywhere/core/index.ts'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/ws': { target: 'ws://127.0.0.1:3090', ws: true }, '/api': 'http://127.0.0.1:3090' },
  },
  build: { outDir: 'dist', sourcemap: false },
  test: { environment: 'node' },
} as any);
