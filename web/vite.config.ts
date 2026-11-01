import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  // relative asset URLs (./assets/…)
  base: './',
  plugins: [react(), {
    // the same CSP the server sends with the built worker (server/src/index.ts BACKDROP_WORKER_CSP): in dev the backdrop
    // worker is /src/themes/backdrop-worker.ts?worker_file…
    name: 'backdrop-worker-csp',
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: any) => {
        if (String(req.url ?? '').includes('backdrop-worker')) res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-eval'");
        next();
      });
    },
  }],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../server/src/protocol.ts'),
      '@catalog': path.resolve(__dirname, '../server/src/models/catalog.ts'),
      // the account's 200K / 1M picks and the compaction point (A7), shared with the session runner
      '@account-window': path.resolve(__dirname, '../server/src/models/account-window.ts'),
      '@i18n': path.resolve(__dirname, '../server/src/i18n/core.ts'),
      // the server's English catalog: a dynamic import (i18n/index.ts `loadEnglish`), hence a name of its own
      '@i18n-en': path.resolve(__dirname, '../server/src/i18n/en.ts'),
      '@errors': path.resolve(__dirname, '../server/src/errors/explain.ts'),
      '@characters': path.resolve(__dirname, '../server/src/characters/core/index.ts'),
      // the character themes' pure core: the server checks a theme skill's drafts with it
      '@themes': path.resolve(__dirname, '../server/src/themes/core/index.ts'),
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
  // the source-scanning tests (i18n coverage, wording) read every file: seconds each, more next to a full parallel run;
  // the store tests import the whole store in beforeAll — same budget for the hooks
  test: {
    environment: 'node', testTimeout: 30_000, hookTimeout: 30_000,
    // temp agent worktrees / generated artifacts must not be picked up as a second copy of the suite
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', '**/.superpowers/**'],
  },
} as any);
