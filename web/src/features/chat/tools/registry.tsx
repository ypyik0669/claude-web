import type { ComponentType } from 'react';
import type { IconName } from '@/ui/icons';
import type { ToolUseBlock } from '@/model/conversation';
import { ReadBody, WriteBody, EditBody, NotebookBody } from './FileTools';
import { GlobBody, GrepBody } from './SearchTools';
import { ShellBody } from './ShellTool';
import { WebFetchBody, WebSearchBody, SkillBody } from './WebTools';
import { AgentBody, TodoBody, PlanBody, AskUserBody, ArtifactBody, GoalBody, WorkflowBody } from './AgentTool';
import { GenericBody } from './McpTool';

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
}

const s = (input: any, k: string) => (typeof input?.[k] === 'string' ? (input[k] as string) : '');

const DEFS: Record<string, ToolDef> = {
  Read: { icon: 'read', category: 'read', label: (i) => ({ verb: '读取文件:', arg: `${s(i, 'file_path')}${i.offset ? `:${i.offset}${i.limit ? `-${Number(i.offset) + Number(i.limit) - 1}` : ''}` : ''}` }), Body: ReadBody },
  Write: { icon: 'write', category: 'edit', label: (i) => ({ verb: '写入文件:', arg: s(i, 'file_path') }), Body: WriteBody },
  Edit: { icon: 'edit', category: 'edit', label: (i) => ({ verb: '编辑文件:', arg: s(i, 'file_path') }), Body: EditBody },
  MultiEdit: { icon: 'edit', category: 'edit', label: (i) => ({ verb: '编辑文件:', arg: `${s(i, 'file_path')} · ${(i.edits as any[])?.length ?? 0} 处` }), Body: EditBody },
  NotebookEdit: { icon: 'plan', category: 'edit', label: (i) => ({ verb: '编辑 Notebook:', arg: `${s(i, 'notebook_path')}${i.cell_id ? ` · ${i.cell_id}` : ''}` }), Body: NotebookBody },
  Bash: { icon: 'bash', category: 'cmd', label: (i) => ({ verb: '运行命令:', arg: s(i, 'command') || s(i, 'description') }), Body: ShellBody },
  PowerShell: { icon: 'bash', category: 'cmd', label: (i) => ({ verb: '运行命令:', arg: s(i, 'command') }), Body: ShellBody },
  Glob: { icon: 'glob', category: 'read', label: (i) => ({ verb: '列出文件:', arg: `${s(i, 'pattern')}${i.path ? ` in ${i.path}` : ''}` }), Body: GlobBody },
  Grep: { icon: 'search', category: 'read', label: (i) => ({ verb: '搜索文本:', arg: `${s(i, 'pattern')}${i.path ? ` in ${i.path}` : ''}${i.glob ? ` (${i.glob})` : ''}` }), Body: GrepBody },
  WebFetch: { icon: 'web', category: 'web', label: (i) => ({ verb: 'Fetch', arg: s(i, 'url') }), Body: WebFetchBody },
  WebSearch: { icon: 'web', category: 'web', label: (i) => ({ verb: '搜索网页:', arg: s(i, 'query') }), Body: WebSearchBody },
  Skill: { icon: 'skill', category: 'skill', label: (i) => ({ verb: 'Skill', arg: `/${s(i, 'skill')} ${s(i, 'args')}`.trim() }), Body: SkillBody },
  TodoWrite: { icon: 'todo', category: 'other', label: (i) => ({ verb: '更新计划', arg: `${(i.todos as any[])?.length ?? 0} 项` }), Body: TodoBody },
  Agent: { icon: 'agent', category: 'agent', standalone: true, label: (i) => ({ verb: i.subagent_type ? `[${i.subagent_type}]` : '子代理', arg: s(i, 'description') || s(i, 'prompt').slice(0, 80) }), Body: AgentBody },
  Task: { icon: 'agent', category: 'agent', standalone: true, label: (i) => ({ verb: i.subagent_type ? `[${i.subagent_type}]` : '任务', arg: s(i, 'description') || s(i, 'prompt').slice(0, 80) }), Body: AgentBody },
  ExitPlanMode: { icon: 'plan', category: 'plan', standalone: true, label: () => ({ verb: '请求批准计划', arg: '' }), Body: PlanBody },
  EnterPlanMode: { icon: 'plan', category: 'plan', label: () => ({ verb: '进入计划模式', arg: '' }), Body: GenericBody },
  AskUserQuestion: { icon: 'question', category: 'plan', standalone: true, label: (i) => ({ verb: '提问', arg: (i.questions as any[])?.map((q) => q.question).join(' / ') ?? '' }), Body: AskUserBody },
  Artifact: { icon: 'artifact', category: 'other', standalone: true, label: (i) => ({ verb: 'Artifact', arg: s(i, 'title') || s(i, 'name') }), Body: ArtifactBody },
  Goal: { icon: 'goals', category: 'other', standalone: true, label: (i) => ({ verb: 'Goal', arg: s(i, 'action') || s(i, 'command') || s(i, 'objective').slice(0, 80) }), Body: GoalBody },
  Workflow: { icon: 'workflow', category: 'agent', standalone: true, label: (i) => ({ verb: 'Workflow', arg: s(i, 'name') }), Body: WorkflowBody },
  WebBrowser: { icon: 'web', category: 'web', label: (i) => ({ verb: '浏览器', arg: s(i, 'action') || s(i, 'url') }), Body: GenericBody },
  Monitor: { icon: 'eye', category: 'other', label: (i) => ({ verb: '监视', arg: s(i, 'command') || s(i, 'description') }), Body: GenericBody },
  SendMessage: { icon: 'send', category: 'other', label: (i) => ({ verb: '发消息', arg: s(i, 'to') || s(i, 'recipient') }), Body: GenericBody },
  TaskOutput: { icon: 'archive', category: 'other', label: (i) => ({ verb: '任务输出', arg: s(i, 'task_id') }), Body: GenericBody },
  TaskStop: { icon: 'stop', category: 'other', label: (i) => ({ verb: '停止任务', arg: s(i, 'task_id') }), Body: GenericBody },
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

export function getToolDef(name: string): ToolDef {
  return DEFS[name] ?? (name.startsWith('mcp__') ? MCP : OTHER);
}

/** "mcp__server__tool" → { server, tool } */
export function splitMcp(name: string): { server: string; tool: string } | null {
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
