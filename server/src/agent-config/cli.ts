// Run another agent's own CLI for a config subcommand (`codex mcp add …`). npm `.cmd` shims are unwrapped
// by resolveSpawn (same as the session drivers), so there is no cmd.exe re-quoting of argv on Windows.
import { spawn } from 'node:child_process';
import { resolveSpawn } from '../agents/resolve.js';

/** How to invoke an agent's CLI: the configured executable, optional leading args (tests point this at a script), extra env. */
export interface CliSpec { command: string; prefix?: string[]; env?: Record<string, string> }
export interface CliResult { code: number | null; stdout: string; stderr: string }

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const TIMEOUT_MS = 60_000;

export function runCli(spec: CliSpec, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<CliResult> {
  const r = resolveSpawn(spec.command, [...(spec.prefix ?? []), ...args]);
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    let child;
    try {
      child = spawn(r.command, r.args, { cwd: opts.cwd, env: { ...process.env, ...spec.env, ...r.env }, windowsHide: true, windowsVerbatimArguments: r.via === 'cmd', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { reject(e); return; }
    const t = setTimeout(() => { child.kill(); reject(new Error(`${spec.command} ${args.slice(0, 2).join(' ')} 超时（${(opts.timeoutMs ?? TIMEOUT_MS) / 1000}s）`)); }, opts.timeoutMs ?? TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e: any) => { clearTimeout(t); reject(e?.code === 'ENOENT' ? new Error(`找不到 ${spec.command}（未安装或不在 PATH 上）`) : e); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, stdout: stdout.replace(ANSI, ''), stderr: stderr.replace(ANSI, '') }); });
  });
}

/** runCli that throws on a non-zero exit, with the most useful stderr line as the message. */
export async function runCliOk(spec: CliSpec, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<CliResult> {
  const res = await runCli(spec, args, opts);
  if (res.code !== 0) {
    const lines = `${res.stderr}\n${res.stdout}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^WARNING: proceeding/.test(l));
    const msg = lines.find((l) => /error/i.test(l)) ?? lines[lines.length - 1] ?? `exit ${res.code}`;
    throw new Error(`${spec.command} ${args.slice(0, 2).join(' ')} 失败：${msg}`);
  }
  return res;
}
