import { parseLibraryId } from '@shared';

export function ago(ts: number | string | undefined): string {
  if (!ts) return '';
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  const d = Date.now() - t;
  if (d < 60_000) return '刚刚';
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时`;
  if (d < 7 * 86400_000) return `${Math.floor(d / 86400_000)} 天`;
  return new Date(t).toLocaleDateString();
}

export function fmtTok(n: number | undefined): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtMs(ms: number | undefined): string {
  if (!ms) return '0s';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function fmtUsd(v: number | undefined): string {
  if (!v) return '$0';
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

export function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
}

export function shortModel(m: string | undefined): string {
  if (!m) return '';
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export function clsx(...a: (string | false | null | undefined)[]) {
  return a.filter(Boolean).join(' ');
}

/** Summarise a tool input for the collapsed card header. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return s('command');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return s('file_path');
    case 'NotebookEdit':
      return s('notebook_path');
    case 'Glob':
    case 'Grep':
      return `${s('pattern')}${input.path ? `  in ${input.path}` : ''}`;
    case 'Agent':
    case 'Task':
      return `${input.subagent_type ? `[${input.subagent_type}] ` : ''}${s('description') || s('prompt').slice(0, 80)}`;
    case 'WebFetch':
    case 'WebSearch':
      return s('url') || s('query');
    case 'Skill':
      return `/${s('skill')} ${s('args')}`;
    case 'TodoWrite':
      return `${(input.todos as any[])?.length ?? 0} todos`;
    case 'AskUserQuestion':
      return (input.questions as any[])?.map((q) => q.question).join(' / ') ?? '';
    case 'ExitPlanMode':
      return '请求批准计划';
    default: {
      const first = Object.entries(input).find(([, v]) => typeof v === 'string');
      return first ? `${first[0]}=${(first[1] as string).slice(0, 100)}` : JSON.stringify(input).slice(0, 100);
    }
  }
}

/**
 * Session came from the unified library (another agent's own store) — its history is paged through
 * `library.read`. The prefix rules live in protocol.ts (shared with server/src/library/ids.ts).
 */
export function isImportedSessionId(id: string): boolean {
  return parseLibraryId(id).kind !== 'claude';
}

/** The id the agent itself uses (what its own CLI's resume flag takes): the library id without its prefix. */
export function nativeSessionId(id: string): string {
  return parseLibraryId(id).nativeId;
}
