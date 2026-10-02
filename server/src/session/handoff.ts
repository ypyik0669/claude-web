import { randomUUID } from 'node:crypto';
import type { CanonicalEvent } from './canonical.js';
import type { AgentKind } from '../protocol.js';

/**
 * Handing a session to a different agent.
 *
 * Two transports, and the choice is not about taste:
 *
 * - `renderBriefing()` — a structured summary sent as the first user message. This is the universal
 *   floor: it works against any agent, including a Gemini CLI that advertises `loadSession: false`,
 *   and it is what Anthropic's own docs recommend over shipping transcript files around. OpenAI's
 *   first-party Claude importer chose the same shape.
 * - `toClaudeEntries()` — synthesized transcript entries for the Agent SDK's `SessionStore.load()`,
 *   which materializes them to a temp JSONL the subprocess resumes from natively. A supported API,
 *   not file forgery under ~/.claude/projects.
 *
 * Neither carries reasoning, because neither can: Claude's thinking blocks are signed and Codex's
 * reasoning items are encrypted, and both are rejected outside their origin provider.
 */

/** The briefing's first line. A conversation list that titles a conversation by a prompt skips a prompt that starts with it. */
export const BRIEFING_HEAD = '# 会话交接';

const AGENT_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', qwen: 'Qwen Code', kimi: 'Kimi CLI' };

const shortPath = (p: unknown) => (typeof p === 'string' ? p.replace(/\\/g, '/').split('/').slice(-2).join('/') : '');
const oneLine = (s: string, n = 160) => s.replace(/\s+/g, ' ').trim().slice(0, n);

export interface Briefing {
  text: string;
  turns: number;
  filesTouched: string[];
}

/**
 * Render the timeline as a briefing, not a dump: what was decided, what is true on disk now, what
 * was tried and failed, and what is still open. A raw transcript replay would waste context on tool
 * chatter the new agent can just re-read from the files.
 */
export function renderBriefing(events: CanonicalEvent[], opts: { objective?: string; fromAgent?: AgentKind; toAgent?: AgentKind; cwd?: string } = {}): Briefing {
  const users = events.filter((e): e is Extract<CanonicalEvent, { kind: 'user' }> => e.kind === 'user');
  const assistants = events.filter((e): e is Extract<CanonicalEvent, { kind: 'assistant' }> => e.kind === 'assistant');
  const tools = events.filter((e): e is Extract<CanonicalEvent, { kind: 'tool' }> => e.kind === 'tool');
  const results = events.filter((e): e is Extract<CanonicalEvent, { kind: 'result' }> => e.kind === 'result');

  const edited = new Map<string, number>();
  const read = new Set<string>();
  const commands: string[] = [];
  const failures: string[] = [];
  for (const t of tools) {
    const p = (t.input.file_path ?? t.input.notebook_path ?? t.input.path) as string | undefined;
    if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(t.name) && p) edited.set(p, (edited.get(p) ?? 0) + 1);
    if (/^(Read|Glob|Grep)$/.test(t.name) && p) read.add(p);
    if (/^(Bash|PowerShell)$/.test(t.name) && typeof t.input.command === 'string') commands.push(t.input.command);
    if (t.ok === false) failures.push(`${t.name}${p ? ` ${shortPath(p)}` : typeof t.input.command === 'string' ? ` \`${oneLine(t.input.command, 70)}\`` : ''} — ${oneLine(t.result ?? '失败', 110)}`);
  }

  const lines: string[] = [];
  lines.push(BRIEFING_HEAD);
  lines.push('');
  lines.push(
    `这个会话之前由 **${AGENT_LABEL[opts.fromAgent ?? ''] ?? opts.fromAgent ?? '另一个 agent'}** 在跑，现在交给你（${AGENT_LABEL[opts.toAgent ?? ''] ?? opts.toAgent ?? '你'}）继续。` +
      '下面是它的完整交接说明——原始对话不会带过来（各家的推理内容带签名/加密，跨厂商无法携带），但磁盘上的改动都在，需要细节请直接读文件。',
  );
  lines.push('');

  if (opts.objective) {
    lines.push('## 当前目标');
    lines.push(opts.objective);
    lines.push('');
  } else if (users.length) {
    lines.push('## 最初的要求');
    lines.push(oneLine(users[0].text, 600));
    lines.push('');
  }

  if (users.length > 1) {
    lines.push('## 期间用户还说过');
    for (const u of users.slice(1).slice(-6)) lines.push(`- ${oneLine(u.text, 220)}`);
    lines.push('');
  }

  if (edited.size) {
    lines.push('## 磁盘现状（已改动的文件）');
    for (const [p, n] of [...edited].slice(0, 30)) lines.push(`- \`${p}\`${n > 1 ? ` · 改了 ${n} 次` : ''}`);
    if (edited.size > 30) lines.push(`- …另有 ${edited.size - 30} 个文件`);
    lines.push('');
  }

  if (commands.length) {
    lines.push('## 跑过的命令');
    const seen = new Set<string>();
    for (const c of commands.slice(-14)) {
      const k = oneLine(c, 120);
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push(`- \`${k}\``);
    }
    lines.push('');
  }

  if (failures.length) {
    lines.push('## 试过但失败的（别重复踩）');
    for (const f of failures.slice(-10)) lines.push(`- ${f}`);
    lines.push('');
  }

  const lastReply = assistants[assistants.length - 1]?.text;
  if (lastReply) {
    lines.push('## 上一个 agent 最后说的');
    lines.push(oneLine(lastReply, 1200));
    lines.push('');
  }

  const err = results.filter((r) => r.error).slice(-1)[0];
  if (err) {
    lines.push('## 上一轮以错误结束');
    lines.push(err.error!);
    lines.push('');
  }

  if (read.size) lines.push(`读过但没改的文件：${[...read].slice(0, 12).map((p) => `\`${shortPath(p)}\``).join('、')}${read.size > 12 ? ' 等' : ''}`);
  if (opts.cwd) lines.push(`工作目录：\`${opts.cwd}\``);
  lines.push('');
  lines.push('先确认你理解了上面的状态（必要时读几个关键文件核对），然后继续推进，不要从头再来。');

  return { text: lines.join('\n'), turns: results.length, filesTouched: [...edited.keys()] };
}

/**
 * Synthesize Claude Code transcript entries from the canonical timeline, for
 * `SessionStore.load()`. The SDK materializes whatever we return into a temp JSONL and the
 * subprocess resumes from it with its existing resume code; entries are documented as
 * pass-through blobs, so only the discriminating `type` and the parent chain have to be right.
 *
 * Tool calls are rendered as plain text rather than tool_use/tool_result pairs: the vocabularies
 * don't line up across vendors (shell/apply_patch vs Bash/Edit), and a mismatched pair is worse
 * than a sentence describing what happened.
 */
export function toClaudeEntries(events: CanonicalEvent[], opts: { cwd: string; sessionId: string; briefing?: string }): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let parentUuid: string | null = null;
  const base = (extra: Record<string, unknown>) => {
    const uuid = randomUUID();
    const row = { parentUuid, isSidechain: false, userType: 'external', cwd: opts.cwd, sessionId: opts.sessionId, version: '2.0.0', uuid, timestamp: new Date().toISOString(), ...extra };
    parentUuid = uuid;
    out.push(row);
    return row;
  };
  const user = (text: string) => base({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  const assistant = (text: string) => base({ type: 'assistant', message: { role: 'assistant', model: 'external', content: [{ type: 'text', text }] } });

  if (opts.briefing) {
    user(opts.briefing);
    assistant('已接手，我读到了上面的交接说明，会在这个基础上继续。');
    return out;
  }

  const pending: string[] = [];
  const flush = () => {
    if (!pending.length) return;
    assistant(pending.join('\n'));
    pending.length = 0;
  };
  for (const e of events) {
    if (e.kind === 'user') { flush(); user(e.text); }
    else if (e.kind === 'assistant') pending.push(e.text);
    else if (e.kind === 'tool') {
      const p = (e.input.file_path ?? e.input.path) as string | undefined;
      const arg = p ?? (typeof e.input.command === 'string' ? e.input.command : '');
      pending.push(`（${e.name}${arg ? ` ${oneLine(String(arg), 90)}` : ''}${e.ok === false ? ' — 失败' : ''}）`);
    } else if (e.kind === 'switch' && e.note) pending.push(`（${e.note}）`);
  }
  flush();
  return out;
}
