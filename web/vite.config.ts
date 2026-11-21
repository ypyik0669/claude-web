import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { MAX_ENTRY_BYTES } from './src/shell/assets';

export default defineConfig({
  // relative asset URLs (./assets/…): the phone shell runs the same build below a folder (app/index.html)
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
  }, {
    // review X1: the app's entry chunk (boot-*.js) is a first-screen file — over the relay one past MAX_ENTRY_BYTES never
    // arrives. web/dist/index.html is the phone shell's afterwards (build:shell), so its own check never sees this one
    name: 'boot-chunk-size',
    apply: 'build',
    generateBundle(_o: unknown, bundle: Record<string, { type: string; isEntry?: boolean; fileName: string; code?: string }>) {
      for (const c of Object.values(bundle)) {
        if (c.type !== 'chunk' || !/^assets\/boot-[^/]+\.js$/.test(c.fileName)) continue;
        const bytes = Buffer.byteLength(c.code ?? '');
        if (bytes >= MAX_ENTRY_BYTES) (this as any).error(`${c.fileName} is ${bytes} bytes — first-screen files must stay under ${MAX_ENTRY_BYTES} (lazy-load a dialog or panel)`);
      }
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
      // the phone shell's channel code (web-standard APIs only); index.ts, never the core's tests (they use node:*)
      '@anywhere': path.resolve(__dirname, '../server/src/remote/anywhere/core/index.ts'),
      '@characters': path.resolve(__dirname, '../server/src/characters/core/index.ts'),
      // the character themes' pure core: the server checks a theme skill's drafts with it
      '@themes': path.resolve(__dirname, '../server/src/themes/core/index.ts'),
      // 开场动画: the desktop shell's opening page (it imports nothing), for 设置 › 外观 › 试放一次
      '@opening': path.resolve(__dirname, '../desktop/src/opening.ts'),
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
  // the store tests and the cards' tests import half the app in beforeAll (registry → every card → the store, the
  // model menu…): 11–15 s alone, past 30 s next to the full parallel run on a busy machine (2026-11-21: ego-card and
  // registry timed out there and passed alone; source-bytes, 0.5 s alone, took 45 s in the same run) — both get more room
  test: {
    environment: 'node', testTimeout: 90_000, hookTimeout: 120_000,
    // temp agent worktrees / generated artifacts must not be picked up as a second copy of the suite
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-shell/**', '**/.claude/**', '**/.superpowers/**'],
  },
} as any);
