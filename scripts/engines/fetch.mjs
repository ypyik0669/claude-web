// Downloads the bundled Magpie / CLIProxyAPI binaries into vendor/engines/<platform>/<id>/ for
// electron-builder's extraResources. A packaged app then starts them without downloading anything; a dev / browser
// server uses the same folder when it exists, and only downloads into its data directory when it does not.
//   node scripts/engines/fetch.mjs                       current platform
//   node scripts/engines/fetch.mjs --platform win32-x64  one platform
//   node scripts/engines/fetch.mjs --all                 every platform in the pinned manifest
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unpackEntry } from '../lib/unpack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'server/src/engines/manifests/bundled.json'), 'utf8'));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const out = path.resolve(root, arg('--out', 'vendor/engines'));
const current = `${process.platform}-${process.arch}`;
const wanted = argv.includes('--all') ? null : arg('--platform', current);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');


const jobs = [];
for (const [id, entry] of Object.entries(manifest)) {
  for (const [platform, asset] of Object.entries(entry.platforms)) {
    if (!wanted || platform === wanted) jobs.push({ id, version: entry.version, platform, asset });
  }
}
if (!jobs.length) {
  console.error(`no bundled engine builds for ${wanted}`);
  process.exit(1);
}

let failed = 0;
for (const { id, version, platform, asset } of jobs) {
  const destDir = path.join(out, platform, id);
  const dest = path.join(destDir, asset.entry);
  const versionFile = path.join(destDir, 'version.txt');
  // asset.sha256 is the archive's hash; the extracted executable has its own, recorded for the cache check
  const entryFile = path.join(destDir, 'entry.sha256');
  try {
    if (fs.existsSync(dest) && fs.existsSync(entryFile) && fs.existsSync(versionFile)
      && fs.readFileSync(versionFile, 'utf8').trim() === version
      && sha256(fs.readFileSync(dest)) === fs.readFileSync(entryFile, 'utf8').trim()) {
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `cw-engine-${id}-`));
    try {
      const dl = path.join(tmp, 'download');
      fs.writeFileSync(dl, buf);
      let found = dl;
      if (asset.archive === 'zip' || asset.archive === 'tar.gz') {
        const packed = asset.archive === 'zip' ? `${dl}.zip` : `${dl}.tar.gz`;
        fs.renameSync(dl, packed);
        const extracted = path.join(tmp, 'x');
        fs.mkdirSync(extracted, { recursive: true });
        found = await unpackEntry(asset.archive, packed, extracted, asset.entry, (l) => console.log(`${l.slice(0, 5)}${id} ${platform}: ${l.slice(5)}`));
      }
      if (!found || !fs.existsSync(found)) throw new Error(`no ${asset.entry} in the package`);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(found, dest);
      fs.chmodSync(dest, 0o755);
      fs.writeFileSync(versionFile, version + '\n');
      fs.writeFileSync(entryFile, sha256(fs.readFileSync(dest)) + '\n');
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
