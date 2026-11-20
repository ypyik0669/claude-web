// 网吧开门's script (src/features/opening/cafe/): three.js and the cafe scene in one classic script,
// dist/opening/cafe-opening.js, built after the app (`npm run build -w web` runs it). The desktop opening page loads it
// from the shell's own scheme before the server is up (desktop/src/opening-pack.ts `cafeScriptPath`); 试放一次 and the
// cards' previews load it from the app's server. It shares nothing with the app's chunks: a fixed name, no hash.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.join(root, '../server/src/protocol.ts'),
      '@i18n': path.join(root, '../server/src/i18n/core.ts'),
      '@i18n-en': path.join(root, '../server/src/i18n/en.ts'),
      '@': path.join(root, 'src'),
    },
  },
  define: { 'process.env.NODE_ENV': '"production"' },
  publicDir: false,
  build: {
    outDir: path.join(root, 'dist', 'opening'),
    // the app was just built into dist/: this only adds its own folder
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: path.join(root, 'src/features/opening/cafe/entry.ts'),
      formats: ['iife'],
      name: 'cwCafeOpeningBundle',
      fileName: () => 'cafe-opening.js',
    },
  },
});
