import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from '../files/service.js';

/**
 * A `--settings` file for one CLI process (see user-env `settingsOverride`). A file, not the inline JSON the SDK would
 * put on the command line: the override can hold the provider's key, and command lines are readable by other users'
 * `ps` on macOS / Linux. Only the owner can read it (0600 in a 0700 folder; the profile's ACL on Windows), it lives
 * as long as the process (the CLI may read settings again later), and files of a server that is gone are swept.
 * Named `<server pid>-<uuid>.json`: two servers may share the data folder.
 */
export interface FlagSettings { file: string; dispose(): void }

export function flagSettingsDir(): string {
  return path.join(dataDir(), 'runtime', 'flag-settings');
}

let swept = false;

export function writeFlagSettings(env: Record<string, string>, dir = flagSettingsDir()): FlagSettings {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!swept) { swept = true; sweepFlagSettings(dir); }
  const file = path.join(dir, `${process.pid}-${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ env }), { mode: 0o600 });
  let done = false;
  return {
    file,
    dispose() {
      if (done) return;
      done = true;
      try { fs.rmSync(file, { force: true }); } catch { /* swept later */ }
    },
  };
}

/** Remove the files of servers that are no longer running. */
export function sweepFlagSettings(dir = flagSettingsDir()): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const pid = Number(/^(\d+)-/.exec(n)?.[1]);
    if (!pid || pid === process.pid || alive(pid)) continue;
    try { fs.rmSync(path.join(dir, n), { force: true }); } catch { /* still in use */ }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM'; // exists, someone else's
  }
}
