// electron-builder afterPack: restore +x on native helpers inside app.asar.unpacked (macOS / Linux).
// npm tarballs sometimes lose the mode bit, and node-pty then fails with "posix_spawnp failed".
const fs = require('node:fs');
const path = require('node:path');

const EXEC = [/[\/]spawn-helper$/, /[\/]claude-agent-sdk-[^\/]+[\/]claude$/, /[\/]ripgrep[\/][^\/]+[\/]rg$/, /[\/]bin[\/]rg$/];

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXEC.some((r) => r.test(p))) out.push(p);
  }
}

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName === 'win32') return;
  const app = ctx.electronPlatformName === 'darwin'
    ? path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app.asar.unpacked')
    : path.join(ctx.appOutDir, 'resources', 'app.asar.unpacked');
  const files = [];
  walk(app, files);
  for (const f of files) fs.chmodSync(f, 0o755);
  console.log(`  • after-pack: chmod +x ${files.length} helper binaries`);
};
