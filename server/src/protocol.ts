// Shared wire protocol between server and web. Web imports this via the `@shared` alias.
// One WebSocket. Client -> server requests carry an `id` and get exactly one `reply`.
// Server -> client events carry no `id`.

import type { AgentConfigRequest } from './agent-config/types.js';
export type * from './agent-config/types.js';

export * from './federation/types.js';
import type { PeerEvent, PeerRequest, SessionPeer } from './federation/types.js';
import type { OrchestraEvent, OrchestraRequest } from './orchestra/types.js';
export * from './orchestra/types.js';
import type { LinkKind } from './remote/anywhere/core/link.js';
export type { LinkKind } from './remote/anywhere/core/link.js';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
// `ultra` is Codex-only (its own enum member). `ultracode` is NOT here on purpose: in Claude Code it is a
// separate session-scoped boolean (xhigh + dynamic workflows) that CLAUDE_CODE_EFFORT_LEVEL rejects.
export type MemoryScope = 'global' | 'project' | 'session';
export type MemoryKind = 'decision' | 'constraint' | 'fact' | 'deadend' | 'preference' | 'note';
export interface MemoryItem {
  id: string; scope: MemoryScope; key: string; kind: MemoryKind; text: string; tags: string[];
  sourceSession?: string; sourceAgent?: string; pinned: boolean; hits: number; createdAt: number; updatedAt: number;
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

/** One entry of an agent's model picker. `value` is what gets sent back as the model id. */
export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
}
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
  // ---- unified session library (phase 13) ----
  source?: string; // cli / vscode / exec / appServer / opencode … (how the native session was created)
  parentId?: string; // library id of the session this one was forked/resumed from
  archived?: boolean;
  childCount?: number;
  caps?: SourceCaps;
  /** claude-web's own session merged with the joined-source session it continues (that library id); deleting it deletes both */
  mergedFrom?: string;
  /** lives on another machine (federation); its sessionId is `peer_<peerId>~<remote id>` */
  peer?: SessionPeer;
}

/** What the library UI may do with a session, given its source's official APIs. */
export interface SourceCaps {
  resume: boolean;
  rename: boolean;
  archive: boolean;
  delete: boolean;
  fork: boolean;
}

/** One row of the "join a source" onboarding list (settings/library). */
export interface SourceStatus {
  kind: AgentKind;
  name: string;
  installed: boolean;
  detected: boolean;
  joined: boolean;
  dismissed: boolean;
  enabled: boolean; // joined && installed/available
  version?: string;
  count?: number;
  indexedAt?: number;
  /** First list still running past the per-source bound (no cached list yet) — not an error. */
  loading?: boolean;
  error?: string;
  disabledReason?: string;
}

export interface OpenSessionParams {
  sessionId?: string; // resume this session; omit to start a new one
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  ultracode?: boolean;
  fork?: boolean;
  resumeAt?: string; // fork from this message uuid (implies fork)
  worktree?: string; // create a git worktree with this name for the session
  workspaceId?: string;
  providerId?: string; // API provider profile; omit / 'claude' = the claude.ai login
  features?: SessionFeatures; // extra CLI flags / env
  agent?: AgentKind; // which CLI agent drives the session (default claude)
  /** Transcript entries to resume a Claude session from (SessionStore.load); used when a session
   *  is handed over from another agent and Claude has no native JSONL for this id. */
  resumeEntries?: Record<string, unknown>[];
  /** Server-set with `resumeEntries`: the hand-over briefing as text, sent as the first message by an engine that
   *  cannot resume from entries (ccb has no session mirror). */
  briefing?: string;
  /** Server-set: the prompt-cache route key when it is not this session's id — a fork's root (its prefix is the
   *  parent's), kept in `SessionMeta.cacheKey` for later reopens (runtime/cache-key.ts). */
  cacheParentId?: string;
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

export type ProviderType = 'anthropic' | 'openai' | 'gemini' | 'grok' | 'gateway';
/** A third-party API endpoint profile. Stored in ~/.claude-web/meta.json; the key is injected into the session process env only. */
export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string; // masked (sk-…1234) when sent to the client
  models?: string[]; // last probe result
  /** when `models` was last pulled from the endpoint's model list (providers.refreshModels / probe) */
  modelsAt?: number;
  /** the last model-list pull failed (the previous `models` are kept) */
  modelsError?: string;
  defaultModel?: string;
  modelMap?: { haiku?: string; sonnet?: string; opus?: string };
  runtime?: RuntimeKind; // force a runtime for this provider (some relays only accept the official client)
  /** type 'gateway': the local model-gateway group this profile routes through (baseUrl / apiKey are filled per session). */
  gatewayGroupId?: string;
  createdAt: number;
  // ---- prompt caching (2026-09-28; gateway/cache.ts, gateway/shim.ts) ----
  /** openai / grok: Claude (ccb) sessions go through the local cache shim (default on; false = straight to the endpoint). */
  cacheShim?: boolean;
  /** openai: inside the shim, gpt-* chat/completions → /v1/responses (default on; false = keep chat/completions). */
  responsesApi?: boolean;
  /** anthropic: 1-hour cache TTL — ENABLE_PROMPT_CACHING_1H for the official binary, ttl '1h' on gateway-translated requests. */
  cache1h?: boolean;
  /** openai: Anthropic-style cache_control markers on gateway-translated requests (Bailian explicit cache, OpenRouter anthropic/*). */
  cacheControlFormat?: 'anthropic';
  /** learned: the endpoint rejected `prompt_cache_key` (400) — no longer sent. */
  noPromptCacheKey?: boolean;
  /** learned: the endpoint has no /v1/responses (404 / 405 / 501, and chat/completions then worked) — the shim keeps chat/completions. */
  noResponsesApi?: boolean;
  /** learned: the endpoint rejected `prompt_cache_retention` by name — no longer sent on /v1/responses. */
  noCacheRetention?: boolean;
}
export const CLAUDE_PROVIDER_ID = 'claude';
/** One profile's result of `providers.refreshModels` (model list only — no chat request, no tokens). */
export interface ModelRefreshResult { id: string; name: string; ok: boolean; count: number; error?: string; ms: number }

/** Multi-agent (phase 5): built-in kinds plus user-defined ACP agents (`acp:<id>`). */
export type AgentKind = 'claude' | 'codex' | 'opencode' | 'gemini' | 'qwen' | 'kimi' | `acp:${string}`;

/**
 * Session library ids (shared by server/src/library/ids.ts and the web client): Claude keeps its bare
 * UUID; these built-in kinds are `<kind>-<native id>`; a custom ACP agent `acp:<id>` is
 * `acp_<id with '-' escaped as '~'>-<native id>`. No colons anywhere.
 */
export const LIBRARY_ID_PREFIXED_KINDS = ['codex', 'opencode', 'gemini', 'qwen', 'kimi'] as const satisfies readonly AgentKind[];

/** Inverse of `libraryId`. An id with no recognised prefix is a native Claude id. */
export function parseLibraryId(id: string): { kind: AgentKind; nativeId: string } {
  for (const k of LIBRARY_ID_PREFIXED_KINDS) if (id.startsWith(`${k}-`)) return { kind: k, nativeId: id.slice(k.length + 1) };
  if (id.startsWith('acp_')) {
    const rest = id.slice('acp_'.length);
    const dash = rest.indexOf('-');
    if (dash >= 0) return { kind: `acp:${rest.slice(0, dash).replace(/~/g, '-')}` as AgentKind, nativeId: rest.slice(dash + 1) };
  }
  return { kind: 'claude', nativeId: id };
}
/** What `network.proxy` answers (net/proxy.ts). URLs have their password masked. */
export interface ProxyStatus {
  setting: 'system' | 'off' | 'custom';
  custom?: string;
  active: string | null;
  source?: 'setting' | 'env' | 'system' | 'pac';
  detected?: string | null;
  note?: string;
  checkedAt: number;
}

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
  /** the provider new sessions of this agent run on ('' = its own login); settings → Agents 「用哪个供应商」 */
  providerId?: string;
  /** the executable that was found (absolute) */
  path?: string;
  /** set when `path` is a copy shipped inside another app (「Codex 桌面版」「Codex IDE 扩展」), not a CLI on PATH */
  from?: string;
  /** why it is not installed / why `--version` failed — shown on the card instead of a bare 「未安装」 */
  probeError?: string;
  /** not installed and the install command's tool (npm / uv) is missing too: what to get first */
  installNeeds?: { name: string; url: string };
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
export interface SessionMeta { pinned?: boolean; archived?: boolean; workspaceId?: string; tags?: string[]; providerId?: string; /** sidebar grouping directory when it differs from the cwd (orchestration worktrees) */ groupCwd?: string; /** prompt-cache route key when it is not the session's own id (forks keep their root's) */ cacheKey?: string }
export interface Schedule { id: string; name: string; cwd: string; prompt: string; everyMinutes: number; cron?: string; enabled: boolean; lastRunAt?: number; nextRunAt?: number; sessionId?: string; model?: string; permissionMode?: string; freshSession?: boolean; lastError?: string; runs?: number }
export interface LimitWindow { label: string; percent: number; resetsAt: string | null; active: boolean; severity?: string }
// ---- remote access / phones / IM (phase 6) ----
export interface DeviceInfo { id: string; name: string; createdAt: number; lastSeenAt: number; ip?: string; ua?: string }
export interface RemoteStatus { enabled: boolean; running: boolean; port: number; addresses: string[]; error: string; devices: DeviceInfo[]; pair: { code: string; expiresAt: number } | null; anywhere?: AnywhereStatus }
/** remote.pairCode: `url` is the LAN-only QR address; `anywhereUrl` the 在外面也能用 one (null while that is off). */
export interface RemotePairCode { code: string; expiresAt: number; url: string; anywhereUrl: string | null }
/** One connection a phone made through 在外面也能用 (newest first in `recent`); `error` only when it did not work. */
export interface AnywhereRecent { at: number; deviceId?: string; ok: boolean; kind?: LinkKind; error?: string }
/** 在外面也能用 (remote/anywhere/service.ts): the signaling brokers, the phones connected now, the last 20 connections. */
export interface AnywhereStatus {
  on: boolean;
  brokers: { name: string; ok: boolean; error?: string }[];
  /** Only links that are alive. */
  sessions: { deviceId: string; kind: LinkKind; since: number }[];
  recent: AnywhereRecent[];
  shellUrl: string;
  keepAwake: boolean;
}
/** Another machine running claude-web, reached through an ssh port-forward. */
export interface RemoteHost { id: string; name: string; target: string; sshPort?: number; identityFile?: string; remotePort: number; token?: string; startCommand?: string }
export interface TunnelInfo { hostId: string; localPort: number; url: string; state: 'connecting' | 'up' | 'down'; error: string; since: number }
export type ImKind = 'telegram' | 'discord' | 'slack' | 'feishu' | 'dingtalk' | 'wecom';
export interface ImGatewayConfig { id: string; kind: ImKind; name: string; enabled: boolean; config: Record<string, string>; allowUsers: string[]; allowNames: Record<string, string>; openAccess: boolean; defaultCwd: string; permissionMode: string; agent: string; verbose: boolean; /** '' / absent = the new-conversation default, 'claude' = the account (or the agent's own login), else a provider id */ providerId?: string }
export interface ImBinding { gatewayId: string; chatId: string; sessionId: string; cwd: string; since: number; /** the agent the session runs (reopening it must not start Claude on a Codex session id) */ agent?: string }
export interface ImGatewayInfo extends ImGatewayConfig { state: 'stopped' | 'starting' | 'running' | 'error'; error: string; botName: string; inbound: boolean; pairCode: string; pairExpiresAt: number; bindings: ImBinding[] }
export interface ImKindDef { kind: ImKind; name: string; icon: string; inbound: boolean; fields: { key: string; label: string; secret?: boolean; hint?: string }[]; help: string }

// ---- phase 7: issue / PR boards, goals, android ----
export interface VcsRepo { provider: 'github' | 'gitlab'; host: string; owner: string; repo: string; url: string; authOk: boolean; user: string; error: string; cli: 'gh' | 'glab'; defaultBranch?: string; openIssues?: number; private?: boolean }
export interface VcsItem { number: number; title: string; state: 'open' | 'closed' | 'merged'; isPr: boolean; draft?: boolean; author: string; labels: { name: string; color: string }[]; assignees: string[]; comments: number; createdAt: string; updatedAt: string; url: string; milestone?: string; head?: string; base?: string; additions?: number; deletions?: number; changedFiles?: number; reviewDecision?: string; checks?: 'success' | 'failure' | 'pending' | 'none'; mergeable?: boolean }
export interface VcsDetail extends VcsItem { body: string; comments: any; commentsList: { id: string; author: string; body: string; createdAt: string; url: string }[]; reviews?: { author: string; state: string; submittedAt: string }[]; files?: { path: string; additions: number; deletions: number; status: string }[]; checkRuns?: { name: string; status: string; conclusion: string; url: string }[]; mergeableState?: string }
export type GoalStatus = 'draft' | 'active' | 'paused' | 'complete' | 'blocked' | 'max_turns';
export interface GoalStep { id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }
export interface GoalEvidence { at: number; kind: 'file' | 'command' | 'test' | 'commit' | 'note' | 'error' | 'blocked'; summary: string; ref?: string; ok?: boolean }
export interface Goal { id: string; objective: string; spec: string; cwd: string; sessionId?: string; status: GoalStatus; turnsExecuted: number; maxTurns: number; tokensUsed: number; tokenBudget: number | null; costUsd?: number; createdAt: number; updatedAt: number; startedAt?: number; completedAt?: number; steps: GoalStep[]; evidence: GoalEvidence[]; lastResult?: string; agent?: string; permissionMode?: string; model?: string }
export interface AndroidDevice { serial: string; state: 'device' | 'offline' | 'unauthorized' | 'emulator'; model: string; product: string; emulator: boolean }
export interface AndroidStatus { adb: string; emulator: string; avds: string[]; devices: AndroidDevice[] }

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
  models?: ModelInfo[];
  /** Claude only: xhigh + dynamic workflow orchestration, session-scoped. */
  ultracode?: boolean;
  supportsUltracode?: boolean;
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
  /** `providerId`: the provider the pick was made for ('claude' = the account); a switch in between drops the pick */
  | { kind: 'session.setModel'; sessionId: string; model: string; providerId?: string }
  | { kind: 'session.setEffort'; sessionId: string; effort: EffortLevel }
  | { kind: 'session.setUltracode'; sessionId: string; on: boolean }
  | { kind: 'session.setProvider'; sessionId: string; providerId?: string; model?: string } // model: the respawned process starts on it
  | { kind: 'session.switchAgent'; sessionId: string; agent: AgentKind; model?: string }
  | { kind: 'session.canonical'; sessionId: string }
  | { kind: 'memory.search'; query?: string; scope?: MemoryScope; cwd?: string; sessionId?: string; kind_?: MemoryKind; limit?: number }
  | { kind: 'memory.write'; text: string; scope?: MemoryScope; cwd?: string; sessionId?: string; kind_?: MemoryKind; tags?: string[]; pinned?: boolean }
  | { kind: 'memory.update'; id: string; patch: { text?: string; kind?: MemoryKind; tags?: string[]; pinned?: boolean; scope?: MemoryScope } }
  | { kind: 'memory.remove'; id: string }
  | { kind: 'memory.stats' }
  | { kind: 'memory.harvest'; sessionId: string }
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
  | { kind: 'providers.probe'; id?: string; provider?: Partial<Provider>; listOnly?: boolean } // saved profile by id, or an unsaved draft; listOnly: the model list, no chat check
  | { kind: 'providers.refreshModels'; ids?: string[] } // pull /v1/models for these (default: every non-gateway) profiles
  | { kind: 'settings.get' }
  | { kind: 'settings.set'; key: string; value: unknown }
  /** The outbound proxy in use (net/proxy.ts); `refresh` looks at the system again. Set it with settings.set 'network.proxy'. */
  | { kind: 'network.proxy'; refresh?: boolean }
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
  | { kind: 'config.auth'; force?: boolean }
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
  /** a renderer error an ErrorBoundary caught: written to the server log (server.log in the desktop build) */
  | { kind: 'client.log'; level: 'error' | 'warn'; area: string; message: string; stack?: string; componentStack?: string; url?: string }
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
  /** `anywhere` / `keepAwake` are the settings remote.anywhere / remote.keepAwake; the listener restarts only for enabled / port. */
  | { kind: 'remote.set'; enabled?: boolean; port?: number; anywhere?: boolean; keepAwake?: boolean }
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
  | { kind: 'vcs.repo'; cwd: string; repo?: string }
  | { kind: 'vcs.issues'; cwd: string; repo?: string; state?: 'open' | 'closed' | 'all'; q?: string; page?: number; mine?: boolean }
  | { kind: 'vcs.pulls'; cwd: string; repo?: string; state?: 'open' | 'closed' | 'merged' | 'all'; page?: number }
  | { kind: 'vcs.item'; cwd: string; repo?: string; number: number; isPr: boolean }
  | { kind: 'vcs.comment'; cwd: string; repo?: string; number: number; isPr: boolean; body: string }
  | { kind: 'vcs.setState'; cwd: string; repo?: string; number: number; isPr: boolean; state: 'open' | 'closed' }
  | { kind: 'vcs.assign'; cwd: string; repo?: string; number: number; isPr: boolean; assignees: string[] }
  | { kind: 'vcs.labels'; cwd: string; repo?: string; number: number; isPr: boolean; labels: string[] }
  | { kind: 'vcs.merge'; cwd: string; repo?: string; number: number; method: 'merge' | 'squash' | 'rebase' }
  | { kind: 'vcs.create'; cwd: string; repo?: string; title: string; body?: string; isPr?: boolean; head?: string; base?: string; draft?: boolean; labels?: string[] }
  | { kind: 'vcs.checkout'; cwd: string; repo?: string; number: number; worktree?: boolean }
  | { kind: 'goals.list' }
  | { kind: 'goals.create'; objective: string; spec?: string; cwd: string; maxTurns?: number; tokenBudget?: number | null; agent?: string; permissionMode?: string; model?: string }
  | { kind: 'goals.update'; id: string; patch: Partial<Pick<Goal, 'objective' | 'spec' | 'maxTurns' | 'tokenBudget' | 'cwd' | 'agent' | 'permissionMode' | 'model'>> }
  | { kind: 'goals.start'; id: string }
  | { kind: 'goals.pause'; id: string }
  | { kind: 'goals.resume'; id: string }
  | { kind: 'goals.complete'; id: string }
  | { kind: 'goals.remove'; id: string }
  | { kind: 'goals.note'; id: string; text: string }
  | { kind: 'android.status' }
  | { kind: 'android.screenshot'; serial: string }
  | { kind: 'android.input'; serial: string; input: { kind: 'tap'; x: number; y: number } | { kind: 'swipe'; x1: number; y1: number; x2: number; y2: number; ms?: number } | { kind: 'key'; code: string | number } | { kind: 'text'; text: string } }
  | { kind: 'android.install'; serial: string; apk: string }
  | { kind: 'android.logcat'; serial: string; lines?: number; filter?: string; clear?: boolean }
  | { kind: 'android.packages'; serial: string }
  | { kind: 'android.launchApp'; serial: string; pkg: string }
  | { kind: 'android.startEmulator'; avd: string }
  | { kind: 'agents.set'; agent: AgentKind; patch: { command?: string; args?: string[]; env?: Record<string, string>; model?: string; label?: string; enabled?: boolean; name?: string; protocol?: 'acp' | 'codex'; providerId?: string } | null }
  | { kind: 'terminal.open'; cwd: string; cols: number; rows: number }
  | { kind: 'terminal.input'; termId: string; data: string }
  | { kind: 'terminal.resize'; termId: string; cols: number; rows: number }
  | { kind: 'terminal.close'; termId: string }
  // ---- unified session library (phase 13) ----
  | { kind: 'library.sources' }
  | { kind: 'library.read'; sessionId: string; cursor?: string; limit?: number }
  | { kind: 'library.rename'; sessionId: string; title: string }
  | { kind: 'library.archive'; sessionIds: string[]; archived: boolean }
  | { kind: 'library.delete'; sessionIds: string[] }
  | { kind: 'library.fork'; sessionId: string }
  | { kind: 'library.reindex' }
  | { kind: 'library.join'; kind_: AgentKind; joined: boolean }
  | { kind: 'library.dismiss'; kind_: AgentKind }
  | GatewayRequest
  // ---- other agents' configuration center (phase 17) ----
  | AgentConfigRequest
  // ---- multi-agent orchestration ----
  | OrchestraRequest

  // ---- cross-machine sessions (federation) ----
  | PeerRequest;

/** `via`: serverIds a forwarded request already passed through (federation loop guard). */
export interface RequestEnvelope { id: string; req: ClientRequest; via?: string[] }
export interface ReplyEnvelope { id: string; ok: boolean; data?: unknown; error?: string }

// ---- events ----
export type ServerEvent =
  | { kind: 'hello'; version: string; serverId?: string; name?: string; bootId?: string }
  | { kind: 'session.event'; sessionId: string; message: unknown } // raw SDK message
  | { kind: 'session.state'; sessionId: string; state: RunnerState; error?: string }
  | { kind: 'session.info'; info: SessionInfoSnapshot }
  | { kind: 'permission.request'; request: PermissionRequestEvent }
  | { kind: 'permission.resolved'; requestId: string }
  | { kind: 'sessions.changed' }
  /** conversations whose record changed on disk (a CLI in a terminal, Codex): an open one that is not running here re-reads it */
  | { kind: 'transcripts.changed'; sessionIds: string[] }
  | { kind: 'meta.changed' }
  | { kind: 'remote.changed' }
  | { kind: 'im.changed' }
  | { kind: 'tunnel.changed' }
  | { kind: 'goals.changed' }
  | { kind: 'memory.changed' }
  | { kind: 'limits'; limits: Limits }
  | { kind: 'terminal.data'; termId: string; data: string }
  | { kind: 'terminal.exit'; termId: string; code: number | null }
  | { kind: 'fs.changed'; path: string; type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' }
  | { kind: 'git.changed'; cwd: string }
  // detected on this machine, not yet joined and not dismissed
  | { kind: 'library.discovered'; kinds: AgentKind[] }
  // a library mutation (join / leave / rename / archive / delete / fork) — refetch sessions.list
  | { kind: 'library.changed' }
  | GatewayEvent
  | PeerEvent
  | OrchestraEvent;

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
export interface LedgerEntry { ts: number; sessionId: string; model: string; durationMs: number; apiMs?: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; ok: boolean; error?: string; turns?: number; providerId?: string; kind?: 'gateway'; gateway?: GatewayLedgerInfo; /** cost not known (non-Claude model, gateway / shim call): costUsd is 0 but must not read as $0 */ costUnknown?: boolean }
export interface ScheduleRun { id: string; scheduleId: string; at: number; sessionId?: string; ok: boolean; durationMs?: number; summary?: string; error?: string }

export type WireDown = { type: 'reply'; reply: ReplyEnvelope } | { type: 'event'; event: ServerEvent };
export type WireUp = { type: 'request'; request: RequestEnvelope };

// ---------- model gateway (sub-project 4) ----------
export * from './gateway/types.js';
import type { GatewayEvent, GatewayLedgerInfo, GatewayRequest } from './gateway/types.js';
