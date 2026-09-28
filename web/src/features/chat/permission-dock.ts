// The permission / question / plan card docked above the composer (redesign phase 5, spec §5.3 / §5.11): what it
// says, what 总是允许 is called, which step in the conversation waits on it, and — the part that has to be exactly
// right — what Enter in the composer does while it is there. Pure; the card is PermissionCards.tsx.
import type { PermissionRequestEvent, PermissionResponse } from '@shared';
import { walkTools, type Item, type ToolUseBlock } from '@/model/conversation';
import { basename } from '@/util';

export type DockKind = 'tool' | 'ask' | 'plan';

export const dockKind = (p: Pick<PermissionRequestEvent, 'toolName'>): DockKind => (p.toolName === 'AskUserQuestion' ? 'ask' : p.toolName === 'ExitPlanMode' ? 'plan' : 'tool');

/** How long a card (or the next one taking its place) is on screen before an empty Enter may answer it. */
export const DOCK_COOLDOWN_MS = 600;

/**
 * What the composer knows about the card docked above it: when it came (`shownAt`), whether the box already had
 * words then (`carried` — cleared once the box is emptied), and the message those words were queued as by the
 * first Enter (`queued`: the card's 「改用排队的这段话拒绝」 button can take it back as the reason — a click only:
 * what Enter means never depends on state the user cannot see).
 */
export interface DockSeen { requestId: string; shownAt: number; carried: boolean; queued?: { id: string; text: string } }

/**
 * What Enter (`enter` set) or the send slot (`enter` absent) in the composer does while a card sits above it:
 *  - `send`: an ordinary message (queued behind the turn, as before) — no card; a slash command (/compact, /goal …);
 *    words that were in the box before the card came (`carried`: the user was writing the next message); only
 *    attachments without words. Never an approval.
 *  - `deny`: words typed while the card is up → deny with them as the reason (the old card's 「拒绝理由 / 修改意见」
 *    field, now the composer);
 *  - `blocked`: words and attachments typed while the card is up — a deny carries text only, so neither is sent
 *    (review M2; the composer says why);
 *  - `primary`: an empty Enter on a card that has been on screen for `DOCK_COOLDOWN_MS` → its main button (允许一次 /
 *    提交回答; a plan only on Ctrl+Enter — it is long, and an Enter while reading it must not start the work). Also
 *    right after carried words were queued: taking them back as the reason is the card's button, not an Enter;
 *  - `ignore`: anything else — a held-down Enter, an Enter in a card's first moments (the next card replacing the one
 *    just answered, a card arriving while the user types), an empty Enter on a plan, the send button on an empty box.
 * Review I3.
 */
export type DockAct = 'send' | 'deny' | 'blocked' | 'primary' | 'ignore';
/** Why an Enter did nothing, when the user should be told (the card's status line, review M-6): too soon, or a plan. */
export type DockWhy = 'soon' | 'plan';
type DockInput = { text: string; attachments: boolean; seen?: DockSeen | null; now: number; enter?: { repeat?: boolean; ctrl?: boolean } };

export function dockDecide(p: PermissionRequestEvent | undefined, o: DockInput): { act: DockAct; why?: DockWhy } {
  if (!p) return { act: 'send' };
  if (o.enter?.repeat) return { act: 'ignore' };
  const seen = o.seen && o.seen.requestId === p.requestId ? o.seen : null;
  const words = o.text.trim();
  if (words) {
    if (isSlashCommand(words) || seen?.carried) return { act: 'send' };
    return { act: o.attachments ? 'blocked' : 'deny' };
  }
  if (o.attachments) return { act: 'send' };
  if (!o.enter) return { act: 'ignore' };
  if (!seen || o.now - seen.shownAt < DOCK_COOLDOWN_MS) return { act: 'ignore', why: 'soon' };
  if (dockKind(p) === 'plan' && !o.enter.ctrl) return { act: 'ignore', why: 'plan' };
  return { act: 'primary' };
}
export const dockAction = (p: PermissionRequestEvent | undefined, o: DockInput): DockAct => dockDecide(p, o).act;

/**
 * A slash command: `/name` and then a space or the end — `/compact`, `/goal 把测试补齐`, `/plugin:cmd`. Not a path
 * or anything else that starts with a slash (`/usr/bin 下没有这个`: an answer to the card, review M-10).
 */
export const isSlashCommand = (words: string): boolean => /^\/[A-Za-z][\w:-]*(\s|$)/.test(words.trim());

/** The main-button registry's key: the composer's pane and tile + the request (one conversation can be open in two panes: review M3). */
export const primaryKey = (scope: string, requestId: string): string => `${scope}\u0000${requestId}`;

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

/** One suggestion in words (the first half of the 总是允许 label), or null when it has no short name. */
function suggestionLabel(s: Record<string, any>): string | null {
  if (s?.type === 'addRules' && Array.isArray(s.rules)) {
    if (s.rules.length !== 1) return s.rules.length > 1 ? `总是允许 ${s.rules.length} 条规则` : null;
    const r = s.rules[0] ?? {};
    const what = String(r.ruleContent ?? '').replace(/:\*$/, '').trim() || String(r.toolName ?? '');
    return what ? `总是允许 ${what.length > MAX_RULE ? `${what.slice(0, MAX_RULE)}…` : what}` : null;
  }
  if (s?.type === 'setMode' && s.mode === 'acceptEdits') return '这个对话里都允许改文件';
  if (s?.type === 'addDirectories') return '总是允许这个目录';
  return null;
}

/**
 * The 总是允许 button's words, from the request's suggestions (what the CLI would write into the permission rules);
 * `null` = no suggestions → no button (as before). The button writes every suggestion (like the CLI's 「don't ask
 * again」), so with several the words say 「等 N 项」 and the tooltip (`alwaysDetails`) lists each (review M4).
 */
export function alwaysLabel(suggestions: unknown[] | undefined): string | null {
  if (!suggestions?.length) return null;
  const list = suggestions as Record<string, any>[];
  const first = list.map(suggestionLabel).find((x) => x) ?? '总是允许';
  return list.length > 1 ? `${first} 等 ${list.length} 项` : first;
}

const WHERE: Record<string, string> = { session: '只在这个对话里', localSettings: '写入本项目的本地设置', projectSettings: '写入项目设置（会进版本库）', userSettings: '写入你的用户设置', cliArg: '只在这次运行里' };
const MODE: Record<string, string> = { acceptEdits: '自动接受改动', bypassPermissions: '完全放开', plan: '只规划', default: '每步询问' };

/** Each suggestion 总是允许 would write, with where it goes (the button's tooltip). */
export function alwaysDetails(suggestions: unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const s of (suggestions ?? []) as Record<string, any>[]) {
    const where = WHERE[String(s?.destination)] ?? String(s?.destination ?? '');
    const tail = where ? ` · ${where}` : '';
    if (s?.type === 'addRules' || s?.type === 'replaceRules') for (const r of (s.rules ?? []) as Record<string, any>[]) out.push(`${s.behavior === 'deny' ? '拒绝' : s.behavior === 'ask' ? '询问' : '允许'}规则 ${r.toolName ?? ''}${r.ruleContent ? `(${r.ruleContent})` : ''}${tail}`);
    else if (s?.type === 'addDirectories') for (const d of (s.directories ?? []) as string[]) out.push(`允许访问目录 ${d}${tail}`);
    else if (s?.type === 'setMode') out.push(`切换到「${MODE[String(s.mode)] ?? s.mode}」模式${tail}`);
    else out.push(`${String(s?.type ?? '规则')}${tail}`);
  }
  return out;
}

/**
 * The steps that wait on the user (「等你确认」 on their node): the request's tool use id — and, for Codex, the steps
 * made from that item (a file-change approval names the item; its steps are `<item>:<path>`, review M5); an agent
 * that sends no id (some ACP agents) → the last unfinished call of that tool.
 */
export function waitingToolIds(pending: PermissionRequestEvent[], items: Item[]): Set<string> {
  const out = new Set<string>();
  if (!pending.length) return out;
  let all: { tool: ToolUseBlock }[] | null = null;
  for (const p of pending) {
    if (p.toolUseId) {
      out.add(p.toolUseId);
      all ??= [...walkTools(items)];
      const pre = `${p.toolUseId}:`;
      for (const { tool } of all) if (tool.id.startsWith(pre)) out.add(tool.id);
      continue;
    }
    all ??= [...walkTools(items)];
    for (let i = all.length - 1; i >= 0; i--) {
      const t = all[i].tool;
      if (t.name === p.toolName && (t.status === 'pending' || t.status === 'running' || t.status === 'streaming')) { out.add(t.id); break; }
    }
  }
  return out;
}
