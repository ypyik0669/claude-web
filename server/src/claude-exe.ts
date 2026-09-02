import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * Resolve the Claude Code executable. Prefer the platform binary shipped with the SDK
 * (guaranteed protocol match), then fall back to the globally installed CLI.
 */
export function resolveClaudeExe(): string {
  const candidates: string[] = [];
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  try {
    const dir = path.dirname(require.resolve(`${pkg}/package.json`));
    candidates.push(path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude'));
  } catch {
    /* not installed for this platform */
  }
  if (process.env.CLAUDE_WEB_EXE) candidates.unshift(process.env.CLAUDE_WEB_EXE);
  try {
    const globalRoot = require('node:child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
    candidates.push(path.join(globalRoot, '@anthropic-ai/claude-code/bin', process.platform === 'win32' ? 'claude.exe' : 'claude'));
  } catch {
    /* ignore */
  }
  // packaged (Electron asar): native binaries live in app.asar.unpacked
  for (const c of [...candidates]) if (c.includes('app.asar')) candidates.unshift(c.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked'));
  if ((process as any).resourcesPath) candidates.push(path.join((process as any).resourcesPath, 'app.asar.unpacked', 'node_modules', pkg, process.platform === 'win32' ? 'claude.exe' : 'claude'));
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`Claude Code executable not found. Tried: ${candidates.join(', ')}`);
  return found;
}

/**
 * Custom spawn for the SDK. The SDK's built-in spawn fails with ENOENT on Windows for the
 * native binary; a plain child_process.spawn with the same args works.
 */
export function spawnClaude(o: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal?: AbortSignal }) {
  return spawn(o.command, o.args, {
    cwd: o.cwd,
    env: o.env as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    signal: o.signal,
  });
}

/** Run a `claude <subcommand>` and return stdout/stderr. Used by the config center. */
export async function runClaudeCli(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const exe = resolveClaudeExe();
  try {
    const { stdout, stderr } = await execFileAsync(exe, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'claude-web' },
    });
    return { code: 0, stdout, stderr };
  } catch (e: any) {
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e.message ?? e) };
  }
}
