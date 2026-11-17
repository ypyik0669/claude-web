// 添加文件夹 (+ menu): a conversation's own extra working directories (SessionMeta.extraDirs, written by
// session.setExtraDirs; the server merges them with the project's into the SDK's additionalDirectories / Codex's
// writable roots). Who can add one, the welcome page's list for the conversation about to start, and the rows of the
// info column's 环境 card. Pure.
import { tr } from '@/i18n';

/** A path compared the way the server does (meta/workspace-folders.ts): either slash, no trailing one, Windows paths caseless. */
const key = (p: string): string => {
  const s = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:|^\/\//i.test(s) ? s.toLowerCase() : s;
};
export const sameDirPath = (a: string, b: string): boolean => !!a && !!b && key(a) === key(b);

/** `dir` added to `list` — the same list (by reference) when it is already there or is one of `taken` (the conversation's folder, the project's). */
export function withDir(list: readonly string[], dir: string, taken: readonly string[] = []): readonly string[] {
  const d = dir.trim();
  if (!d || taken.some((t) => sameDirPath(t, d)) || list.some((x) => sameDirPath(x, d))) return list;
  return [...list, d];
}

export function withoutDir(list: readonly string[], dir: string): string[] {
  return list.filter((x) => !sameDirPath(x, dir));
}

/**
 * Why 添加文件夹 cannot give this conversation another working directory (undefined = it can). The folder is picked on
 * the machine the server runs on, so the conversation's agent has to run there, on that disk: not another machine's
 * conversation, not one in WSL (the distro's own Claude Code, Linux paths). A 只聊天 conversation has no tools to use
 * one with. ACP agents (Gemini, Qwen, OpenCode…) take no such parameter; Claude (additionalDirectories) and Codex
 * (writable roots) do.
 */
export function dirsOff(o: { remote?: boolean; wsl?: boolean; chatOnly?: boolean; protocol?: 'claude' | 'codex' | 'acp'; agentName?: string }): string | undefined {
  if (o.remote) return tr('其它机器上的对话不能添加这台电脑上的文件夹');
  if (o.wsl) return tr('WSL 里的对话不能添加这台电脑上的文件夹');
  if (o.chatOnly) return tr('只聊天的对话没有工具，用不上工作目录');
  if (o.protocol === 'acp') return tr('{name} 不支持额外的工作目录。要用别处的文件，在消息里写出它的完整路径', { name: o.agentName || 'Agent' });
  return undefined;
}

export interface EnvFolder { path: string; from: 'project' | 'conversation' }

/**
 * The 环境 card's folder rows after the main one: the project's extra folders (changed in the project's settings), then
 * the conversation's own (removable on the card) — each once, never the main folder. A folder in both is the
 * project's: removing it from the conversation would not take it away.
 */
export function envFolders(cwd: string, project: readonly string[], own: readonly string[]): EnvFolder[] {
  const out: EnvFolder[] = [];
  const seen = (p: string) => sameDirPath(p, cwd) || out.some((x) => sameDirPath(x.path, p));
  for (const p of project) if (p && !seen(p)) out.push({ path: p, from: 'project' });
  for (const p of own) if (p && !seen(p)) out.push({ path: p, from: 'conversation' });
  return out;
}
