import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guardApi, guardNodeArgs, preloadFile } from './spawn-guard.js';

/** A child_process-shaped double: each function records what it was called with. */
function fakeCp() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const mk = (fn: string) => function (...args: unknown[]) { calls.push({ fn, args }); return { fn }; };
  const cp: Record<string, any> = {};
  for (const fn of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) cp[fn] = mk(fn);
  // like Node's own execFile / exec: promisify resolves to { stdout, stderr }
  cp.execFile[promisify.custom] = (...args: unknown[]) => { calls.push({ fn: 'execFile:promise', args }); return Promise.resolve({ stdout: 'out', stderr: '' }); };
  return { cp, calls };
}

describe('spawn guard: windowsHide defaults to true', () => {
  const g = guardApi();
  let f: ReturnType<typeof fakeCp>;
  beforeEach(() => { f = fakeCp(); expect(g.patch(f.cp)).toBe(true); });
  const last = () => f.calls[f.calls.length - 1].args;
  const cb = () => {};

  it('adds options where the call had none, keeping every argument shape', () => {
    f.cp.spawn('git');
    expect(last()).toEqual(['git', { windowsHide: true }]);
    f.cp.spawn('git', ['status']);
    expect(last()).toEqual(['git', ['status'], { windowsHide: true }]);
    f.cp.execFile('git', cb);
    expect(last()).toEqual(['git', { windowsHide: true }, cb]);
    f.cp.execFile('git', ['status'], cb);
    expect(last()).toEqual(['git', ['status'], { windowsHide: true }, cb]);
    f.cp.execFile('git', null, cb);
    expect(last()).toEqual(['git', null, { windowsHide: true }, cb]);
    f.cp.exec('npm root -g', cb);
    expect(last()).toEqual(['npm root -g', { windowsHide: true }, cb]);
    f.cp.execSync('npm root -g');
    expect(last()).toEqual(['npm root -g', { windowsHide: true }]);
    f.cp.spawnSync('where', ['git']);
    expect(last()).toEqual(['where', ['git'], { windowsHide: true }]);
  });

  it('merges into an existing options object without mutating the caller’s object', () => {
    const opts = { cwd: 'C:\\repo', env: { A: '1' } };
    f.cp.execFile('git', ['status'], opts, cb);
    expect(last()).toEqual(['git', ['status'], { cwd: 'C:\\repo', env: { A: '1' }, windowsHide: true }, cb]);
    expect(opts).not.toHaveProperty('windowsHide');
    expect((last()[2] as any).env).toBe(opts.env);
    f.cp.spawn('git', { cwd: 'x' }); // options in the args slot
    expect(last()).toEqual(['git', { cwd: 'x', windowsHide: true }]);
    f.cp.execFile('git', null, { cwd: 'y' }, cb);
    expect(last()).toEqual(['git', null, { cwd: 'y', windowsHide: true }, cb]);
    f.cp.exec('dir', { shell: 'cmd.exe' }, cb);
    expect(last()).toEqual(['dir', { shell: 'cmd.exe', windowsHide: true }, cb]);
    f.cp.fork('child.js', ['a'], { silent: true });
    expect(last()).toEqual(['child.js', ['a'], { silent: true, windowsHide: true }]);
  });

  it('keeps an explicit windowsHide: false (the caller wants the window)', () => {
    f.cp.spawn('cmd', ['/c', 'start'], { windowsHide: false });
    expect(last()).toEqual(['cmd', ['/c', 'start'], { windowsHide: false }]);
  });

  it('keeps util.promisify(execFile) resolving to { stdout, stderr }', async () => {
    const run = promisify(f.cp.execFile);
    await expect(run('git', ['--version'], { timeout: 5 })).resolves.toEqual({ stdout: 'out', stderr: '' });
    expect(last()).toEqual(['git', ['--version'], { timeout: 5, windowsHide: true }]);
  });

  it('patches once', () => {
    expect(g.patch(f.cp)).toBe(false);
    f.cp.spawn('git');
    expect(f.calls).toHaveLength(1);
  });

  it('redacts secret-looking arguments in the log', () => {
    expect(g.redactArgs(['add-generic-password', '-w', 'hunter2'])).toEqual(['add-generic-password', '-w', '***']);
    expect(g.redactArgs(['--api-key=sk-abc', 'sk-ant-123', 'ok'])).toEqual(['***', '***', 'ok']);
    expect(g.redactArgs(['-Command', 'x'.repeat(200)])).toEqual(['-Command', '<200 chars>']);
  });
});

describe('spawn guard: installed into the real child_process', () => {
  it('reaches ESM named imports too (syncBuiltinESMExports)', () => {
    guardApi().install({ role: 'test' });
    // this file imported `spawnSync` by name before install: the live binding must now be the guarded one
    expect((spawnSync as any).__cwOriginal).toBeTypeOf('function');
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' });
    expect(r.stdout).toBe('ok');
  });
});

describe('spawn guard: --require preload in a child node process', () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-guard-')); });
  afterEach(() => {
    for (const k of ['CW_SPAWN_LOG', 'CW_SPAWN_LOG_FILE', 'CLAUDE_WEB_DIR']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('guards and logs the spawns of an ESM child (how ccb is written), attributing the caller', () => {
    const pre = preloadFile(path.join(dir, 'runtime'))!;
    expect(pre).toMatch(/spawn-guard-[0-9a-f]{10}\.cjs$/);
    const main = path.join(dir, 'agent-main.mjs');
    fs.writeFileSync(main, [
      "import { execFileSync, spawnSync } from 'node:child_process';",
      "execFileSync(process.execPath, ['-e', '0']);",
      "spawnSync(process.execPath, ['-e', '0'], { windowsHide: false });",
    ].join('\n'));
    const log = path.join(dir, 'spawn.jsonl');
    const r = spawnSync(process.execPath, ['--require', pre, main], { env: { ...process.env, CW_SPAWN_LOG: '1', CW_SPAWN_LOG_FILE: log }, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const recs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(recs.map((x) => [x.fn, x.hide])).toEqual([['execFileSync', true], ['spawnSync', false]]);
    expect(recs[0].role).toBe('agent-main.mjs');
    expect(recs[0].from).toMatch(/agent-main\.mjs:2$/);
    expect(r.stderr).toBe(''); // children log to the file only: stderr may be an agent's protocol-adjacent channel
  });

  it('rewrites the preload file if something deleted it', () => {
    const d = path.join(dir, 'runtime');
    const a = preloadFile(d)!;
    fs.rmSync(a);
    expect(preloadFile(d)).toBe(a);
    expect(fs.existsSync(a)).toBe(true);
  });

  it('adds no node args outside Electron unless spawn logging is on', () => {
    delete process.env.CW_SPAWN_LOG;
    if (!process.versions.electron) expect(guardNodeArgs()).toEqual([]);
    process.env.CW_SPAWN_LOG = '1';
    process.env.CLAUDE_WEB_DIR = dir;
    const args = guardNodeArgs();
    expect(args[0]).toBe('--require');
    expect(args[1].startsWith(path.join(dir, 'runtime'))).toBe(true);
  });
});
