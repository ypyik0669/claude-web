import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

/**
 * Where agent CLIs live when the app's own PATH does not say. A GUI-started app (Start menu, Finder, a desktop
 * shortcut) gets the PATH of the moment the user logged in: an agent installed afterwards, a Node from fnm (whose
 * PATH exists only in shell profiles), a `uv tool` bin — none of those are visible, and a user who clearly has Codex
 * sees 「未安装」. Two remedies, both read-only: add the directories CLIs install into (and, on Windows, the PATH the
 * registry holds now) to this process's PATH, so spawns, the terminal and `npm i -g` all see them; and find an agent
 * shipped inside another app (the Codex desktop app, the Codex IDE extension) when there is no CLI on PATH at all.
 */

type Env = Record<string, string | undefined>;

/** `%VAR%` expanded from `env` (names case-insensitive, as on Windows); unknown ones stay as written. */
export function expandWinVars(s: string, env: Env): string {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return s.replace(/%([^%;]+)%/g, (all, name: string) => lower.get(name.toLowerCase()) ?? all);
}

/** The value of `reg query <key> /v Path`, or null. */
export function parseRegPath(stdout: string): string | null {
  const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(stdout);
  return m ? m[1] : null;
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
      j(home, '.local', 'bin'), // uv tool (kimi-cli), pipx
      j(home, '.cargo', 'bin'),
      j(home, '.opencode', 'bin'), // opencode's install script
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
    j(home, '.opencode', 'bin'),
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

function regPath(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', 'Path'], { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(err ? null : parseRegPath(String(stdout))));
  });
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
 * Append to `process.env.PATH` the directories agent CLIs install into that it lacks (existing ones only; on
 * Windows first the registry's current PATH). Every later spawn — version probes, sessions, the terminal panel —
 * sees them. At most once per 30 s unless `force` (agents.list 「重新检测」). Returns what was added.
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

/** Where an agent binary shipped inside another app may be, per platform. Globs are one `*` in the last-but-n segment. */
export function bundledCandidates(kind: string, platform: NodeJS.Platform, arch: string, env: Env, home: string): { from: string; pattern: string[] }[] {
  if (kind !== 'codex') return [];
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const extPlat = platform === 'win32' ? `windows-${arch === 'arm64' ? 'aarch64' : 'x86_64'}` : platform === 'darwin' ? `macos-${arch === 'arm64' ? 'aarch64' : 'x86_64'}` : `linux-${arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
  const out: { from: string; pattern: string[] }[] = [];
  if (platform === 'win32') {
    // the Codex desktop app (Microsoft Store) copies its CLI out of WindowsApps: bin\codex.exe, newer ones in bin\<hash>\
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    out.push({ from: 'Codex 桌面版', pattern: [local, 'OpenAI', 'Codex', 'bin', exe] });
    out.push({ from: 'Codex 桌面版', pattern: [local, 'OpenAI', 'Codex', 'bin', '*', exe] });
  }
  if (platform === 'darwin') {
    for (const apps of ['/Applications', path.join(home, 'Applications')]) out.push({ from: 'Codex 桌面版', pattern: [apps, 'Codex.app', 'Contents', 'Resources', exe] });
  }
  // the Codex IDE extension (VS Code and its forks) bundles the same CLI; it runs `codex app-server` itself
  for (const ide of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) out.push({ from: 'Codex IDE 扩展', pattern: [home, ide, 'extensions', 'openai.chatgpt-*', 'bin', extPlat, exe] });
  return out;
}

/** Expand a pattern with at most one `*` segment (prefix-matched on what comes before the `*`). */
function expand(pattern: string[]): string[] {
  const i = pattern.findIndex((s) => s.includes('*'));
  if (i < 0) return [path.join(...pattern)];
  const dir = path.join(...pattern.slice(0, i));
  const prefix = pattern[i].slice(0, pattern[i].indexOf('*'));
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix)); } catch { return []; }
  return names.map((n) => path.join(dir, n, ...pattern.slice(i + 1)));
}

/** The newest (by mtime) agent binary shipped inside another app, or null. */
export function findBundled(kind: string, o: { platform?: NodeJS.Platform; arch?: string; env?: Env; home?: string } = {}): { file: string; from: string } | null {
  const platform = o.platform ?? process.platform;
  let best: { file: string; from: string; at: number } | null = null;
  for (const c of bundledCandidates(kind, platform, o.arch ?? process.arch, o.env ?? process.env, o.home ?? os.homedir())) {
    for (const file of expand(c.pattern)) {
      try {
        const st = fs.statSync(file);
        if (st.isFile() && (!best || st.mtimeMs > best.at)) best = { file, from: c.from, at: st.mtimeMs };
      } catch { /* not there */ }
    }
  }
  return best && { file: best.file, from: best.from };
}

/** What a missing install tool is called and where to get it (the 安装 button's command needs it). */
export function installTool(install: string): { tool: string; name: string; url: string } | null {
  const tool = install.trim().split(/\s+/)[0];
  if (tool === 'npm') return { tool, name: 'Node.js', url: 'https://nodejs.org/' };
  if (tool === 'uv') return { tool, name: 'uv', url: 'https://docs.astral.sh/uv/getting-started/installation/' };
  return null;
}
