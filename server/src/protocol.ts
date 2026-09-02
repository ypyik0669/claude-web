// Shared wire protocol between server and web. Web imports this via the `@shared` alias.
// One WebSocket. Client -> server requests carry an `id` and get exactly one `reply`.
// Server -> client events carry no `id`.

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type RunnerState = 'starting' | 'idle' | 'running' | 'waiting' | 'error' | 'closed';

export interface SessionSummary {
  sessionId: string;
  title: string;
  cwd: string;
  lastModified: number;
  createdAt?: number;
  gitBranch?: string;
  firstPrompt?: string;
  customTitle?: string;
  live?: RunnerState; // present when a runner exists for this session
}

export interface OpenSessionParams {
  sessionId?: string; // resume this session; omit to start a new one
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  fork?: boolean;
  resumeAt?: string; // fork from this message uuid (implies fork)
  worktree?: string; // create a git worktree with this name for the session
  workspaceId?: string;
  engine?: EngineId; // which CLI drives the session (default: user setting, else 'claude')
  features?: SessionFeatures; // extra CLI flags / env, mostly ccb-only
}

export type EngineId = 'claude' | 'ccb';
export interface EngineInfo { id: EngineId; label: string; installed: boolean; path?: string; version?: string; source?: 'bundled' | 'global' | 'env'; note?: string }

/** Optional per-session switches. Each maps to a CLI flag or env var; unknown to the engine = ignored/error. */
export interface SessionFeatures {
  chrome?: boolean; // --chrome (Claude in Chrome MCP)
  computerUse?: boolean; // --computer-use-mcp (ccb)
  coordinator?: boolean; // CLAUDE_CODE_COORDINATOR_MODE=1 (ccb)
  proactive?: boolean; // --proactive (ccb)
  brief?: boolean; // --brief (SendUserMessage tool)
  channels?: string[]; // --channels plugin:name@marketplace | server:name (ccb)
  devChannels?: boolean; // --dangerously-load-development-channels (ccb)
  env?: Record<string, string>; // extra env for the CLI process (provider keys, LANGFUSE_*, ...)
}

export interface SendParams {
  sessionId: string;
  text: string;
  images?: { mediaType: string; data: string }[]; // base64
  steer?: boolean; // deliver mid-turn (SDK priority: 'now') instead of after the turn
}

export interface Workspace { id: string; path: string; name: string; addedAt: number; order: number }
export interface SessionMeta { pinned?: boolean; archived?: boolean; workspaceId?: string; tags?: string[] }
export interface Schedule { id: string; name: string; cwd: string; prompt: string; everyMinutes: number; enabled: boolean; lastRunAt?: number; nextRunAt?: number; sessionId?: string; model?: string; permissionMode?: string }
export interface LimitWindow { label: string; percent: number; resetsAt: string | null; active: boolean; severity?: string }
export interface Limits { ok: boolean; capturedAt: string; windows: LimitWindow[]; subscriptionType?: string; rateLimitTier?: string; error?: string }

export interface PermissionRequestEvent {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  suggestions?: unknown[];
  blockedPath?: string;
  decisionReason?: string;
}

export type PermissionResponse =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export interface SessionInfoSnapshot {
  sessionId: string;
  state: RunnerState;
  cwd: string;
  model?: string;
  effort?: EffortLevel | null;
  permissionMode?: PermissionMode;
  tools?: string[];
  slashCommands?: { name: string; description: string; argumentHint: string }[];
  skills?: string[];
  agents?: { name: string; description: string; model?: string }[];
  mcpServers?: { name: string; status: string; error?: string; tools?: unknown[] }[];
  plugins?: { name: string; path: string; version?: string }[];
  models?: { value: string; displayName: string; description: string; supportsEffort?: boolean; supportedEffortLevels?: EffortLevel[] }[];
  claudeCodeVersion?: string;
  engine?: EngineId;
  features?: SessionFeatures;
  error?: string;
}

// ---- requests ----
export type ClientRequest =
  | { kind: 'sessions.list'; limit?: number }
  | { kind: 'sessions.projects' }
  | { kind: 'transcript.load'; sessionId: string }
  | { kind: 'transcript.subagent'; sessionId: string; agentId: string }
  | { kind: 'transcript.subagents'; sessionId: string }
  | { kind: 'session.open'; params: OpenSessionParams }
  | { kind: 'session.info'; sessionId: string }
  | { kind: 'session.send'; params: SendParams }
  | { kind: 'session.interrupt'; sessionId: string }
  | { kind: 'session.close'; sessionId: string }
  | { kind: 'session.setPermissionMode'; sessionId: string; mode: PermissionMode }
  | { kind: 'session.setModel'; sessionId: string; model: string }
  | { kind: 'session.setEffort'; sessionId: string; effort: EffortLevel }
  | { kind: 'session.rename'; sessionId: string; title: string }
  | { kind: 'session.delete'; sessionId: string }
  | { kind: 'session.contextUsage'; sessionId: string }
  | { kind: 'session.stopTask'; sessionId: string; taskId: string }
  | { kind: 'permission.respond'; requestId: string; response: PermissionResponse }
  | { kind: 'workspaces.list' }
  | { kind: 'workspaces.add'; path: string }
  | { kind: 'workspaces.remove'; id: string }
  | { kind: 'workspaces.rename'; id: string; name: string }
  | { kind: 'workspaces.reorder'; ids: string[] }
  | { kind: 'sessions.meta' }
  | { kind: 'session.setMeta'; sessionId: string; patch: SessionMeta }
  | { kind: 'schedules.list' }
  | { kind: 'schedules.upsert'; schedule: Partial<Schedule> }
  | { kind: 'schedules.remove'; id: string }
  | { kind: 'schedules.runNow'; id: string }
  | { kind: 'limits.get'; force?: boolean }
  | { kind: 'engines.list' }
  | { kind: 'engines.install'; id: EngineId }
  | { kind: 'engine.cli'; engine: EngineId; args: string[]; cwd?: string }
  | { kind: 'settings.get' }
  | { kind: 'settings.set'; key: string; value: unknown }
  | { kind: 'sessions.search'; query: string; limit?: number }
  | { kind: 'shell.open'; path: string; app?: 'explorer' | 'code' | 'cursor' }
  | { kind: 'config.overview' }
  | { kind: 'config.plugins' }
  | { kind: 'config.plugin.toggle'; name: string; enable: boolean }
  | { kind: 'config.plugin.install'; spec: string }
  | { kind: 'config.plugin.uninstall'; name: string }
  | { kind: 'config.marketplaces' }
  | { kind: 'config.marketplace.add'; source: string }
  | { kind: 'config.mcp' }
  | { kind: 'config.mcp.add'; name: string; json: string; scope: 'user' | 'project' | 'local'; cwd?: string }
  | { kind: 'config.mcp.remove'; name: string; scope?: string; cwd?: string }
  | { kind: 'config.auth' }
  | { kind: 'config.settings.read'; scope: 'user' | 'project' | 'local'; cwd?: string }
  | { kind: 'config.settings.write'; scope: 'user' | 'project' | 'local'; cwd?: string; json: string }
  | { kind: 'config.skills' }
  | { kind: 'config.agents' }
  | { kind: 'config.hooks' }
  | { kind: 'config.doctor' }
  | { kind: 'usage.session'; sessionId: string }
  | { kind: 'usage.global'; days?: number }
  | { kind: 'files.changed'; sessionId: string }
  | { kind: 'files.diff'; sessionId: string; path: string }
  | { kind: 'fs.list'; path: string }
  | { kind: 'fs.read'; path: string }
  | { kind: 'fs.pickDir' }
  | { kind: 'terminal.open'; cwd: string; cols: number; rows: number }
  | { kind: 'terminal.input'; termId: string; data: string }
  | { kind: 'terminal.resize'; termId: string; cols: number; rows: number }
  | { kind: 'terminal.close'; termId: string };

export interface RequestEnvelope { id: string; req: ClientRequest }
export interface ReplyEnvelope { id: string; ok: boolean; data?: unknown; error?: string }

// ---- events ----
export type ServerEvent =
  | { kind: 'hello'; version: string }
  | { kind: 'session.event'; sessionId: string; message: unknown } // raw SDK message
  | { kind: 'session.state'; sessionId: string; state: RunnerState; error?: string }
  | { kind: 'session.info'; info: SessionInfoSnapshot }
  | { kind: 'permission.request'; request: PermissionRequestEvent }
  | { kind: 'permission.resolved'; requestId: string }
  | { kind: 'sessions.changed' }
  | { kind: 'meta.changed' }
  | { kind: 'limits'; limits: Limits }
  | { kind: 'terminal.data'; termId: string; data: string }
  | { kind: 'terminal.exit'; termId: string; code: number | null };

export type WireDown = { type: 'reply'; reply: ReplyEnvelope } | { type: 'event'; event: ServerEvent };
export type WireUp = { type: 'request'; request: RequestEnvelope };
