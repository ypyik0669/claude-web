// A bot can't edit its own policy or audit (spec §5: the rules and the record live where the model can't change them).
// Everything of the bots — bot.json (the policy), trust.json, runs/ (the audit), inbox.json, the leases — is under
// `<dataDir>/bots/`. A file tool writing there is refused, except into the bot's own `state/` (its checkpoint); a shell
// command that names that dir goes to the user first, whatever the bot's levels (unleashed too).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const win = process.platform === 'win32';
const fold = (p: string) => (win ? p.toLowerCase() : p);

/** realpath of the deepest part that exists, the rest appended (a new file under a linked dir still lands in its target) */
function real(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()); } catch { /* not there (yet) */ }
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    rest.push(path.basename(cur));
    cur = up;
  }
}

/** commands that give a path another name (a drive letter, a share, a link): what they point at is the user's call */
const DRIVE_MAP = /(?<![\w-])(net(\.exe)?\s+(use|share)|new-psdrive|ndr|new-smbmapping|new-smbshare|subst(\.exe)?\s+[a-z]:|mk["']*link|fsutil(\.exe)?\s+hardlink|wmic\b[^\n;|&]*\bshare|ln|(new-item|ni)\b[^\n;|&]*-itemtype\s+["']?(junction|symboliclink|hardlink)|create(symbolic|hard)link)(?![\w-])/i;

const LOCAL_HOSTS =() => new Set(['localhost', '.', '::1', '0--1.ipv6-literal.net', os.hostname().toLowerCase()]);

/**
 * A Windows network / device path, brought back to the drive path it names on this machine: \\localhost\c$\x,
 * \\127.0.0.1\c$\x, \\<this host>\c$\x, \\?\UNC\localhost\c$\x, \\.\C:\x → C:\x. Null for a share that stays a
 * network path (another host, a named share): realpath can't map those back, so the guard can't tell where they land.
 */
export function localOfUnc(p: string): string | null {
  let s = p.replace(/\//g, '\\');
  if (!s.startsWith('\\\\')) return p;
  s = s.replace(/^\\\\[?.]\\UNC\\/i, '\\\\');
  const dev = /^\\\\[?.]\\([a-z]:)(\\.*)?$/i.exec(s);
  if (dev) return dev[1] + (dev[2] ?? '\\');
  const m = /^\\\\([^\\]+)\\([a-z])\$(\\.*)?$/i.exec(s);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const local = LOCAL_HOSTS().has(host) || /^127(\.\d{1,3}){3}$/.test(host);
  return local ? `${m[2]}:${m[3] ?? '\\'}` : null;
}

const inside = (child: string, dir: string) => {
  const rel = path.relative(fold(dir), fold(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};

/** the ways a shell command can name the bots dir: both slash styles, and ~/… when it is under the home dir */
function mentions(command: string, root: string): boolean {
  const c = fold(command);
  const forms = new Set<string>();
  for (const r of [path.resolve(root), real(root)]) {
    forms.add(r.replace(/\\/g, '/'));
    forms.add(r.replace(/\//g, '\\'));
    const home = os.homedir();
    if (inside(r, home)) {
      const rel = path.relative(home, r);
      forms.add(`~/${rel.replace(/\\/g, '/')}`);
      forms.add(`~\\${rel.replace(/\//g, '\\')}`);
    }
  }
  if ([...forms].some((f) => c.includes(fold(f)))) return true;
  // however the start is spelled ($HOME, %USERPROFILE%, $env:USERPROFILE, ../..): the data dir's name followed by
  // bots; a name that says claude-web (the default .claude-web) anywhere at all
  const base = path.basename(path.dirname(path.resolve(root)));
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (base && new RegExp(`${esc}["'\`]?[\\\\/]+["'\`]?bots(?![\\w-])`, 'i').test(command)) return true;
  return /claude-web/i.test(base) && command.toLowerCase().includes(base.toLowerCase());
}

/**
 * 'deny' for a file write under the bots dir (other than this bot's own state/), 'ask' for a shell command that names
 * that dir (or CLAUDE_WEB_DIR), undefined for everything else.
 */
export function selfGuard(botsRoot: string, botId: string, cwd: string, toolName: string, input: Record<string, unknown>): 'deny' | 'ask' | undefined {
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const raw = input.file_path ?? input.notebook_path ?? input.path;
    if (typeof raw !== 'string' || !raw) return undefined;
    // a network path that may be this machine under another name goes to the user first
    const local = win ? localOfUnc(raw) : raw;
    if (local === null) return 'ask';
    // a mapped drive (net use V: \\localhost\c$) realpaths to its network form: fold that back too
    const resolved = real(path.resolve(cwd, local));
    const target = win ? localOfUnc(resolved) : resolved;
    if (target === null) return 'ask';
    const root = real(botsRoot);
    if (!inside(target, root)) return undefined;
    return inside(target, path.join(root, botId, 'state')) ? undefined : 'deny';
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = String(input.command ?? '');
    return mentions(cmd, botsRoot) || /CLAUDE_WEB_DIR/i.test(cmd) || DRIVE_MAP.test(cmd) ? 'ask' : undefined;
  }
  return undefined;
}
