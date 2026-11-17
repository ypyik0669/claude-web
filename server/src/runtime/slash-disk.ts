import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeKind, SlashCommandInfo, SlashSource } from '../protocol.js';
import { dataDir } from '../files/service.js';
import { Memo } from './memo.js';
import { engineOwnRows, normalizeCommands } from './slash-commands.js';

/**
 * The / menu of a Claude conversation whose process is not running — opened from the list, after a restart, the
 * welcome page, the 20–50 s before claude-web-engine answers `initialize` (it waits for the MCP servers: 21 s / 46 s on
 * the author's machine, 2026-11-17) — had nothing but our /btw. What Claude Code would offer there, read from the disk
 * the way it reads it: skills (`<dir>/SKILL.md`) and commands (`*.md`, subfolders → `a:b`) of the user (~/.claude), of
 * the project (<cwd>/.claude and the folders above it, up to the home folder), of the enabled plugins
 * (installed_plugins.json, listed in `enabledPlugins` and not false) and of the local plugins every conversation gets
 * (plugin-dirs.ts); `user-invocable: false` left out. Plus the engine's own commands as the last running conversation
 * reported them (kept in <dataDir>/runtime/slash-commands.json, so a restart has them too). Once the process reports
 * its own list, that one is used (web: features/composer/slash.ts).
 */

type Fm = Record<string, string>;

/** files written on Windows may start with a byte-order mark */
const noBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** The YAML front matter's top-level keys as strings: plain, quoted, folded over several lines, `>` / `|` blocks. */
export function frontmatter(md: string): { fm: Fm; body: string } {
  const src = noBom(md);
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { fm: {}, body: src };
  const lines = m[1].split(/\r?\n/);
  const fm: Fm = {};
  for (let i = 0; i < lines.length; i++) {
    const km = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!km) continue;
    let v = km[2].trim();
    const cont: string[] = [];
    const indented = (j: number) => j < lines.length && /^[ \t]+\S/.test(lines[j]);
    while (indented(i + 1) || (i + 2 < lines.length && !lines[i + 1].trim() && indented(i + 2))) cont.push(lines[++i].trim());
    if (/^[>|][+-]?\d*$/.test(v)) v = v.startsWith('|') ? cont.join('\n') : cont.filter(Boolean).join(' ');
    else if (cont.length) v = [v, ...cont.filter(Boolean)].join(' ');
    const q = v[0];
    if (v.length >= 2 && (q === '"' || q === "'") && v.endsWith(q)) {
      v = v.slice(1, -1);
      v = q === "'" ? v.replace(/''/g, "'") : v.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    }
    fm[km[1]] = v;
  }
  return { fm, body: src.slice(m[0].length) };
}

/** No description in the front matter: Claude Code takes the first line of the text (a heading's words) */
function firstLine(body: string): string {
  const l = body.split(/\r?\n/).map((s) => s.trim()).find((s) => s && s !== '---');
  return (l ?? '').replace(/^#+\s*/, '').slice(0, 250);
}

const invocable = (fm: Fm) => !/^(false|no|off)$/i.test((fm['user-invocable'] ?? '').trim());

async function readText(file: string): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}

/** The folders in `root`, links (a junction on Windows: the anthropic-skills mirror) followed. */
async function subdirs(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory() || (e.isSymbolicLink() && (await fs.stat(path.join(root, e.name)).then((s) => s.isDirectory(), () => false)))) out.push(e.name);
  }
  return out.sort();
}

type Origin = { source: SlashSource; owner?: string };

async function addSkills(out: SlashCommandInfo[], root: string, o: Origin): Promise<void> {
  for (const dir of await subdirs(root)) {
    const md = await readText(path.join(root, dir, 'SKILL.md'));
    if (md === null) continue;
    const { fm, body } = frontmatter(md);
    if (!invocable(fm)) continue;
    const own = (fm.name || dir).trim();
    // a plugin's: `plugin:<folder>` (the name both engines run), its own name an alias; the user's / project's go by
    // their front-matter name (the official binary lists the folder as an alias)
    const name = o.owner ? `${o.owner}:${dir}` : own;
    const aliases = [...new Set(o.owner ? [own, dir] : [dir])].filter((a) => a && a !== name);
    out.push({ name, description: fm.description || firstLine(body), argumentHint: fm['argument-hint'] ?? '', ...(aliases.length ? { aliases } : {}), source: o.source, ...(o.owner ? { owner: o.owner } : {}), kind: 'skill' });
  }
}

async function addCommands(out: SlashCommandInfo[], root: string, o: Origin, rel: string[] = []): Promise<void> {
  if (rel.length > 3) return;
  const entries = await fs.readdir(path.join(root, ...rel), { withFileTypes: true }).catch(() => []);
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(root, ...rel, e.name);
    const dir = e.isDirectory() || (e.isSymbolicLink() && (await fs.stat(p).then((s) => s.isDirectory(), () => false)));
    if (dir) { await addCommands(out, root, o, [...rel, e.name]); continue; }
    if (!/\.md$/i.test(e.name)) continue;
    const md = await readText(p);
    if (md === null) continue;
    const { fm, body } = frontmatter(md);
    if (!invocable(fm)) continue;
    const base = [...rel, e.name.replace(/\.md$/i, '')].join(':');
    out.push({ name: o.owner ? `${o.owner}:${base}` : base, description: fm.description || firstLine(body), argumentHint: fm['argument-hint'] ?? '', source: o.source, ...(o.owner ? { owner: o.owner } : {}), kind: 'command' });
  }
}

const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The conversation's folder and the ones above it, up to (not including) the home folder. */
export function projectDirs(cwd: string | undefined, home: string): string[] {
  if (!cwd || !path.isAbsolute(cwd)) return [];
  const out: string[] = [];
  let d = path.resolve(cwd);
  for (let i = 0; i < 20; i++) {
    if (same(d, path.resolve(home))) break;
    out.push(d);
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

async function readJson(file: string): Promise<any> {
  const t = await readText(file);
  if (t === null) return null;
  try { return JSON.parse(noBom(t)); } catch { return null; }
}

async function pluginName(dir: string, fallback: string): Promise<string> {
  const m = await readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
  return typeof m?.name === 'string' && m.name.trim() ? m.name.trim() : fallback;
}

async function addPlugin(out: SlashCommandInfo[], dir: string, fallbackName: string): Promise<void> {
  const owner = await pluginName(dir, fallbackName);
  await addSkills(out, path.join(dir, 'skills'), { source: 'plugin', owner });
  await addCommands(out, path.join(dir, 'commands'), { source: 'plugin', owner });
}

/** installed_plugins.json's plugins this folder loads: user-wide ones, and project ones installed for a folder it is in. */
async function installedPlugins(claudeDir: string, cwd: string | undefined): Promise<{ id: string; dir: string }[]> {
  const installed = await readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const settings = [path.join(claudeDir, 'settings.json'), ...(cwd ? [path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')] : [])];
  const enabled: Record<string, unknown> = {};
  for (const f of settings) Object.assign(enabled, (await readJson(f))?.enabledPlugins ?? {});
  const inside = (p: unknown) => {
    if (typeof p !== 'string' || !cwd) return false;
    const c = path.resolve(cwd), r = path.resolve(p);
    return same(c, r) || same(c.slice(0, r.length + 1), r + path.sep);
  };
  const out: { id: string; dir: string }[] = [];
  for (const [id, arr] of Object.entries<any>(installed?.plugins ?? {})) {
    // Claude Code loads the ids listed in `enabledPlugins` with a value other than false (the official binary:
    // `Object.entries(enabledPlugins).filter(([, v]) => v !== false)`); an installed plugin left out of it is not loaded
    if (enabled[id] === undefined || enabled[id] === false) continue;
    const list = Array.isArray(arr) ? arr : [arr];
    const pick = list.find((x: any) => typeof x?.installPath === 'string' && (!x.projectPath || inside(x.projectPath)));
    if (pick) out.push({ id, dir: pick.installPath });
  }
  return out;
}

export interface DiskOpts { claudeDir: string; cwd?: string; home?: string; pluginDirs?: readonly string[] }

/** Every skill and command on disk a conversation in `cwd` can run, one row per name. */
export async function scanSlashDisk(o: DiskOpts): Promise<SlashCommandInfo[]> {
  const out: SlashCommandInfo[] = [];
  const projects = projectDirs(o.cwd, o.home ?? os.homedir());
  await addSkills(out, path.join(o.claudeDir, 'skills'), { source: 'user' });
  for (const d of projects) await addSkills(out, path.join(d, '.claude', 'skills'), { source: 'project' });
  await addCommands(out, path.join(o.claudeDir, 'commands'), { source: 'user' });
  for (const d of projects) await addCommands(out, path.join(d, '.claude', 'commands'), { source: 'project' });
  for (const p of await installedPlugins(o.claudeDir, o.cwd)) await addPlugin(out, p.dir, p.id.split('@')[0]);
  for (const d of o.pluginDirs ?? []) await addPlugin(out, d, path.basename(d));
  return normalizeCommands(out);
}

// ---- the engine's own commands, as last reported ----

let cache: Partial<Record<RuntimeKind, SlashCommandInfo[]>> | null = null;
let cacheAt = '';
const cacheFile = () => path.join(dataDir(), 'runtime', 'slash-commands.json');

function loaded(): Partial<Record<RuntimeKind, SlashCommandInfo[]>> {
  const file = cacheFile();
  if (cache && cacheAt === file) return cache;
  cacheAt = file;
  cache = {};
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    for (const k of ['ccb', 'claude'] as const) if (Array.isArray(j?.[k])) cache[k] = engineOwnRows(normalizeCommands(j[k]));
  } catch { /* none yet */ }
  return cache;
}

/** A running conversation's list (normalized): its engine's own commands are kept for the menus of the others. */
export function rememberEngineCommands(kind: RuntimeKind | undefined, list: readonly SlashCommandInfo[]): void {
  if (kind !== 'ccb' && kind !== 'claude') return;
  const own = engineOwnRows(list);
  if (!own.length) return;
  const c = loaded();
  if (JSON.stringify(c[kind]) === JSON.stringify(own)) return;
  c[kind] = own;
  const file = cacheFile();
  void fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, JSON.stringify(c))).catch(() => { /* in memory still */ });
}

export function engineCommands(kind: RuntimeKind | undefined): SlashCommandInfo[] {
  return kind ? loaded()[kind] ?? [] : [];
}

/** For tests: forget what was read. */
export function resetEngineCommands(): void { cache = null; cacheAt = ''; }

const memo = new Memo<SlashCommandInfo[]>(5_000);

/** `slash.list`: the engine's own commands first (a skill of the same name does not replace one), then the disk. */
export function slashList(o: { cwd?: string; claudeDir: string; kind?: RuntimeKind; pluginDirs?: () => readonly string[] }): Promise<SlashCommandInfo[]> {
  const cwd = o.cwd && path.isAbsolute(o.cwd) ? o.cwd : undefined;
  return memo.get(`${o.kind ?? ''}|${cwd ?? ''}`, async () => normalizeCommands([...engineCommands(o.kind), ...(await scanSlashDisk({ claudeDir: o.claudeDir, cwd, pluginDirs: o.pluginDirs?.() }))]));
}
