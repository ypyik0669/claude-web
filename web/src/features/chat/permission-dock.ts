// The permission / question / plan card docked above the composer (redesign phase 5, spec §5.3 / §5.11): what it
// says, what 总是允许 is called, which step in the conversation waits on it, and — the part that has to be exactly
// right — what Enter in the composer does while it is there. Pure; the card is PermissionCards.tsx.
import type { PermissionRequestEvent, PermissionResponse } from '@shared';
import { walkTools, type Item, type ToolUseBlock } from '@/model/conversation';
import { basename } from '@/util';
import { webToolAsk, webToolOf } from '@/features/browser/web-tools';
import { accessTitle, computerToolLabel, computerToolOf, isAccessRequest } from '@/features/computer/computer-tools';
import { tr } from '@/i18n';
import { DOCK_PLACEHOLDER, DOCK_STATUS, DOCK_STATUS_CLICK } from '@/ui/terms';

/**
 * 允许的网站 (server/src/web/site-gate.ts SITE_TOOL): the built-in browser asks before an agent opens a site not on the
 * list or changes a page of one (op 'open' / click / type …), and before every script. A site on the list: nothing.
 */
export const SITE_TOOL = 'browser.site';

/**
 * The server's card before an ego lite script runs (site-gate.ts EGO_SCRIPT_TOOL, spec 14.1): a `browser.site` request
 * whose tool is `ego_browser`, the whole script in it. Not Claude's own prompt for `mcp__web__ego_browser`: none
 * should come (Claude has the tool in its allowed tools); ToolPermission keeps a fallback look for one all the same.
 */
export const isEgoScriptRequest = (p: Pick<PermissionRequestEvent, 'toolName' | 'input'>): boolean =>
  p.toolName === SITE_TOOL && (p.input as Record<string, unknown> | undefined)?.tool === 'ego_browser';

/**
 * The card's status line after its title: what an empty Enter does on it. A script card (ego lite, or a script in the
 * built-in browser) is allowed only with a click, like 操控电脑 — it never says Enter allows it.
 */
export function dockStatus(p: Pick<PermissionRequestEvent, 'toolName' | 'input'>): string {
  return isClickOnly(p) ? DOCK_STATUS_CLICK : DOCK_STATUS[dockKind(p)];
}

/** A script card (ego lite, or a script in the built-in browser): only a click on the card allows it, never a key. */
export const isClickOnly = (p: Pick<PermissionRequestEvent, 'toolName' | 'input'>): boolean =>
  isEgoScriptRequest(p) || (p.toolName === SITE_TOOL && (p.input as Record<string, unknown> | undefined)?.eval === true);

/** The composer's placeholder under a docked card: a click-only card's says nothing about Enter allowing it. */
export const dockPlaceholder = (p: Pick<PermissionRequestEvent, 'toolName' | 'input'>, agent: string): string =>
  isClickOnly(p) ? DOCK_PLACEHOLDER.click(agent) : DOCK_PLACEHOLDER[dockKind(p)](agent);

/** `access`: 操控电脑 asking which applications it may control — answered by a click on the card, never by a key. */
export type DockKind = 'tool' | 'ask' | 'plan' | 'access';

export const dockKind = (p: { toolName: string; input?: unknown }): DockKind => {
  const t = p.toolName;
  return t === 'AskUserQuestion' ? 'ask' : t === 'ExitPlanMode' ? 'plan' : isAccessRequest(t) ? 'access' : 'tool';
};

/** A conversation's waiting requests as the composer sees them: the question card lives in the conversation (stage C1), the rest dock. */
export function splitPending<P extends { toolName: string; input?: unknown }>(pending: readonly P[]): { dock?: P; ask?: P } {
  return { dock: pending.find((p) => dockKind(p) !== 'ask'), ask: pending.find((p) => dockKind(p) === 'ask') };
}

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
export type DockWhy = 'soon' | 'plan' | 'access';
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
  // control of the desktop is given with a click on the card: no key says yes to it, with Ctrl or without
  if (dockKind(p) === 'access') return { act: 'ignore', why: 'access' };
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

const DENY_DEFAULT: Record<DockKind, string> = { tool: tr('用户拒绝了这次操作'), plan: tr('用户要求修改计划'), ask: tr('用户取消了提问'), access: '' };

/** The deny sent from the composer or the card's 拒绝 / 要求修改 / 跳过: the typed words, else each card's old default. */
export function denyResponse(p: PermissionRequestEvent, text: string): PermissionResponse {
  return { behavior: 'deny', message: text.trim() || DENY_DEFAULT[dockKind(p)] };
}

/** 「Claude 想运行一条命令」: what is being asked, in words. */
export function permissionTitle(p: Pick<PermissionRequestEvent, 'toolName' | 'input'>, agent = 'Claude'): string {
  const inp = (p.input ?? {}) as Record<string, unknown>;
  const file = basename(String(inp.file_path ?? inp.notebook_path ?? inp.path ?? '').replace(/[\\/]+$/, ''));
  switch (p.toolName) {
    case 'AskUserQuestion': return tr('{agent} 有问题要问你', { agent });
    case 'ExitPlanMode': return tr('{agent} 想按这个计划开始动手', { agent });
    case 'Bash': case 'PowerShell': return tr('{agent} 想运行一条命令', { agent });
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return file ? tr('{agent} 想修改 {file}', { agent, file }) : tr('{agent} 想修改文件', { agent });
    case 'Write': return file ? tr('{agent} 想写入 {file}', { agent, file }) : tr('{agent} 想写入文件', { agent });
    case 'Read': return file ? tr('{agent} 想读取 {file}', { agent, file }) : tr('{agent} 想读取文件', { agent });
    case 'WebFetch': {
      let host = '';
      try { host = new URL(String(inp.url ?? '')).host; } catch { /* not a URL */ }
      return host ? tr('{agent} 想访问 {host}', { agent, host }) : tr('{agent} 想访问网页', { agent });
    }
    case 'WebSearch': return tr('{agent} 想搜索网页', { agent });
    case SITE_TOOL: {
      const host = String(inp.host ?? '');
      if (isEgoScriptRequest(p)) return host ? tr('{agent} 想在 ego lite 里运行一段脚本（{h}）', { agent, h: host }) : tr('{agent} 想在 ego lite 里运行一段脚本', { agent });
      if (inp.eval === true) return host ? tr('{agent} 想在 {host} 上运行一段脚本', { agent, host }) : tr('{agent} 想在页面上运行一段脚本', { agent });
      // opening a site not on 允许的网站 (browser_open, a new tab with an address): asked before the page is loaded
      if (inp.op === 'open' && host) return tr('{agent} 想打开 {host}（这个网站还没允许过）', { agent, host });
      return host ? tr('{agent} 想在 {host} 上操作页面', { agent, host }) : tr('{agent} 想在页面上操作', { agent });
    }
  }
  const web = webToolOf(p.toolName);
  if (web) return webToolAsk(web, inp, agent);
  const computer = computerToolOf(p.toolName);
  if (computer === 'request_access') return accessTitle(inp, agent);
  // (its other tools are not asked about one by one; another host's prompt for one reads as what it does)
  if (computer) return tr('{agent} 想{replace}', { agent, replace: computerToolLabel(computer, inp).verb.replace(/[:：]$/, '') });
  const mcp = /^mcp__(.+?)__(.+)$/.exec(p.toolName);
  if (mcp) return tr('{agent} 想使用 {v} 的 {v2}', { agent, v: mcp[1], v2: mcp[2] });
  return tr('{agent} 想使用 {toolName}', { agent, toolName: p.toolName });
}

const MAX_RULE = 25;

/** One suggestion in words (the first half of the 总是允许 label), or null when it has no short name. */
function suggestionLabel(s: Record<string, any>): string | null {
  if (s?.type === 'addRules' && Array.isArray(s.rules)) {
    if (s.rules.length !== 1) return s.rules.length > 1 ? tr('总是允许 {rulesCount} 条规则', { rulesCount: s.rules.length }) : null;
    const r = s.rules[0] ?? {};
    const what = String(r.ruleContent ?? '').replace(/:\*$/, '').trim() || String(r.toolName ?? '');
    return what ? tr('总是允许 {what}', { what: what.length > MAX_RULE ? `${what.slice(0, MAX_RULE)}…` : what }) : null;
  }
  if (s?.type === 'setMode' && s.mode === 'acceptEdits') return tr('这个对话里都允许改文件');
  if (s?.type === 'addDirectories') return tr('总是允许这个目录');
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
  const first = list.map(suggestionLabel).find((x) => x) ?? tr('总是允许');
  return list.length > 1 ? tr('{first} 等 {listCount} 项', { first, listCount: list.length }) : first;
}

const WHERE: Record<string, string> = { session: tr('只在这个对话里'), localSettings: tr('写入本项目的本地设置'), projectSettings: tr('写入项目设置（会进版本库）'), userSettings: tr('写入你的用户设置'), cliArg: tr('只在这次运行里') };
const MODE: Record<string, string> = { acceptEdits: tr('自动接受改动'), bypassPermissions: tr('完全放开'), plan: tr('只规划'), default: tr('每步询问') };

/** Each suggestion 总是允许 would write, with where it goes (the button's tooltip). */
export function alwaysDetails(suggestions: unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const s of (suggestions ?? []) as Record<string, any>[]) {
    const where = WHERE[String(s?.destination)] ?? String(s?.destination ?? '');
    const tail = where ? ` · ${where}` : '';
    if (s?.type === 'addRules' || s?.type === 'replaceRules') for (const r of (s.rules ?? []) as Record<string, any>[]) out.push(tr('{v}规则 {toolName}{v2}{tail}', { v: s.behavior === 'deny' ? tr('拒绝') : s.behavior === 'ask' ? tr('询问') : tr('允许'), toolName: r.toolName ?? '', v2: r.ruleContent ? `(${r.ruleContent})` : '', tail }));
    else if (s?.type === 'addDirectories') for (const d of (s.directories ?? []) as string[]) out.push(tr('允许访问目录 {d}{tail}', { d, tail }));
    else if (s?.type === 'setMode') out.push(tr('切换到「{mode}」模式{tail}', { mode: MODE[String(s.mode)] ?? s.mode, tail }));
    else out.push(`${String(s?.type ?? tr('规则'))}${tail}`);
  }
  return out;
}

/**
 * The steps that wait on the user (「等你确认」 on their node): the request's tool use id; a request without one → the
 * last unfinished call of that tool.
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
