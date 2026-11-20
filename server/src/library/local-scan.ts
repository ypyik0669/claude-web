// 本机发现: which other agents / editors keep data on THIS computer, and whether the conversation library can read
// it. A bounded look at known directories only — never the whole disk, never a credential file, never a process.
// `readable` means a SessionSource exists for it (the switch next to it in 设置 → 记忆与对话库); the rest is listed so the
// user sees what was found instead of guessing why a tool is missing.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LocalHistorySource } from '../protocol.js';
import { tr } from '../i18n/index.js';

interface Candidate {
  id: string;
  name: string;
  /** where it keeps its data; the first one that exists is reported */
  dirs: string[];
  /** a SessionSource can list / read its conversations */
  readable?: boolean;
  /** what the user sees when it can be read, or what is missing when it cannot */
  note?: string;
  /** a quick look inside: does it hold anything besides settings? */
  inspect?: (dir: string) => Promise<string | undefined>;
}

const home = () => os.homedir();
const appData = (env: NodeJS.ProcessEnv) => env.APPDATA ?? path.join(home(), 'AppData', 'Roaming');
const localAppData = (env: NodeJS.ProcessEnv) => env.LOCALAPPDATA ?? path.join(home(), 'AppData', 'Local');

const entries = async (dir: string): Promise<string[]> => {
  try { return await fs.readdir(dir); } catch { return []; }
};

export function localCandidates(env: NodeJS.ProcessEnv = process.env, homeDir = home()): Candidate[] {
  const h = homeDir;
  return [
    {
      id: 'cursor', name: 'Cursor', readable: true, dirs: [path.join(h, '.cursor', 'projects')],
      note: tr('只读：可以查看和搜索它的历史对话，不能接着聊'),
    },
    {
      id: 'dsh', name: 'DeepSeek Harness', readable: true, dirs: [env.DSH_HOME?.trim() || path.join(h, '.dsh')],
      note: tr('只读：可以查看和搜索它的历史对话，不能接着聊'),
    },
    {
      id: 'antigravity', name: 'Antigravity', readable: true,
      dirs: [path.join(h, '.gemini', 'antigravity', 'conversations'), path.join(h, '.gemini', 'antigravity-ide', 'conversations')],
      note: tr('可以查看和搜索它的历史对话；接着聊会在 Claude 里开一个新对话，接上之前的内容'),
    },
    {
      id: 'workbuddy', name: 'WorkBuddy', dirs: [path.join(h, '.workbuddy')],
      inspect: async (d) => (await entries(d)).includes('sessions') ? tr('只找到运行记录，还没找到可读的对话文件') : undefined,
    },
    {
      id: 'zcode', name: 'Zcode', dirs: [path.join(h, '.zcode'), path.join(appData(env), 'Zcode'), path.join(localAppData(env), 'Zcode')],
      inspect: async (d) => (await entries(d)).length ? tr('找到本机数据，但还没有确认它的对话格式') : undefined,
    },
    {
      id: 'hermes', name: 'Hermes', dirs: [env.HERMES_HOME ?? path.join(h, '.hermes')],
      inspect: async (d) => (await entries(d)).includes('config.yaml') ? tr('有配置（供应商 / MCP），没有找到可读的对话记录') : undefined,
    },
    {
      id: 'openclaw', name: 'OpenClaw', dirs: [path.join(h, '.openclaw'), path.join(h, '.open-claw'), path.join(appData(env), 'OpenClaw')],
      inspect: async (d) => (await entries(d)).length ? tr('找到本机数据，但还没有确认它的对话格式') : undefined,
    },
    {
      id: 'kiro', name: 'Kiro', dirs: [path.join(h, '.kiro')],
      inspect: async (d) => (await entries(d)).length ? tr('目前只找到配置') : undefined,
    },
    {
      id: 'windsurf', name: 'Windsurf', dirs: [path.join(h, '.windsurf'), path.join(h, '.codeium', 'windsurf')],
      inspect: async (d) => (await entries(d)).length ? tr('找到本机数据，但还没有确认它的对话格式') : undefined,
    },
  ];
}

let cached: { key: string; at: number; items: LocalHistorySource[] } | null = null;

export async function scanLocalHistory(env: NodeJS.ProcessEnv = process.env, now = Date.now(), homeDir = home()): Promise<LocalHistorySource[]> {
  if (cached && cached.key === homeDir && now - cached.at < 60_000) return cached.items;
  const items: LocalHistorySource[] = [];
  for (const c of localCandidates(env, homeDir)) {
    let dir: string | undefined;
    for (const d of c.dirs) {
      try { if ((await fs.stat(d)).isDirectory()) { dir = d; break; } } catch { /* not there */ }
    }
    if (!dir) continue;
    let detail = c.note;
    if (!c.readable && c.inspect) detail = (await c.inspect(dir).catch(() => undefined)) ?? c.note;
    items.push({ id: c.id, name: c.name, path: dir, readable: !!c.readable, detail });
  }
  cached = { key: homeDir, at: now, items };
  return items;
}
