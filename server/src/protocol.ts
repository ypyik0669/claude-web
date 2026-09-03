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
  agent?: AgentKind; // omitted = Claude Code
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
  providerId?: string; // API provider profile; omit / 'claude' = the claude.ai login
  features?: SessionFeatures; // extra CLI flags / env
  agent?: AgentKind; // which CLI agent drives the session (default claude)
}

/** The single runtime that drives every session: ccb (claude-code-best, a superset of Claude Code) with the official binary as silent fallback. */
export type RuntimeKind = 'ccb' | 'claude';
export interface EngineInfo {
  runtime: RuntimeKind;
  version?: string;
  path: string;
  source: 'bundled' | 'global' | 'env';
  fallback?: { runtime: RuntimeKind; version?: string; path: string }; // the other binary, if present
}

export type ProviderType = 'anthropic' | 'openai' | 'gemini' | 'grok';
/** A third-party API endpoint profile. Stored in ~/.claude-web/meta.json; the key is injected into the session process env only. */
export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string; // masked (sk-…1234) when sent to the client
  models?: string[]; // last probe result
  defaultModel?: string;
  modelMap?: { haiku?: string; sonnet?: string; opus?: string };
  runtime?: RuntimeKind; // force a runtime for this provider (some relays only accept the official client)
  createdAt: number;
}
export const CLAUDE_PROVIDER_ID = 'claude';

/** Multi-agent (phase 5): built-in kinds plus user-defined ACP agents (`acp:<id>`). */
export type AgentKind = 'claude' | 'codex' | 'gemini' | 'qwen' | 'kimi' | `acp:${string}`;
export interface AgentInfo {
  kind: AgentKind;
  name: string;
  icon: string;
  protocol: 'claude' | 'acp' | 'codex';
  installed: boolean;
  version: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  model: string; // default model override ('' = agent default)
  models: string[]; // known model ids
  install: string; // install command
  login: string; // login command (run in a terminal tile)
  docs: string;
  label: string; // user note e.g. account name
  enabled: boolean;
  builtin: boolean;
}

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
  uuid?: string; // client-minted transcript uuid for this user message (fork / rewind anchor)
  attachments?: AttachmentRef[]; // already uploaded via POST /api/attachments (or inline text)
}

/** File attached to a user message. `text` kind inlines content; others reference a path the CLI can Read. */
export interface AttachmentRef { kind: 'image' | 'text' | 'file' | 'folder'; name: string; path?: string; size?: number; text?: string }

export interface MessageFeedback { rating: 'up' | 'down' | null; note?: string; at: number }

export interface Workspace { id: string; path: string; name: string; addedAt: number; order: number }
export interface SessionMeta { pinned?: boolean; archived?: boolean; workspaceId?: string; tags?: string[]; providerId?: string }
export interface Schedule { id: string; name: string; cwd: string; prompt: string; everyMinutes: number; cron?: string; enabled: boolean; lastRunAt?: number; nextRunAt?: number; sessionId?: string; model?: string; permissionMode?: string; freshSession?: boolean; lastError?: string; runs?: number }
export interface LimitWindow { label: string; percent: number; resetsAt: string | null; active: boolean; severity?: string }
// ---- remote access / phones / IM (phase 6) ----
export interface DeviceInfo { id: string; name: string; createdAt: number; lastSeenAt: number; ip?: string; ua?: string }
export interface RemoteStatus { enabled: boolean; running: boolean; port: number; addresses: string[]; error: string; devices: DeviceInfo[]; pair: { code: string; expiresAt: number } | null }
/** Another machine running claude-web, reached through an ssh port-forward. */
export interface RemoteHost { id: string; name: string; target: string; sshPort?: number; identityFile?: string; remotePort: number; token?: string; startCommand?: string }
export interface TunnelInfo { hostId: string; localPort: number; url: string; state: 'connecting' | 'up' | 'down'; error: string; since: number }
export type ImKind = 'telegram' | 'discord' | 'slack' | 'feishu' | 'dingtalk' | 'wecom';
export interface ImGatewayConfig { id: string; kind: ImKind; name: string; enabled: boolean; config: Record<string, string>; allowUsers: string[]; allowNames: Record<string, string>; openAccess: boolean; defaultCwd: string; permissionMode: string; agent: string; verbose: boolean }
export interface ImBinding { gatewayId: string; chatId: string; sessionId: string; cwd: string; since: number }
export interface ImGatewayInfo extends ImGatewayConfig { state: 'stopped' | 'starting' | 'running' | 'error'; error: string; botName: string; inbound: boolean; pairCode: string; pairExpiresAt: number; bindings: ImBinding[] }
export interface ImKindDef { kind: ImKind; name: string; icon: string; inbound: boolean; fields: { key: string; label: string; secret?: boolean; hint?: string }[]; help: string }

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
  runtime?: RuntimeKind;
  providerId?: string;
  providerName?: string;
  features?: SessionFeatures;
  error?: string;
  agent?: AgentKind;
  agentName?: string;
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
  | { kind: 'session.contextUsage'; sessionId: string; detail?: 'summary' | 'full' }
  | { kind: 'feedback.set'; sessionId: string; messageId: string; rating: 'up' | 'down' | null; note?: string }
  | { kind: 'feedback.list'; sessionId: string }
  | { kind: 'drafts.set'; key: string; text: string } // key = sessionId | 'welcome'
  | { kind: 'drafts.get'; key: string }
  | { kind: 'export.save'; name: string; html: string } // → ~/.claude-web/exports/<name>.html, returns path
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
  | { kind: 'engine.info' }
  | { kind: 'engine.update' } // npm i -g claude-code-best@latest
  | { kind: 'engine.cli'; args: string[]; cwd?: string }
  | { kind: 'providers.list' }
  | { kind: 'providers.upsert'; provider: Partial<Provider> & { id?: string } }
  | { kind: 'providers.remove'; id: string }
  | { kind: 'providers.probe'; id?: string; provider?: Partial<Provider> } // saved profile by id, or an unsaved draft
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
  // phase 3: editor / file operations / search / git
  | { kind: 'fs.stat'; path: string }
  | { kind: 'fs.open'; path: string } // text + mtime for the editor
  | { kind: 'fs.write'; path: string; text: string; expectMtime?: number } // conflict when disk mtime moved past expectMtime
  | { kind: 'fs.mkdir'; path: string }
  | { kind: 'fs.create'; path: string; text?: string }
  | { kind: 'fs.rename'; from: string; to: string }
  | { kind: 'fs.copy'; from: string; to: string }
  | { kind: 'fs.trash'; paths: string[] }
  | { kind: 'fs.watch'; path: string } // directory or file; emits fs.changed
  | { kind: 'fs.unwatch'; path: string }
  | { kind: 'search.run'; root: string; query: string; options?: SearchOptions }
  | { kind: 'search.replace'; root: string; query: string; replacement: string; options?: SearchOptions; targets?: { path: string; lines?: number[] }[] }
  | { kind: 'git.status'; cwd: string }
  | { kind: 'git.diff'; cwd: string; path: string; staged?: boolean }
  | { kind: 'git.stage'; cwd: string; files: string[] | 'all' }
  | { kind: 'git.unstage'; cwd: string; files: string[] | 'all' }
  | { kind: 'git.discard'; cwd: string; files: string[] }
  | { kind: 'git.commit'; cwd: string; message: string; amend?: boolean; all?: boolean }
  | { kind: 'git.log'; cwd: string; n?: number; rev?: string }
  | { kind: 'git.show'; cwd: string; rev: string }
  | { kind: 'git.branches'; cwd: string }
  | { kind: 'git.checkout'; cwd: string; name: string; create?: boolean; from?: string }
  | { kind: 'git.deleteBranch'; cwd: string; name: string; force?: boolean }
  | { kind: 'git.fetch'; cwd: string }
  | { kind: 'git.pull'; cwd: string; rebase?: boolean }
  | { kind: 'git.push'; cwd: string; setUpstream?: boolean; force?: boolean }
  | { kind: 'git.stash'; cwd: string; op: 'push' | 'pop' | 'drop' | 'list'; message?: string }
  | { kind: 'git.worktrees'; cwd: string }
  | { kind: 'git.worktreeAdd'; cwd: string; name: string; branch?: string; from?: string; dir?: string }
  | { kind: 'git.worktreeRemove'; cwd: string; dir: string; force?: boolean }
  | { kind: 'git.remotes'; cwd: string }
  | { kind: 'git.watch'; cwd: string }
  // phase 4: settings center / automation
  | { kind: 'skills.list'; cwd?: string }
  | { kind: 'skills.install'; source: string; scope: 'user' | 'project'; cwd?: string; name?: string }
  | { kind: 'skills.create'; name: string; scope: 'user' | 'project'; cwd?: string; description?: string }
  | { kind: 'skills.remove'; path: string }
  | { kind: 'skills.backup' }
  | { kind: 'skills.restore'; file: string }
  | { kind: 'tools.detect' }
  | { kind: 'diag.bundle' }
  | { kind: 'mcp.registry'; query: string; limit?: number }
  | { kind: 'mcp.health'; cwd?: string }
  | { kind: 'secrets.status' }
  | { kind: 'secrets.migrate' } // re-protect every provider key with the platform scheme
  | { kind: 'ledger.list'; days?: number; sessionId?: string }
  | { kind: 'ledger.export'; days?: number } // CSV path
  | { kind: 'schedules.history'; id?: string; limit?: number }
  | { kind: 'schedules.templates' }
  | { kind: 'agents.list'; refresh?: boolean }
  | { kind: 'remote.status' }
  | { kind: 'remote.set'; enabled?: boolean; port?: number }
  | { kind: 'remote.pairCode' }
  | { kind: 'remote.devices.revoke'; id: string }
  | { kind: 'remote.devices.rename'; id: string; name: string }
  | { kind: 'remote.hosts.list' }
  | { kind: 'remote.hosts.set'; host: RemoteHost }
  | { kind: 'remote.hosts.remove'; id: string }
  | { kind: 'tunnel.open'; hostId: string }
  | { kind: 'tunnel.close'; hostId: string }
  | { kind: 'tunnel.list' }
  | { kind: 'tunnel.run'; hostId: string; command: string }
  | { kind: 'im.kinds' }
  | { kind: 'im.list' }
  | { kind: 'im.set'; id: string; patch: Partial<ImGatewayConfig> | null }
  | { kind: 'im.test'; id: string }
  | { kind: 'im.pairCode'; id: string }
  | { kind: 'im.unbind'; gatewayId: string; chatId: string }
  | { kind: 'agents.set'; agent: AgentKind; patch: { command?: string; args?: string[]; env?: Record<string, string>; model?: string; label?: string; enabled?: boolean; name?: string; protocol?: 'acp' | 'codex' } | null }
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
  | { kind: 'remote.changed' }
  | { kind: 'im.changed' }
  | { kind: 'tunnel.changed' }
  | { kind: 'limits'; limits: Limits }
  | { kind: 'terminal.data'; termId: string; data: string }
  | { kind: 'terminal.exit'; termId: string; code: number | null }
  | { kind: 'fs.changed'; path: string; type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' }
  | { kind: 'git.changed'; cwd: string };

// ---------- phase 3: files / search / git ----------
export interface FsEntry { name: string; dir: boolean; size?: number; mtime?: number; symlink?: boolean }
export interface FsStat { path: string; dir: boolean; size: number; mtime: number; binary?: boolean }
export interface FsOpenResult { text: string; mtime: number; size: number; binary: boolean; truncated?: boolean }

export interface SearchOptions { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; include?: string[]; exclude?: string[]; includeHidden?: boolean; noIgnore?: boolean; maxResults?: number }
export interface SearchMatch { line: number; text: string; ranges: { start: number; end: number }[] }
export interface SearchResult { files: { path: string; matches: SearchMatch[] }[]; total: number; truncated: boolean }

export type GitFileState = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflict' | 'typechange';
export interface GitFileStatus { path: string; from?: string; status: GitFileState; staged: boolean; unstaged: boolean }
export interface GitStatus {
  root: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  files: GitFileStatus[];
  stashes: number;
  state: 'clean' | 'merging' | 'rebasing' | 'cherry-picking' | 'conflict' | 'detached';
}
export interface GitLogEntry { hash: string; short: string; author: string; email: string; date: number; subject: string; refs: string[] }
export interface GitBranch { name: string; current: boolean; remote: boolean; upstream: string | null; date: number; sha: string }
export interface GitWorktree { path: string; head: string; branch: string | null; main: boolean; bare: boolean; locked: boolean }
export type GitErrorKind = 'not_repo' | 'no_upstream' | 'auth' | 'rejected' | 'conflict' | 'detached' | 'dirty' | 'nothing_to_commit' | 'identity' | 'lock' | 'unrelated' | 'network' | 'unknown_rev' | 'exists' | 'unknown';
export interface GitError { kind: GitErrorKind; message: string; hint: string }

// ---------- phase 4 ----------
export interface SkillInfo { name: string; path: string; scope: 'user' | 'project'; description: string; hasReadme: boolean }
export interface ToolInfo { id: string; label: string; ok: boolean; version: string; path: string; hint: string; url: string }
export interface McpHealth { name: string; status: 'connected' | 'failed' | 'needs-auth' | 'unknown'; detail: string }
export interface RegistryServer { name: string; description: string; repo?: string; install?: { transport: 'stdio' | 'http' | 'sse'; command?: string; args?: string[]; url?: string; env?: string[] }; kind: 'npm' | 'pypi' | 'remote' | 'other' }
export interface SecretsStatus { scheme: 'dpapi' | 'keychain' | 'plain'; total: number; protected: number }
/** One model call as seen from the runner (per `result` / assistant message). */
export interface LedgerEntry { ts: number; sessionId: string; model: string; durationMs: number; apiMs?: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; ok: boolean; error?: string; turns?: number; providerId?: string }
export interface ScheduleRun { id: string; scheduleId: string; at: number; sessionId?: string; ok: boolean; durationMs?: number; summary?: string; error?: string }

export type WireDown = { type: 'reply'; reply: ReplyEnvelope } | { type: 'event'; event: ServerEvent };
export type WireUp = { type: 'request'; request: RequestEnvelope };
