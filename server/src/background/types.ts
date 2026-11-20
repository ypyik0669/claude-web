// 后台 (spec docs/superpowers/specs/2026-10-12-background-office-design.md): what a conversation has running besides
// its turn — workflows and their agents, sub-agents, background commands — as the server keeps it for every window.
// Shared with the web through protocol.ts.

/** What a task is: a workflow (`local_workflow`), one sub-agent (`local_agent`), a background command (`local_bash`), anything else. */
export type BgKind = 'workflow' | 'agent' | 'shell' | 'other';
export type BgStatus = 'running' | 'completed' | 'failed' | 'stopped';
/** A workflow agent's `start` before it has an agent id is queued; `progress` is running. `stopped`: its task was
 *  stopped (by the user, or with the CLI process) before it finished — not a failure. */
export type BgAgentState = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

/** One character in the office: a workflow's agent, or the agent a `local_agent` task is. */
export interface BgAgent {
  /** Stable within its task: `w<index>` for a workflow agent, the task id for a sub-agent task. */
  key: string;
  /** 1…10, in the order the conversation's agents first appeared: `--agent-<n>`. */
  color: number;
  label: string;
  /** The workflow phase it belongs to (`phaseIndex`), if any. */
  phase?: number;
  phaseTitle?: string;
  /** Names its transcript (`subagents/…/agent-<id>.jsonl`). */
  agentId?: string;
  /** `subagent_type` (Explore, Plan, general-purpose…): the character's accessory. Workflow agents have none. */
  agentType?: string;
  model?: string;
  state: BgAgentState;
  queuedAt?: number;
  startedAt?: number;
  endedAt?: number;
  tokens?: number;
  toolCalls?: number;
  lastTool?: string;
  /** What it is doing / did last, in a line (`lastToolSummary`, or a sub-agent's progress summary). */
  lastSummary?: string;
  /** A resumed workflow reused this agent's earlier result. */
  cached?: boolean;
  error?: string;
  attempt?: number;
  /** When its tool calls went up (ms, the latest 24): the desk monitor's activity. */
  beats: number[];
}

export interface BgPhase { index: number; title: string }

export interface BgTask {
  id: string;
  toolUseId?: string;
  kind: BgKind;
  /** The SDK's raw `task_type`. */
  type?: string;
  description: string;
  /** A workflow's `meta.name`. */
  name?: string;
  status: BgStatus;
  /** Registered in the background (the turn did not wait for it). */
  backgrounded?: boolean;
  startedAt: number;
  endedAt?: number;
  summary?: string;
  lastTool?: string;
  tokens?: number;
  toolUses?: number;
  /** A workflow's phases, in order. */
  phases?: BgPhase[];
  /** A workflow: its agents; a sub-agent task: the one agent; a command: none. */
  agents: BgAgent[];
  /** Why it ended when it was not by itself (「进程结束了」). */
  reason?: string;
  /** A workflow's run id (`wf_…`), when known (a finished run read from disk). */
  runId?: string;
}

export interface BgEvent {
  at: number;
  taskId: string;
  /** The agent's `key`, when the event is one agent's. */
  agent?: string;
  who: string;
  color?: number;
  text: string;
  tone: 'start' | 'tool' | 'done' | 'error' | 'stop';
}

/** One conversation's background, as pushed to the windows (`events`: the latest 50, oldest first). */
export interface BgSession { sessionId: string; updatedAt: number; tasks: BgTask[]; events: BgEvent[] }

/** A finished workflow run found on disk (`<conversation>/workflows/<runId>.json`). */
export interface BgRunSummary { runId: string; name: string; status: string; startedAt: number; durationMs?: number; agentCount: number; tokens?: number; taskId?: string }

/** 跑过的: what kind of finished work a history row is. */
export type BgHistoryKind = 'workflow' | 'agent' | 'shell';

/**
 * 跑过的 (2026-11-19): one finished piece of background work found on disk — a workflow run (`workflows/<runId>.json`),
 * a sub-agent the conversation sent (its Agent / Task call and result in the transcript), a background command (a
 * run_in_background Bash call; its end is the CLI's <task-notification>). Never in the live snapshot.
 */
export interface BgHistoryItem {
  /** `<sessionId>|<kind>|<key>`: the run id, the sub-agent's id (or its tool call's), the command's task id. */
  id: string;
  sessionId: string;
  kind: BgHistoryKind;
  title: string;
  /** `stopped` too for one whose process went before it said it ended. */
  status: BgStatus;
  startedAt: number;
  endedAt?: number;
  /** The folder the conversation ran in (the row's project name). */
  cwd?: string;
  /** A workflow: its run (background.run reads it), how many agents it had, how many of them failed. */
  runId?: string;
  agentCount?: number;
  failed?: number;
  /** A workflow's description, when it is not its title. */
  summary?: string;
  /** A sub-agent: its transcript (background.transcript), `subagent_type`, the model it ran on. */
  agentId?: string;
  agentType?: string;
  model?: string;
  /** A background command: its command line (cut). */
  command?: string;
  tokens?: number;
  toolUses?: number;
}

export interface BgHistoryQuery {
  /** The `next` of the page before: rows older than its last one. */
  before?: string;
  /** Default 50, at most 200. */
  limit?: number;
  only?: BgHistoryKind;
  /** Words in the title, the command line, the folder's name, the sub-agent's type. */
  q?: string;
  /** Conversations whose title has the words (the window knows the titles): all their rows match. */
  also?: string[];
  /** Only this conversation's (a remote one's is forwarded to its machine). */
  sessionId?: string;
}

/** Newest first; `next` (none: nothing older) asks for the page after. */
export interface BgHistoryPage { items: BgHistoryItem[]; next?: string }

export type BackgroundRequest =
  | { kind: 'background.list' }
  | { kind: 'background.history'; sessionId: string }
  | { kind: 'background.run'; sessionId: string; runId: string }
  | { kind: 'background.transcript'; sessionId: string; agentId: string }
  | ({ kind: 'background.historyAll' } & BgHistoryQuery);

export type BackgroundEvent = { kind: 'background.changed'; session: BgSession };
