// Unpacking a pinned download for the build (scripts/sidecars/fetch.mjs, scripts/engines/fetch.mjs): the archive's
// SHA256 was checked before this runs.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const opts = { windowsHide: true, timeout: 120_000 };
// Windows: `tar` on PATH is Git's GNU tar (a `C:\…` path reads as a remote host, and it has no zip); System32's
// tar.exe is bsdtar, which reads zip as well
const sysTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

async function unpack(archive, file, dest) {
  if (archive === 'zip') {
    if (process.platform === 'win32') {
      const q = (s) => `'${s.replace(/'/g, "''")}'`;
      const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${q(file)} -DestinationPath ${q(dest)} -Force`], opts);
      return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    }
    await exec('unzip', ['-o', file, '-d', dest], opts);
    return '';
  }
  await exec(process.platform === 'win32' ? sysTar : 'tar', ['-xzf', file, '-C', dest], opts);
  return '';
}

/** The entry at the top of `dir` or one folder down (an archive with a top folder), else null. */
export function locate(dir, entry) {
  const top = path.join(dir, entry);
  if (fs.existsSync(top)) return top;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const inner = path.join(dir, d.name, entry);
    if (d.isDirectory() && fs.existsSync(inner)) return inner;
  }
  return null;
}

/** What `dir` holds, two levels deep, with sizes: for the message when the entry is missing. */
export function listing(dir) {
  const out = [];
  const size = (p) => { try { return fs.statSync(p).size; } catch { return '?'; } };
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) { out.push(`${d.name} (${size(path.join(dir, d.name))})`); continue; }
    out.push(`${d.name}/`);
    for (const e of fs.readdirSync(path.join(dir, d.name))) out.push(`${d.name}/${e} (${size(path.join(dir, d.name, e))})`);
  }
  return out.join(', ') || 'nothing';
}

/** Defender's latest detections: a binary taken away right after it was unpacked looks like a missing one. */
async function defenderSays() {
  try {
    const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-MpThreatDetection | Sort-Object InitialDetectionTime -Descending | Select-Object -First 3 InitialDetectionTime,ThreatID,ActionSuccess,Resources | Format-List | Out-String -Width 300'], opts);
    return r.stdout.trim() || 'none';
  } catch (e) {
    return `not asked (${e?.message ?? e})`;
  }
}

/**
 * Unpacks `packed` into `dir` and returns where `entry` is. Windows: when Expand-Archive leaves the entry missing it says
 * what was there (and what Defender last caught), then tar.exe tries — 2026-11-21, on GitHub's windows-2025 image of
 * 11-16, Expand-Archive exited 0 without the workbuddy sidecar's wb2api.exe, twice (the same archive unpacked on 11-19).
 */
export async function unpackEntry(archive, packed, dir, entry, log = console.log) {
  const said = await unpack(archive, packed, dir);
  let found = locate(dir, entry);
  if (!found && archive === 'zip' && process.platform === 'win32') {
    log(`warn Expand-Archive left no ${entry}: ${listing(dir)}${said ? ` — it said: ${said}` : ''}`);
    log(`warn Defender's latest detections: ${await defenderSays()}`);
    await exec(sysTar, ['-xf', packed, '-C', dir], opts);
    found = locate(dir, entry);
    log(found ? `ok   tar.exe unpacked ${entry}` : `warn tar.exe left no ${entry} either: ${listing(dir)}`);
  }
  if (!found) throw new Error(`no ${entry} in the archive (unpacked: ${listing(dir)})`);
  return found;
}
