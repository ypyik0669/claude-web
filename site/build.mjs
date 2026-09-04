// Build the marketing site from site/page.html (a body fragment with <title>/<style> at the top).
//   node site/build.mjs
// → site/index.html         full document, references assets/ (deploy the site/ folder as-is)
// → site/dist/artifact.html the same fragment with every asset inlined as a data: URI (single file)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frag = fs.readFileSync(path.join(here, 'page.html'), 'utf8');

// everything before the first <header> is head material (title / meta / fonts / style)
const at = frag.indexOf('<header');
const head = frag.slice(0, at);
const body = frag.slice(at);
fs.writeFileSync(path.join(here, 'index.html'), `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${head}</head>\n<body>\n${body}\n</body>\n</html>\n`);

const mime = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
let total = 0;
const inlined = frag.replace(/(src=")assets\/([^"]+)(")/g, (_m, a, file, b) => {
  const p = path.join(here, 'assets', file);
  const buf = fs.readFileSync(p);
  total += buf.length;
  return `${a}data:${mime[path.extname(file)] ?? 'application/octet-stream'};base64,${buf.toString('base64')}${b}`;
});
fs.mkdirSync(path.join(here, 'dist'), { recursive: true });
fs.writeFileSync(path.join(here, 'dist', 'artifact.html'), inlined);
console.log(`site/index.html ${(fs.statSync(path.join(here, 'index.html')).size / 1024).toFixed(0)} KB · site/dist/artifact.html ${(inlined.length / 1024 / 1024).toFixed(1)} MB (assets ${(total / 1024 / 1024).toFixed(1)} MB)`);
