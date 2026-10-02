// The phone shell (web/src/shell/): its own small build into dist-shell/, deployed to GitHub Pages. The page
// (shell.html, written out as index.html) and the service worker (sw.js: a classic script built separately, so it
// shares no chunk with the page and its name never changes). The service worker precaches the page's files, which
// it gets as a list at build time; a hash of their contents names its cache, so any change to the page changes sw.js.
// It also gets each file's sha256, and serves a cached copy only when it still has those bytes (src/shell/integrity.ts).
// The app's first-screen files must stay under the slow relay's response cap: the build fails when one passes it.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, defineConfig, type Plugin } from 'vite';
// relative imports only (the config is bundled without the aliases): assets.ts has none at run time
import { MAX_ENTRY_BYTES, oversizedEntries } from './src/shell/assets';
import { PAGE_KEY } from './src/shell/integrity';

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

/**
 * The app (web/dist, built just before by `npm run build -w web`): each first-screen file under the slow relay's cap,
 * or this build fails. The same limit as shell/assets.test.ts, which CI cannot run (it tests before it builds). A
 * shell built on its own, without the app, has nothing to check.
 */
function checkAppEntries(): void {
  const dist = path.join(root, 'dist');
  const index = path.join(dist, 'index.html');
  if (!fs.existsSync(index)) {
    console.warn('[shell] web/dist is not built: the app\'s first-screen file sizes are not checked');
    return;
  }
  const big = oversizedEntries(fs.readFileSync(index, 'utf8'), (p) => (fs.existsSync(path.join(dist, p)) ? fs.statSync(path.join(dist, p)).size : 0));
  if (big.length) {
    throw new Error(
      `app first-screen files of ${MAX_ENTRY_BYTES} bytes or more: ${big.map((b) => `${b.path} (${b.bytes})`).join(', ')}. ` +
        'Over the slow relay the PC refuses a response over 2 MiB, so a phone reached only that way could never open this version: split the entry.',
    );
  }
}

function shellBuild(): Plugin {
  return {
    name: 'cw-shell',
    apply: 'build',
    buildStart() {
      checkAppEntries();
    },
    async closeBundle() {
      fs.renameSync(path.join(outDir, 'shell.html'), path.join(outDir, 'index.html'));
      const files = filesIn(outDir).filter((f) => f !== 'sw.js').sort();
      const h = createHash('sha256');
      const hashes: Record<string, string> = {};
      for (const f of files) {
        const bytes = fs.readFileSync(path.join(outDir, f));
        h.update(f).update('\0').update(bytes);
        hashes[f] = createHash('sha256').update(bytes).digest('hex');
      }
      // the folder's own address is precached too, and is the page
      hashes[PAGE_KEY] = hashes['index.html'];
      await build({
        configFile: false,
        root,
        logLevel: 'warn',
        publicDir: false,
        resolve: { alias },
        define: {
          __SHELL_FILES__: JSON.stringify(files),
          __SHELL_BUILD__: JSON.stringify(h.digest('hex').slice(0, 16)),
          __SHELL_HASHES__: JSON.stringify(hashes),
        },
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
