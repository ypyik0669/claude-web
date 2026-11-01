import { spawn, exec, execFile, execSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

import type { EngineInfo } from './protocol.js';
export type { EngineInfo };

const isWin = process.platform === 'win32';
const unpack = (p: string) => p.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');

/**
 * Lookups that start a process (`npm root -g`, `<binary> --version`) remember a success for good (the global
 * prefix does not move; a version is per file + mtime) and a failure (npm missing, timeout, empty output) for
 * LOOKUP_FAIL_TTL_MS: long enough that a broken npm does not cost every connection a 15–20 s wait, short
 * enough that fixing it shows up within a minute.
 */
export const LOOKUP_FAIL_TTL_MS = 60_000;
type Looked<T> = { v: T | null; at: number };
const fresh = <T>(e: Looked<T> | undefined): e is Looked<T> => !!e && (e.v !== null || Date.now() - e.at < LOOKUP_FAIL_TTL_MS);
let globalRootMemo: Looked<string> | undefined;
let globalRootRun: Promise<string | null> | null = null;
const versionMemo = new Map<string, Looked<string>>();
const versionRuns = new Map<string, Promise<string | undefined>>();
/** Forget every lookup (tests). */
export function resetLookups() { globalRootMemo = undefined; globalRootRun = null; versionMemo.clear(); versionRuns.clear(); }

/** Callback exec → promise of stdout (no promisify: its shape depends on util.promisify.custom). */
function execOut(run: (cb: (err: Error | null, stdout: string | Buffer) => void) => void): Promise<string> {
  return new Promise((res, rej) => run((err, stdout) => (err ? rej(err) : res(String(stdout)))));
}

/**
 * `npm root -g`, synchronous: only for the spawn path (resolveClaudeExe), and only when
 * nothing bundled exists. engine.info uses globalRootAsync. Both share one memo. Exported for tests.
 */
export function globalRoot(): string | null {
  if (fresh(globalRootMemo)) return globalRootMemo.v;
  let v: string | null = null;
  try { v = execSync('npm root -g', { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim() || null; } catch { v = null; }
  globalRootMemo = { v, at: Date.now() };
  return v;
}

/** `npm root -g` without blocking the event loop; concurrent callers share one run. */
export function globalRootAsync(): Promise<string | null> {
  if (fresh(globalRootMemo)) return Promise.resolve(globalRootMemo.v);
  globalRootRun ??= execOut((cb) => exec('npm root -g', { encoding: 'utf8', windowsHide: true, timeout: 15_000 }, cb))
    .then((out) => out.trim() || null, () => null)
    .then((v) => { globalRootMemo = { v, at: Date.now() }; globalRootRun = null; return v; });
  return globalRootRun;
}

/** Official Claude Code: SDK's platform binary (bundled) → global npm install (`root` = the npm prefix lookup). */
export function resolveClaudeExe(root: () => string | null = globalRoot): string {
  const candidates: string[] = [];
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  if (process.env.CLAUDE_WEB_EXE) candidates.push(process.env.CLAUDE_WEB_EXE);
  try {
    const dir = path.dirname(require.resolve(`${pkg}/package.json`));
    candidates.push(unpack(path.join(dir, isWin ? 'claude.exe' : 'claude')));
  } catch {
    /* not installed for this platform */
  }
  const rp = (process as any).resourcesPath as string | undefined;
  if (rp) candidates.push(path.join(rp, 'app.asar.unpacked', 'node_modules', pkg, isWin ? 'claude.exe' : 'claude'));
  // `npm root -g` is a synchronous child process (up to 15s): only pay for it when nothing bundled exists.
  // This runs on every session start with the official runtime, blocking the event loop each time.
  let found = candidates.find((c) => existsSync(c));
  if (found) return found;
  const g = root();
  if (g) candidates.push(path.join(g, '@anthropic-ai/claude-code/bin', isWin ? 'claude.exe' : 'claude'));
  found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`Claude Code executable not found. Tried: ${candidates.join(', ')}`);
  return found;
}

/**
 * The binary's version: `<binary> --version` (seconds for claude.exe) run asynchronously, per file + mtime,
 * failures kept LOOKUP_FAIL_TTL_MS. Exported for tests.
 */
export async function versionOf(file: string): Promise<string | undefined> {
  try {
    const key = `${file}|${statSync(file).mtimeMs}`;
    const hit = versionMemo.get(key);
    if (fresh(hit)) return hit.v ?? undefined;
    let run = versionRuns.get(key);
    if (!run) {
      run = execOut((cb) => execFile(file, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }, cb))
        .then((out) => out.trim().split(/\s+/)[0] || null, () => null)
        .then((v) => { versionMemo.set(key, { v, at: Date.now() }); versionRuns.delete(key); return v ?? undefined; });
      versionRuns.set(key, run);
    }
    return await run;
  } catch {
    return undefined;
  }
}

function sourceOf(file: string): EngineInfo['source'] {
  if (file === process.env.CLAUDE_WEB_EXE) return 'env';
  return file.includes('app.asar') || file.includes('claude-agent-sdk') || file.includes(path.join('claude-web', 'node_modules')) ? 'bundled' : 'global';
}

/** The Claude Code binary every session and `claude <subcommand>` runs. */
export function resolveEngine(): { file: string } {
  return { file: resolveClaudeExe() };
}

/**
 * What the config center / welcome strip show: the binary, its version and where it came from. Asked on every
 * connection, so nothing here runs a synchronous process: the bundled binary is found on disk, the npm prefix (only
 * needed when it is not bundled) and `--version` are asked asynchronously.
 */
export async function engineInfo(): Promise<EngineInfo> {
  let claude: string | null = null;
  try { claude = resolveClaudeExe(() => null); } catch { /* not bundled */ }
  if (!claude) {
    const g = await globalRootAsync();
    try { claude = resolveClaudeExe(() => g); } catch { /* not installed */ }
  }
  if (!claude) throw new Error('Claude Code executable not found');
  return { version: await versionOf(claude), path: claude, source: sourceOf(claude) };
}

/**
 * Custom spawn for the SDK. The SDK's built-in spawn fails with ENOENT on Windows for the
 * native binary; a plain child_process.spawn with the same args works.
 */
export function spawnClaude(o: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal?: AbortSignal }) {
  const env = { ...o.env } as NodeJS.ProcessEnv;
  if (env.CLAUDE_WEB_PLAIN_UA) {
    // third-party provider session: drop the SDK markers so the CLI's User-Agent is the plain `claude-cli/x (external, sdk-cli)`
    delete env.CLAUDE_WEB_PLAIN_UA;
    delete env.CLAUDE_AGENT_SDK_VERSION;
    delete env.CLAUDE_AGENT_SDK_CLIENT_APP;
  }
  return spawn(o.command, o.args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: o.signal });
}

/** Run a `claude <subcommand>` with the runtime and return stdout/stderr. Used by the config center. */
export async function runClaudeCli(args: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }> {
  const { file } = resolveEngine();
  try {
    const p = execFileAsync(file, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    p.child.stdin?.end(); // `-p` otherwise waits 3 s for piped input and prints a warning to stderr
    const { stdout, stderr } = await p;
    return { code: 0, stdout, stderr };
  } catch (e: any) {
    // killed at the timeout: no code, often no output — say so instead of a bare "exit 1"
    const timedOut = !!e.killed && typeof e.code !== 'number';
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr || String(e.message ?? e), ...(timedOut ? { timedOut } : {}) };
  }
}
