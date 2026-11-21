// Downloads the pinned sidecars (server/src/upstreams/sidecars.json) into vendor/sidecars/<platform>/<id>/ for
// electron-builder's extraResources. CI runs it before packaging; `npm start` does not need it (the server
// downloads on first use into the data directory).
//   node scripts/sidecars/fetch.mjs                       current platform
//   node scripts/sidecars/fetch.mjs --platform win32-x64   one platform
//   node scripts/sidecars/fetch.mjs --all                 every platform in the manifest
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unpackEntry } from '../lib/unpack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'server', 'src', 'upstreams', 'sidecars.json'), 'utf8'));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const out = path.resolve(root, arg('--out', 'vendor/sidecars'));
const current = `${process.platform}-${process.arch}`;
const wanted = argv.includes('--all') ? null : arg('--platform', current);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const jobs = [];
for (const [id, entry] of Object.entries(manifest)) {
  for (const [platform, asset] of Object.entries(entry.platforms)) {
    if (!wanted || platform === wanted) jobs.push({ id, platform, asset });
  }
}
if (!jobs.length) {
  console.error(`no sidecar builds for ${wanted}`);
  process.exit(1);
}

let failed = 0;
for (const { id, platform, asset } of jobs) {
  const destDir = path.join(out, platform, id);
  const dest = path.join(destDir, asset.entry);
  try {
    if (fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === asset.sha256) {
      console.log(`ok   ${id} ${platform} (cached)`);
      continue;
    }
    console.log(`get  ${id} ${platform} ← ${asset.url}`);
    const res = await fetch(asset.url, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (asset.size && buf.length !== asset.size) throw new Error(`size ${buf.length} != ${asset.size}`);
    const got = sha256(buf);
    if (got !== asset.sha256) throw new Error(`sha256 ${got} != ${asset.sha256}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `cw-sidecar-${id}-`));
    try {
      const dl = path.join(tmp, 'download');
      fs.writeFileSync(dl, buf);
      let found = dl;
      if (asset.archive === 'zip' || asset.archive === 'tar.gz') {
        // PowerShell's Expand-Archive insists on a .zip name
        const packed = asset.archive === 'zip' ? `${dl}.zip` : dl;
        if (packed !== dl) fs.renameSync(dl, packed);
        found = await unpackEntry(asset.archive, packed, tmp, asset.entry, (l) => console.log(`${l.slice(0, 5)}${id} ${platform}: ${l.slice(5)}`));
      }
      if (!found || !fs.existsSync(found)) throw new Error(`no ${asset.entry} in the archive`);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(found, dest);
      fs.chmodSync(dest, 0o755);
      console.log(`ok   ${id} ${platform} → ${path.relative(root, dest)}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (e) {
    failed++;
    console.error(`FAIL ${id} ${platform}: ${e?.message ?? e}`);
  }
}
process.exit(failed ? 1 : 0);
