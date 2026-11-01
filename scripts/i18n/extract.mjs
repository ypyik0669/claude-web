// The translation work list: every tr() key with no English text yet, in chunks, grouped by file (strings of one
// screen end up together). Usage:
//   node scripts/i18n/extract.mjs <outDir> [chunkSize=150]    → <outDir>/todo-NN.json  [{ k, f, p }]  (k: Chinese key,
//                                                               f: file it is used in, p: its placeholders)
//   node scripts/i18n/extract.mjs --check                      → prints what is missing / unused, exit 1 when missing
// The English catalogs themselves: server/src/i18n/en.ts, web/src/i18n/en.ts, desktop/src/en.ts
// (`node scripts/i18n/merge.mjs <dir>` writes translated chunks into them).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AREAS, collectKeys } from './scan.mjs';
import { readCatalog } from './catalog.mjs';

export { readCatalog };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function missingByArea() {
  const { byArea } = collectKeys(root);
  const out = [];
  for (const area of AREAS) {
    const have = readCatalog(area);
    const used = byArea.get(area.export);
    const missing = [...used].filter(([k]) => !(k in have));
    const unused = Object.keys(have).filter((k) => !used.has(k));
    out.push({ area, used, have, missing, unused });
  }
  return out;
}

const args = process.argv.slice(2);
if (args[0] === '--check') {
  let bad = 0;
  for (const { area, missing, unused } of missingByArea()) {
    console.log(`${area.export}: ${missing.length} missing, ${unused.length} unused`);
    bad += missing.length;
  }
  process.exit(bad ? 1 : 0);
} else if (args[0] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = path.resolve(args[0]);
  const size = Number(args[1] ?? 150);
  fs.mkdirSync(out, { recursive: true });
  const rows = [];
  for (const { area, missing } of missingByArea()) {
    for (const [k, uses] of missing) rows.push({ k, f: uses[0].file, p: uses[0].params, area: area.export, pos: uses[0].pos });
  }
  rows.sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : a.pos - b.pos));
  let n = 0;
  for (let i = 0; i < rows.length; i += size) {
    n++;
    const chunk = rows.slice(i, i + size).map(({ k, f, p }) => ({ k, f, ...(p.length ? { p } : {}) }));
    fs.writeFileSync(path.join(out, `todo-${String(n).padStart(2, '0')}.json`), JSON.stringify(chunk, null, 1));
  }
  console.log(`${rows.length} keys in ${n} chunks → ${out}`);
}
