// The permission / question / plan card docked above the composer (redesign phase 5, spec §5.3 / §5.11): what it
// says, what 总是允许 is called, which step in the conversation waits on it, and — the part that has to be exactly
// right — what Enter in the composer does while it is there. Pure; the card is PermissionCards.tsx.
import type { PermissionRequestEvent, PermissionResponse } from '@shared';
import { walkTools, type Item, type ToolUseBlock } from '@/model/conversation';
import { basename } from '@/util';

export type DockKind = 'tool' | 'ask' | 'plan';

export const dockKind = (p: Pick<PermissionRequestEvent, 'toolName'>): DockKind => (p.toolName === 'AskUserQuestion' ? 'ask' : p.toolName === 'ExitPlanMode' ? 'plan' : 'tool');

/**
 * What Enter (or the send slot) in the composer does while a card sits above it:
 *  - `deny`: the box has words → deny with them as the reason (the old card's 「拒绝理由 / 修改意见」 field, now the
 *    composer: same response the card sent);
 *  - `primary`: the box is empty → the card's main button (允许一次 ↵ / 批准并开始 / 提交回答 when complete);
 *  - `send`: no card, or only attachments without words → an ordinary message (queued behind the turn, as before —
 *    never an approval).
 */
export type ComposerAct = 'send' | 'deny' | 'primary';
export function composerAct(p: PermissionRequestEvent | undefined, o: { text: string; attachments: boolean }): ComposerAct {
  if (!p) return 'send';
  if (o.text.trim()) return 'deny';
  return o.attachments ? 'send' : 'primary';
}

const DENY_DEFAULT: Record<DockKind, string> = { tool: '用户拒绝了这次操作', plan: '用户要求修改计划', ask: '用户取消了提问' };

/** The deny sent from the composer or the card's 拒绝 / 要求修改 / 跳过: the typed words, else each card's old default. */
export function denyResponse(p: PermissionRequestEvent, text: string): PermissionResponse {
  return { behavior: 'deny', message: text.trim() || DENY_DEFAULT[dockKind(p)] };
}

/** 「Claude 想运行一条命令」: what is being asked, in words. */
export function permissionTitle(p: Pick<PermissionRequestEvent, 'toolName' | 'input'>, agent = 'Claude'): string {
  const inp = (p.input ?? {}) as Record<string, unknown>;
  const file = basename(String(inp.file_path ?? inp.notebook_path ?? inp.path ?? '').replace(/[\\/]+$/, ''));
  switch (p.toolName) {
    case 'AskUserQuestion': return `${agent} 有问题要问你`;
    case 'ExitPlanMode': return `${agent} 想按这个计划开始动手`;
    case 'Bash': case 'PowerShell': return `${agent} 想运行一条命令`;
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return file ? `${agent} 想修改 ${file}` : `${agent} 想修改文件`;
    case 'Write': return file ? `${agent} 想写入 ${file}` : `${agent} 想写入文件`;
    case 'Read': return file ? `${agent} 想读取 ${file}` : `${agent} 想读取文件`;
    case 'WebFetch': {
      let host = '';
      try { host = new URL(String(inp.url ?? '')).host; } catch { /* not a URL */ }
      return host ? `${agent} 想访问 ${host}` : `${agent} 想访问网页`;
    }
    case 'WebSearch': return `${agent} 想搜索网页`;
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(p.toolName);
  if (mcp) return `${agent} 想使用 ${mcp[1]} 的 ${mcp[2]}`;
  return `${agent} 想使用 ${p.toolName}`;
}

const MAX_RULE = 25;

/**
 * The 总是允许 button's words, from the request's suggestions (what the CLI would write into the permission
 * rules); `null` = no suggestions → no button (as before).
 */
export function alwaysLabel(suggestions: unknown[] | undefined): string | null {
  if (!suggestions?.length) return null;
  for (const s of suggestions as Record<string, any>[]) {
    if (s?.type === 'addRules' && Array.isArray(s.rules) && s.rules.length === 1) {
      const r = s.rules[0] ?? {};
      const what = String(r.ruleContent ?? '').replace(/:\*$/, '').trim() || String(r.toolName ?? '');
      if (what) return `总是允许 ${what.length > MAX_RULE ? `${what.slice(0, MAX_RULE)}…` : what}`;
    }
    if (s?.type === 'setMode' && s.mode === 'acceptEdits') return '这个对话里都允许改文件';
    if (s?.type === 'addDirectories') return '总是允许这个目录';
  }
  return '总是允许';
}

/**
 * The steps that wait on the user (「等你确认」 on their node): the request's tool use id; an agent that sends no id
 * (some ACP agents) → the last unfinished call of that tool.
 */
export function waitingToolIds(pending: PermissionRequestEvent[], items: Item[]): Set<string> {
  const out = new Set<string>();
  if (!pending.length) return out;
  let all: { tool: ToolUseBlock }[] | null = null;
  for (const p of pending) {
    if (p.toolUseId) { out.add(p.toolUseId); continue; }
    all ??= [...walkTools(items)];
    for (let i = all.length - 1; i >= 0; i--) {
      const t = all[i].tool;
      if (t.name === p.toolName && (t.status === 'pending' || t.status === 'running' || t.status === 'streaming')) { out.add(t.id); break; }
    }
  }
  return out;
}
