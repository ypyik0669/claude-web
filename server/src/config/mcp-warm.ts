import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { resolveSpawn } from '../proc/resolve.js';
import { killTree } from '../proc/kill-tree.js';
import { localEnv } from '../runtime/local-env.js';

/**
 * First start of a connector launched by a package runner (`npx -y @modelcontextprotocol/server-memory`, `uvx
 * mcp-server-fetch`): the runner downloads the package before the server says anything, and `claude mcp list`
 * (the 连接器 page's status, the health check) gives up long before that on a cold cache — the user saw
 * 「连不上：Failed to connect」 right after adding an entry that works fine a minute later. So adding one runs it
 * once here first, bounded: the download lands in the runner's cache, and the list asked afterwards finds it fast.
 */

/** Runners that fetch a package on first use. `pnpm dlx` / `yarn dlx` are left out: two words, rarely used here. */
const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'uvx']);

export interface WarmSpec { command: string; args: string[]; env: Record<string, string> }

/** The command to warm for an `mcp add-json` config, or null when it does not download anything on first start. */
export function warmupSpec(json: string | Record<string, unknown>): WarmSpec | null {
  let cfg: any;
  try { cfg = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  if (!cfg || typeof cfg !== 'object' || typeof cfg.command !== 'string') return null;
  if (cfg.type && cfg.type !== 'stdio') return null;
  const base = path.basename(cfg.command.replace(/\\/g, '/')).replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase();
  if (!RUNNERS.has(base)) return null;
  const args = Array.isArray(cfg.args) ? cfg.args.filter((a: unknown): a is string => typeof a === 'string') : [];
  const env: Record<string, string> = {};
  if (cfg.env && typeof cfg.env === 'object') for (const [k, v] of Object.entries(cfg.env)) if (typeof v === 'string') env[k] = v;
  return { command: cfg.command, args, env };
}

/**
 * Output that is the runner installing, not the server running: npm's `npm warn …` (deprecations arrive mid-download)
 * and uv's progress lines. Anything else on stdout / stderr means the server itself started.
 */
export function isInstallerNoise(line: string): boolean {
  const l = line.trim();
  if (!l) return true;
  return /^npm (warn|notice|http|timing|info)\b/i.test(l)
    || /^(Resolved|Prepared|Installed|Uninstalled|Downloading|Downloaded|Building|Built|Updating|Updated|Audited)\b/.test(l);
}

export interface WarmResult { ok: boolean; ms: number; timedOut?: boolean; error?: string }

/**
 * Run it once with stdin already closed: a stdio MCP server exits at end of input, so the run ends when the download
 * is done and the server has started. Ends early, too, a moment after the server's own first words (one that keeps
 * running past EOF), and at `timeoutMs` at the latest; the whole tree is killed either way. Never rejects.
 */
export function warmUp(spec: WarmSpec, o: { cwd?: string; timeoutMs?: number; settleMs?: number } = {}): Promise<WarmResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let sp: ReturnType<typeof resolveSpawn>;
    try { sp = resolveSpawn(spec.command, spec.args); } catch (e: any) { resolve({ ok: false, ms: 0, error: e?.message ?? String(e) }); return; }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(sp.command, sp.args, {
        cwd: o.cwd || os.homedir(),
        env: { ...process.env, ...localEnv(), ...spec.env, ...sp.env },
        windowsHide: true,
        windowsVerbatimArguments: sp.via === 'cmd',
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e: any) { resolve({ ok: false, ms: 0, error: e?.message ?? String(e) }); return; }
    let done = false;
    let settle: NodeJS.Timeout | undefined;
    const finish = (r: Omit<WarmResult, 'ms'>) => {
      if (done) return;
      done = true;
      clearTimeout(cap);
      clearTimeout(settle);
      void killTree(child);
      resolve({ ...r, ms: Date.now() - started });
    };
    const cap = setTimeout(() => finish({ ok: false, timedOut: true }), o.timeoutMs ?? 120_000);
    cap.unref?.();
    const onData = (b: Buffer) => {
      if (settle || String(b).split(/\r?\n/).every(isInstallerNoise)) return;
      settle = setTimeout(() => finish({ ok: true }), o.settleMs ?? 2000);
      settle.unref?.();
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('exit', (code) => finish(code === 0 || code === null ? { ok: true } : { ok: false, error: `exit ${code}` }));
    child.stdin?.on('error', () => { /* already gone */ });
    child.stdin?.end();
  });
}
