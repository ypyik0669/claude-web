import { spawn, execFile, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export type EngineId = 'claude' | 'ccb';
export interface EngineInfo {
  id: EngineId;
  label: string;
  installed: boolean;
  path?: string; // executable (.exe) or entry script (.js)
  version?: string;
  source?: 'bundled' | 'global' | 'env';
  note?: string;
}

const isWin = process.platform === 'win32';
const unpack = (p: string) => p.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');

function globalRoot(): string | null {
  try {
    return execSync('npm root -g', { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim();
  } catch {
    return null;
  }
}

/** Official Claude Code: SDK's platform binary (bundled) → global npm install. */
export function resolveClaudeExe(): string {
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
  const g = globalRoot();
  if (g) candidates.push(path.join(g, '@anthropic-ai/claude-code/bin', isWin ? 'claude.exe' : 'claude'));
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`Claude Code executable not found. Tried: ${candidates.join(', ')}`);
  return found;
}

/** claude-code-best (ccb): bundled npm dependency → global npm install. Entry is a JS file run by node. */
export function resolveCcbEntry(): string | null {
  const candidates: string[] = [];
  if (process.env.CLAUDE_WEB_CCB) candidates.push(process.env.CLAUDE_WEB_CCB);
  try {
    candidates.push(unpack(path.join(path.dirname(require.resolve('claude-code-best/package.json')), 'dist', 'cli-node.js')));
  } catch {
    /* not bundled */
  }
  const rp = (process as any).resourcesPath as string | undefined;
  if (rp) candidates.push(path.join(rp, 'app.asar.unpacked', 'node_modules', 'claude-code-best', 'dist', 'cli-node.js'));
  const g = globalRoot();
  if (g) candidates.push(path.join(g, 'claude-code-best', 'dist', 'cli-node.js'));
  return candidates.find((c) => existsSync(c)) ?? null;
}

function versionOf(file: string): string | undefined {
  try {
    const pkg = file.endsWith('.js') ? path.resolve(path.dirname(file), '..', 'package.json') : null;
    if (pkg && existsSync(pkg)) return JSON.parse(require('node:fs').readFileSync(pkg, 'utf8')).version;
    const out = execSync(`"${file}" --version`, { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    return out.trim().split(/\s+/)[0];
  } catch {
    return undefined;
  }
}

export function listEngines(): EngineInfo[] {
  const out: EngineInfo[] = [];
  try {
    const p = resolveClaudeExe();
    out.push({ id: 'claude', label: 'Claude Code（官方）', installed: true, path: p, version: versionOf(p), source: p.includes('claude-agent-sdk') ? 'bundled' : 'global' });
  } catch (e: any) {
    out.push({ id: 'claude', label: 'Claude Code（官方）', installed: false, note: e.message });
  }
  const c = resolveCcbEntry();
  out.push(c ? { id: 'ccb', label: 'Claude Code Best（ccb）', installed: true, path: c, version: versionOf(c), source: c.includes('app.asar') || c.includes(path.join('claude-web', 'node_modules')) ? 'bundled' : 'global' } : { id: 'ccb', label: 'Claude Code Best（ccb）', installed: false, note: '未安装：npm i -g claude-code-best' });
  return out;
}

export function resolveEngine(id: EngineId = 'claude'): string {
  if (id === 'ccb') {
    const c = resolveCcbEntry();
    if (!c) throw new Error('ccb 未安装（npm i -g claude-code-best）');
    return c;
  }
  return resolveClaudeExe();
}

/** Node binary to run JS engines with. Inside Electron there is no `node` on PATH — use the shell itself in Node mode. */
function nodeCommand(): { command: string; env: Record<string, string> } {
  const isElectron = !!process.versions.electron;
  if (isElectron) return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  return { command: process.execPath || 'node', env: {} };
}

/**
 * Custom spawn for the SDK. The SDK's built-in spawn fails with ENOENT on Windows for the
 * native binary; a plain child_process.spawn with the same args works. Also maps `node` to the
 * right binary when running inside Electron.
 */
export function spawnClaude(o: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal?: AbortSignal }) {
  let command = o.command;
  let env = { ...o.env } as NodeJS.ProcessEnv;
  if (command === 'node') {
    const n = nodeCommand();
    command = n.command;
    env = { ...env, ...n.env };
  }
  return spawn(command, o.args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: o.signal });
}

/** Run a `claude <subcommand>` (official engine) and return stdout/stderr. Used by the config center. */
export async function runClaudeCli(args: string[], opts: { cwd?: string; timeoutMs?: number; engine?: EngineId } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const file = resolveEngine(opts.engine ?? 'claude');
  const isJs = file.endsWith('.js');
  const n = isJs ? nodeCommand() : null;
  try {
    const { stdout, stderr } = await execFileAsync(isJs ? n!.command : file, isJs ? [file, ...args] : args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, ...(n?.env ?? {}), CLAUDE_CODE_ENTRYPOINT: 'claude-web' },
    });
    return { code: 0, stdout, stderr };
  } catch (e: any) {
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e.message ?? e) };
  }
}

/** Install / update ccb globally through npm. Streams nothing; returns the final result. */
export async function installCcb(): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(isWin ? 'npm.cmd' : 'npm', ['i', '-g', 'claude-code-best@latest'], { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, shell: isWin });
    return { code: 0, stdout, stderr };
  } catch (e: any) {
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e.message ?? e) };
  }
}
