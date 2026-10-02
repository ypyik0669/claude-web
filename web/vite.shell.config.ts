// The phone shell (web/src/shell/): its own small build into dist-shell/, deployed to GitHub Pages. The page
// (shell.html, written out as index.html) and the service worker (sw.js: a classic script built separately, so it
// shares no chunk with the page and its name never changes). The service worker precaches the page's files, which
// it gets as a list at build time; a hash of their contents names its cache, so any change to the page changes sw.js.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, defineConfig, type Plugin } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(root, 'dist-shell');
const alias = {
  '@anywhere': path.join(root, '../server/src/remote/anywhere/core/index.ts'),
  '@shared': path.join(root, '../server/src/protocol.ts'),
};

function filesIn(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesIn(dir, r));
    else out.push(r);
  }
  return out;
}

function shellBuild(): Plugin {
  return {
    name: 'cw-shell',
    apply: 'build',
    async closeBundle() {
      fs.renameSync(path.join(outDir, 'shell.html'), path.join(outDir, 'index.html'));
      const files = filesIn(outDir).filter((f) => f !== 'sw.js').sort();
      const h = createHash('sha256');
      for (const f of files) h.update(f).update('\0').update(fs.readFileSync(path.join(outDir, f)));
      await build({
        configFile: false,
        root,
        logLevel: 'warn',
        publicDir: false,
        resolve: { alias },
        define: { __SHELL_FILES__: JSON.stringify(files), __SHELL_BUILD__: JSON.stringify(h.digest('hex').slice(0, 16)) },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          sourcemap: false,
          minify: true,
          lib: { entry: path.join(root, 'src/shell/sw.ts'), formats: ['iife'], name: 'cwShellWorker', fileName: () => 'sw.js' },
        },
      });
    },
  };
}

export default defineConfig({
  root,
  base: './',
  // web/public is the app's (its own sw.js, icons): none of it belongs to the shell
  publicDir: false,
  resolve: { alias },
  plugins: [shellBuild()],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    // one page, one chunk: no preload helper needed
    modulePreload: false,
    rollupOptions: { input: path.join(root, 'shell.html') },
  },
});
