import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { preloadFile } from './spawn-guard.js';

/**
 * The desktop build runs ccb / npm-shimmed agents as `electron.exe` with ELECTRON_RUN_AS_NODE=1 and our
 * guard as a `--require` preload (agents/resolve.ts nodeRuntime()). This drives the real Electron binary the
 * same way. Skipped when there is no Electron that can start in node mode (not installed, or a CI box
 * without its shared libraries).
 */
function electronBinary(): string | null {
  try {
    const p = createRequire(path.resolve(__dirname, '../../../package.json'))('electron') as unknown;
    if (typeof p !== 'string' || !fs.existsSync(p)) return null;
    const r = spawnSync(p, ['-e', 'process.stdout.write(String(process.versions.electron))'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    return r.status === 0 && /^\d+\./.test(r.stdout) ? p : null;
  } catch {
    return null;
  }
}
const electron = electronBinary();

describe.skipIf(!electron)('spawn guard under Electron-as-node (--require preload)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-guard-electron-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('an ESM script run by electron.exe gets windowsHide on its spawns, named imports included', () => {
    const pre = preloadFile(path.join(dir, 'runtime'))!;
    const main = path.join(dir, 'agent-main.mjs');
    // like ccb: ESM, `import { … } from 'child_process'` bound before any of its code runs
    fs.writeFileSync(main, [
      "import { execFileSync, spawnSync } from 'node:child_process';",
      "import fs from 'node:fs';",
      "fs.writeFileSync(process.argv[2], JSON.stringify({ electron: process.versions.electron ?? null }));",
      "execFileSync(process.execPath, ['-e', '0'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });",
      "spawnSync(process.execPath, ['-e', '0'], { windowsHide: false, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });",
    ].join('\n'));
    const log = path.join(dir, 'spawn.jsonl');
    const info = path.join(dir, 'info.json');
    const r = spawnSync(electron!, ['--require', pre, main, info], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CW_SPAWN_LOG: '1', CW_SPAWN_LOG_FILE: log },
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(info, 'utf8')).electron).toMatch(/^\d+\./); // really Electron, not node
    const recs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(recs.map((x) => [x.fn, x.hide])).toEqual([['execFileSync', true], ['spawnSync', false]]);
    expect(recs[0]).toMatchObject({ role: 'agent-main.mjs' });
    expect(recs[0].from).toMatch(/agent-main\.mjs:4$/);
  });
});
