import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

/**
 * Where CLIs live when the app's own PATH does not say. A GUI-started app (Start menu, Finder, a desktop shortcut)
 * gets the PATH of the moment the user logged in: a tool installed afterwards, a Node from fnm (whose PATH exists only
 * in shell profiles), a `uv tool` bin — none of those are visible (an MCP server started with `npx`, ego lite's
 * `ego-browser`). The remedy, read-only: add the directories CLIs install into (and, on Windows, the PATH the registry
 * holds now) to this process's PATH, so spawns, the terminal and `npm i -g` all see them.
 */

type Env = Record<string, string | undefined>;

/** `%VAR%` expanded from `env` (names case-insensitive, as on Windows); unknown ones stay as written. */
export function expandWinVars(s: string, env: Env): string {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return s.replace(/%([^%;]+)%/g, (all, name: string) => lower.get(name.toLowerCase()) ?? all);
}

/** One named REG_SZ value from `reg query` output, or null. */
export function parseRegValue(stdout: string, name: string): string | null {
  const m = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+REG_(?:EXPAND_)?SZ\\s+(.*?)\\s*$`, 'im').exec(stdout);
  return m ? m[1] : null;
}

/** The value of `reg query <key> /v Path`, or null. */
export function parseRegPath(stdout: string): string | null {
  return parseRegValue(stdout, 'Path');
}

/** Directories CLIs commonly install into. Existence is not checked here. */
export function wellKnownDirs(platform: NodeJS.Platform, env: Env, home: string): string[] {
  const j = (...p: (string | undefined)[]) => (p.every(Boolean) ? path.join(...(p as string[])) : '');
  if (platform === 'win32') {
    const appData = env.APPDATA || j(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA || j(home, 'AppData', 'Local');
    return [
      j(appData, 'npm'), // npm -g with the official Node installer
      env.NVM_SYMLINK ?? '', 'C:\\nvm4w\\nodejs', j(env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
      j(env.FNM_DIR || j(appData, 'fnm'), 'aliases', 'default'), // fnm: node.exe and npm -g bins of the default version
      j(env.PNPM_HOME || j(local, 'pnpm')),
      j(local, 'Volta', 'bin'), j(env.ProgramFiles || 'C:\\Program Files', 'Volta'),
      j(home, '.bun', 'bin'),
      j(local, 'Microsoft', 'WinGet', 'Links'),
      j(env.SCOOP || j(home, 'scoop'), 'shims'),
      j(home, '.local', 'bin'), // uv tool, pipx
      j(home, '.cargo', 'bin'),
    ].filter(Boolean);
  }
  const xdgData = env.XDG_DATA_HOME || j(home, '.local', 'share');
  return [
    '/opt/homebrew/bin', '/usr/local/bin',
    j(home, '.local', 'bin'),
    j(home, '.npm-global', 'bin'),
    j(home, '.volta', 'bin'),
    j(home, '.bun', 'bin'),
    j(home, '.cargo', 'bin'),
    env.PNPM_HOME ?? '', platform === 'darwin' ? j(home, 'Library', 'pnpm') : j(xdgData, 'pnpm'),
    j(env.FNM_DIR || (platform === 'darwin' ? j(home, 'Library', 'Application Support', 'fnm') : j(xdgData, 'fnm')), 'aliases', 'default', 'bin'),
    j(home, '.fnm', 'aliases', 'default', 'bin'),
    j(xdgData, 'mise', 'shims'), j(home, '.asdf', 'shims'),
    ...newestNvmBin(home),
  ].filter(Boolean);
}

/** nvm keeps one directory per Node version; its default is a shell function, so take the newest version's bin. */
function newestNvmBin(home: string): string[] {
  const dir = path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node');
  try {
    const vs = fs.readdirSync(dir).filter((v) => /^v\d+/.test(v)).sort((a, b) => cmpVersion(b.slice(1), a.slice(1)));
    return vs.length ? [path.join(dir, vs[0], 'bin')] : [];
  } catch { return []; }
}

function cmpVersion(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** `current` with the `extra` directories it lacks appended (so the user's own order still wins). */
export function mergePath(current: string, extra: string[], platform: NodeJS.Platform = process.platform): { path: string; added: string[] } {
  const delim = platform === 'win32' ? ';' : ':';
  const norm = (d: string) => { const t = d.trim().replace(/[\\/]+$/, ''); return platform === 'win32' ? t.toLowerCase().replace(/\//g, '\\') : t; };
  const have = new Set(current.split(delim).filter(Boolean).map(norm));
  const added: string[] = [];
  for (const d of extra) {
    const k = norm(d);
    if (!k || have.has(k)) continue;
    have.add(k);
    added.push(d.trim());
  }
  return { path: [current, ...added].filter(Boolean).join(delim), added };
}

function reg(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

function regPath(key: string): Promise<string | null> {
  return reg(['query', key, '/v', 'Path']).then((out) => (out ? parseRegPath(out) : null));
}

/** The PATH Windows gives a process started now: machine + user (what Explorer knew at login may be older). */
async function registryPathDirs(env: Env): Promise<string[]> {
  const [machine, user] = await Promise.all([regPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), regPath('HKCU\\Environment')]);
  return [machine, user].filter((v): v is string => !!v).flatMap((v) => expandWinVars(v, env).split(';')).map((d) => d.trim()).filter(Boolean);
}

const isDir = (d: string) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };

let refreshedAt = 0;
let refreshing: Promise<string[]> | null = null;
const REFRESH_TTL_MS = 30_000;

/**
 * Append to `process.env.PATH` the directories CLIs install into that it lacks (existing ones only; on Windows first
 * the registry's current PATH). Every later spawn — version probes, sessions, the terminal panel — sees them. At most
 * once per 30 s unless `force`. Returns what was added.
 */
export function refreshProcessPath(force = false): Promise<string[]> {
  if (refreshing) return refreshing;
  if (!force && Date.now() - refreshedAt < REFRESH_TTL_MS) return Promise.resolve([]);
  refreshing = (async () => {
    const env = process.env;
    const home = os.homedir();
    const fromReg = process.platform === 'win32' ? await registryPathDirs(env).catch(() => []) : [];
    const dirs = [...fromReg, ...wellKnownDirs(process.platform, env, home)].filter(isDir);
    const { path: next, added } = mergePath(env.PATH ?? '', dirs);
    if (added.length) env.PATH = next;
    refreshedAt = Date.now();
    return added;
  })().finally(() => { refreshing = null; });
  return refreshing;
}
