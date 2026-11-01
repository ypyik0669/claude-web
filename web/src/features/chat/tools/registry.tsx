import type { ComponentType } from 'react';
import type { IconName } from '@/ui/icons';
import type { ToolUseBlock } from '@/model/conversation';
import { ReadBody, WriteBody, EditBody, NotebookBody } from './FileTools';
import { GlobBody, GrepBody } from './SearchTools';
import { ShellBody } from './ShellTool';
import { WebFetchBody, WebSearchBody, SkillBody } from './WebTools';
import { AgentBody, TodoBody, PlanBody, AskUserBody, ArtifactBody, GoalBody, WorkflowBody } from './AgentTool';
import { GenericBody } from './McpTool';
import { FindingsBody } from './FindingsTool';
import { TaskChipBody } from './TaskChip';
import { WEB_TOOLS, webToolLabel, webToolOf, type WebTool } from '@/features/browser/web-tools';
import { COMPUTER_TOOLS, computerToolLabel, computerToolOf, type ComputerTool } from '@/features/computer/computer-tools';
import { tr } from '@/i18n';
import { ThemeDraftBody } from './ThemeDraftTool';
import { SITE_TOOL } from '../permission-dock';

export type ToolCategory = 'read' | 'edit' | 'cmd' | 'web' | 'skill' | 'mcp' | 'agent' | 'plan' | 'other';

export interface ToolLabel { verb: string; arg: string }
export interface ToolDef {
  icon: IconName;
  category: ToolCategory;
  /** header: verb + argument, e.g. "读取文件:" + "src/a.ts:10-40" */
  label(input: Record<string, any>): ToolLabel;
  Body: ComponentType<{ t: ToolUseBlock }>;
  /** rendered standalone (not collapsed into a Steps row) */
  standalone?: boolean;
  /** a standalone card that starts open (its body is the point: the code review's findings) */
  defaultOpen?: boolean;
}

const s = (input: any, k: string) => (typeof input?.[k] === 'string' ? (input[k] as string) : '');

const DEFS: Record<string, ToolDef> = {
  Read: { icon: 'read', category: 'read', label: (i) => ({ verb: tr('读取文件:'), arg: `${s(i, 'file_path')}${i.offset ? `:${i.offset}${i.limit ? `-${Number(i.offset) + Number(i.limit) - 1}` : ''}` : ''}` }), Body: ReadBody },
  Write: { icon: 'write', category: 'edit', label: (i) => ({ verb: tr('写入文件:'), arg: s(i, 'file_path') }), Body: WriteBody },
  Edit: { icon: 'edit', category: 'edit', label: (i) => ({ verb: tr('编辑文件:'), arg: s(i, 'file_path') }), Body: EditBody },
  MultiEdit: { icon: 'edit', category: 'edit', label: (i) => ({ verb: tr('编辑文件:'), arg: tr('{s} · {editsCount} 处', { s: s(i, 'file_path'), editsCount: (i.edits as any[])?.length ?? 0 }) }), Body: EditBody },
  NotebookEdit: { icon: 'plan', category: 'edit', label: (i) => ({ verb: tr('编辑 Notebook:'), arg: `${s(i, 'notebook_path')}${i.cell_id ? ` · ${i.cell_id}` : ''}` }), Body: NotebookBody },
  Bash: { icon: 'bash', category: 'cmd', label: (i) => ({ verb: tr('运行命令:'), arg: s(i, 'command') || s(i, 'description') }), Body: ShellBody },
  PowerShell: { icon: 'bash', category: 'cmd', label: (i) => ({ verb: tr('运行命令:'), arg: s(i, 'command') }), Body: ShellBody },
  Glob: { icon: 'glob', category: 'read', label: (i) => ({ verb: tr('列出文件:'), arg: `${s(i, 'pattern')}${i.path ? ` in ${i.path}` : ''}` }), Body: GlobBody },
  Grep: { icon: 'search', category: 'read', label: (i) => ({ verb: tr('搜索文本:'), arg: `${s(i, 'pattern')}${i.path ? ` in ${i.path}` : ''}${i.glob ? ` (${i.glob})` : ''}` }), Body: GrepBody },
  WebFetch: { icon: 'web', category: 'web', label: (i) => ({ verb: 'Fetch', arg: s(i, 'url') }), Body: WebFetchBody },
  WebSearch: { icon: 'web', category: 'web', label: (i) => ({ verb: tr('搜索网页:'), arg: s(i, 'query') }), Body: WebSearchBody },
  Skill: { icon: 'skill', category: 'skill', label: (i) => ({ verb: 'Skill', arg: `/${s(i, 'skill')} ${s(i, 'args')}`.trim() }), Body: SkillBody },
  TodoWrite: { icon: 'todo', category: 'other', label: (i) => ({ verb: tr('更新计划'), arg: tr('{todosCount} 项', { todosCount: (i.todos as any[])?.length ?? 0 }) }), Body: TodoBody },
  Agent: { icon: 'agent', category: 'agent', standalone: true, label: (i) => ({ verb: i.subagent_type ? `[${i.subagent_type}]` : tr('子代理'), arg: s(i, 'description') || s(i, 'prompt').slice(0, 80) }), Body: AgentBody },
  Task: { icon: 'agent', category: 'agent', standalone: true, label: (i) => ({ verb: i.subagent_type ? `[${i.subagent_type}]` : tr('任务'), arg: s(i, 'description') || s(i, 'prompt').slice(0, 80) }), Body: AgentBody },
  // /code-review's findings (CLAUDE_CODE_REPORT_FINDINGS, set by the runner): a card of its own in the conversation
  // 字符画主题: the theme skill's draft, with its trial picture (server themes/tools.ts)
  mcp__web__theme_draft: { icon: 'sparkle', category: 'other', standalone: true, defaultOpen: true, label: (i) => ({ verb: tr('主题草稿'), arg: [i?.json?.name?.zh, i?.json?.id].filter(Boolean).join(' · ') }), Body: ThemeDraftBody },
  // 跨对话工具: a task worth its own conversation (server sessions-mcp suggest_task)
  mcp__sessions__suggest_task: { icon: 'sparkle', category: 'other', standalone: true, defaultOpen: true, label: (i) => ({ verb: tr('建议的任务'), arg: String(i.title ?? '') }), Body: TaskChipBody },
  ReportFindings: { icon: 'approval', category: 'other', standalone: true, defaultOpen: true, label: (i) => ({ verb: tr('代码审查'), arg: Array.isArray(i.findings) ? (i.findings.length ? tr('{n} 个发现', { n: i.findings.length }) : tr('没发现问题')) : '' }), Body: FindingsBody },
  ExitPlanMode: { icon: 'plan', category: 'plan', standalone: true, label: () => ({ verb: tr('请求批准计划'), arg: '' }), Body: PlanBody },
  EnterPlanMode: { icon: 'plan', category: 'plan', label: () => ({ verb: tr('进入计划模式'), arg: '' }), Body: GenericBody },
  AskUserQuestion: { icon: 'question', category: 'plan', standalone: true, label: (i) => ({ verb: tr('提问'), arg: (i.questions as any[])?.map((q) => q.question).join(' / ') ?? '' }), Body: AskUserBody },
  Artifact: { icon: 'artifact', category: 'other', standalone: true, label: (i) => ({ verb: 'Artifact', arg: s(i, 'title') || s(i, 'name') }), Body: ArtifactBody },
  Goal: { icon: 'goals', category: 'other', standalone: true, label: (i) => ({ verb: 'Goal', arg: s(i, 'action') || s(i, 'command') || s(i, 'objective').slice(0, 80) }), Body: GoalBody },
  Workflow: { icon: 'workflow', category: 'agent', standalone: true, label: (i) => ({ verb: 'Workflow', arg: s(i, 'name') }), Body: WorkflowBody },
  WebBrowser: { icon: 'web', category: 'web', label: (i) => ({ verb: tr('浏览器'), arg: s(i, 'action') || s(i, 'url') }), Body: GenericBody },
  Monitor: { icon: 'eye', category: 'other', label: (i) => ({ verb: tr('监视'), arg: s(i, 'command') || s(i, 'description') }), Body: GenericBody },
  SendMessage: { icon: 'send', category: 'other', label: (i) => ({ verb: tr('发消息'), arg: s(i, 'to') || s(i, 'recipient') }), Body: GenericBody },
  TaskOutput: { icon: 'archive', category: 'other', label: (i) => ({ verb: tr('任务输出'), arg: s(i, 'task_id') }), Body: GenericBody },
  TaskStop: { icon: 'stop', category: 'other', label: (i) => ({ verb: tr('停止任务'), arg: s(i, 'task_id') }), Body: GenericBody },
};

const MCP: ToolDef = {
  icon: 'mcp',
  category: 'mcp',
  label: (i) => {
    const first = Object.entries(i ?? {}).find(([, v]) => typeof v === 'string');
    return { verb: '', arg: first ? `${first[0]}=${String(first[1]).slice(0, 100)}` : '' };
  },
  Body: GenericBody,
};
const OTHER: ToolDef = { icon: 'settings', category: 'other', label: MCP.label, Body: GenericBody };

/** 联网: the `web` server's tools (search, the built-in browser) read as steps of their own, not as 「web · browser_open」. */
const WEB = Object.fromEntries(WEB_TOOLS.map((t) => [t, {
  icon: webToolLabel(t, {}).icon,
  category: 'web',
  label: (i) => { const l = webToolLabel(t, i); return { verb: l.verb, arg: l.arg }; },
  Body: GenericBody,
} satisfies ToolDef])) as Record<WebTool, ToolDef>;

/** 操控电脑: the `computer` server's tools read as what was done on the desktop, not as 「computer · left_click」. */
const COMPUTER = Object.fromEntries(COMPUTER_TOOLS.map((t) => [t, {
  icon: computerToolLabel(t, {}).icon,
  category: 'other',
  label: (i) => { const l = computerToolLabel(t, i); return { verb: l.verb, arg: l.arg }; },
  Body: GenericBody,
} satisfies ToolDef])) as Record<ComputerTool, ToolDef>;

/**
 * Conversations from before 2026-11-01 may have turns on ccb, the Claude Code fork we used to run, which called MCP
 * tools without alwaysLoad through ExecuteExtraTool { tool_name, params } (and looked them up with SearchExtraTools).
 * Kept so those transcripts still read: the step reads as the tool inside (its verb and target; another server's tool
 * as 「server · tool」), malformed — or something that is not a plain tool call — as any tool's input.
 */
const EXTRA_TOOL = 'ExecuteExtraTool';
const NOT_UNWRAPPED = new Set([EXTRA_TOOL, 'SearchExtraTools', 'AskUserQuestion', 'ExitPlanMode', SITE_TOOL]);
function extraToolInner(inp: unknown): { toolName: string; input: Record<string, unknown> } | undefined {
  if (!inp || typeof inp !== 'object' || Array.isArray(inp)) return undefined;
  const { tool_name: name, params } = inp as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim() || NOT_UNWRAPPED.has(name)) return undefined;
  if (params !== undefined && (!params || typeof params !== 'object' || Array.isArray(params))) return undefined;
  return { toolName: name, input: (params ?? {}) as Record<string, unknown> };
}
DEFS[EXTRA_TOOL] = {
  icon: 'mcp',
  category: 'mcp',
  label: (i) => {
    const inner = extraToolInner(i);
    if (!inner) return MCP.label(i);
    const l = getToolDef(inner.toolName).label(inner.input as Record<string, any>);
    return l.verb ? l : { verb: toolDisplayName(inner.toolName), arg: l.arg };
  },
  Body: GenericBody,
};
DEFS.SearchExtraTools = { icon: 'search', category: 'other', label: (i) => ({ verb: tr('查找工具:'), arg: s(i, 'query') }), Body: GenericBody };

export function getToolDef(name: string): ToolDef {
  if (DEFS[name]) return DEFS[name];
  const web = webToolOf(name);
  if (web) return WEB[web];
  const computer = computerToolOf(name);
  if (computer) return COMPUTER[computer];
  return name.startsWith('mcp__') ? MCP : OTHER;
}

/** "mcp__server__tool" → { server, tool } */
export function splitMcp(name: string): { server: string; tool: string } | null {
  if (webToolOf(name) || computerToolOf(name)) return null; // drawn with their own words
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : null;
}

export function toolDisplayName(name: string): string {
  const m = splitMcp(name);
  return m ? `${m.server} · ${m.tool}` : name;
}

export function isStandalone(name: string): boolean {
  return !!getToolDef(name).standalone;
}
