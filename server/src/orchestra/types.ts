// Multi-agent orchestration (sub-project 2): workflow templates, runs and their wire protocol.
// Re-exported from protocol.ts, so web reaches these through `@shared` like every other wire type.
import type { AgentKind, PermissionMode } from '../protocol.js';

export type OrchWorkspace = 'shared' | 'worktree';

export interface OrchTaskNode {
  id: string; kind: 'task'; title: string; agent: AgentKind; model?: string; prompt: string; dependsOn: string[];
  workspace: OrchWorkspace; permissionMode?: PermissionMode;
  /** run to `GOAL_STATUS: complete` through GoalService instead of stopping at the first `result` */
  untilDone?: boolean;
}
export interface OrchApprovalNode { id: string; kind: 'approval'; title: string; note?: string; dependsOn: string[] }
/** (A `compare` kind existed until 2026-11-01; old records holding one are failed / rejected as an unknown kind.) */
export type OrchNode = OrchTaskNode | OrchApprovalNode;
export type OrchNodeKind = OrchNode['kind'];

export interface Workflow { id: string; name: string; description?: string; cwd: string; nodes: OrchNode[]; createdAt: number; updatedAt: number }
/** A ready-made workflow the UI can copy (cwd filled by the user; agents resolved against what's installed). */
export interface WorkflowTemplate { id: string; name: string; description: string; nodes: OrchNode[] }

export type OrchRunState = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
export type NodeRunState = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped' | 'cancelled';

export interface OrchWorktree { agent: AgentKind; path: string; branch: string }

export interface NodeRun {
  state: NodeRunState;
  sessionIds: string[];
  worktrees?: OrchWorktree[];
  output?: string;
  approval?: { decision: 'approve' | 'reject'; comment?: string; at: number };
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  costUsd?: number;
  /** untilDone task: the goal driving it */
  goalId?: string;
  attempts?: number;
  /** worktrees of earlier attempts (retry / resume never delete them; the run's cleanup lists / removes them) */
  retained?: OrchWorktree[];
  /** worktree task: finished, but merging its branch back failed — `orchestra.node.remerge` tries again */
  mergePending?: boolean;
  /** non-fatal information for the user (e.g. which worktrees were kept after a merge and why) */
  note?: string;
}

export interface OrchRun {
  id: string; workflowId: string; name: string; cwd: string; input: string; baseBranch?: string;
  startedAt: number; finishedAt?: number; state: OrchRunState; error?: string;
  /** frozen copy of the workflow's nodes at start (editing the template must not change a running run) */
  workflow: OrchNode[];
  nodes: Record<string, NodeRun>;
}
/** List row: a run without the (potentially long) outputs. */
export interface OrchRunSummary { id: string; workflowId: string; name: string; cwd: string; state: OrchRunState; startedAt: number; finishedAt?: number; waiting: number; total: number; done: number }

export type OrchestraRequest =
  | { kind: 'orchestra.templates' }
  | { kind: 'orchestra.workflows.list' }
  | { kind: 'orchestra.workflows.save'; workflow: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'> & { id?: string } }
  | { kind: 'orchestra.workflows.remove'; id: string }
  | { kind: 'orchestra.run.start'; workflowId: string; input: string }
  | { kind: 'orchestra.runs.list' }
  | { kind: 'orchestra.run.get'; runId: string }
  | { kind: 'orchestra.run.cancel'; runId: string }
  | { kind: 'orchestra.run.resume'; runId: string }
  | { kind: 'orchestra.run.remove'; runId: string; cleanup?: boolean }
  | { kind: 'orchestra.node.retry'; runId: string; nodeId: string }
  | { kind: 'orchestra.node.approve'; runId: string; nodeId: string; decision: 'approve' | 'reject'; comment?: string }
  | { kind: 'orchestra.node.remerge'; runId: string; nodeId: string }
  | { kind: 'orchestra.orphans.list' }
  | { kind: 'orchestra.orphans.remove'; path: string };

/** Result of cleaning up a run's worktrees / branches: anything with uncommitted changes or unmerged commits is only listed. */
export interface OrchCleanup { removed: string[]; kept: { path?: string; branch: string; reason: string }[] }

/** A directory under <dataDir>/worktrees that no run record references (e.g. the record was deleted). */
export interface OrchOrphan { path: string; broken: boolean; dirty?: boolean; root?: string; branch?: string }

export type OrchestraEvent = { kind: 'orchestra.changed'; run: OrchRun; removed?: boolean } | { kind: 'orchestra.workflows.changed' };
