// Shared wire protocol between server and web. Web imports this via the `@shared` alias.
// One WebSocket. Client -> server requests carry an `id` and get exactly one `reply`.
// Server -> client events carry no `id`.

export * from './federation/types.js';
import type { PeerEvent, PeerRequest, SessionPeer } from './federation/types.js';
import type { OrchestraEvent, OrchestraRequest } from './orchestra/types.js';
export * from './orchestra/types.js';
import type { BackgroundEvent, BackgroundRequest } from './background/types.js';
import type { CharactersEvent, CharactersRequest } from './characters/core/types.js';
export * from './background/types.js';
export * from './characters/core/types.js';
/** stage E5: WSL ↔ Windows paths (pure, the web side uses them too) */
export * from './wsl/paths.js';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
export type MemoryScope = 'global' | 'project' | 'session';
export type MemoryKind = 'decision' | 'constraint' | 'fact' | 'deadend' | 'preference' | 'note';
export interface MemoryItem {
  id: string; scope: MemoryScope; key: string; kind: MemoryKind; text: string; tags: string[];
  sourceSession?: string; sourceAgent?: string; pinned: boolean; hits: number; createdAt: number; updatedAt: number;
}

// `ultracode` is NOT here on purpose: in Claude Code it is a separate session-scoped boolean (xhigh + dynamic
// workflows) that CLAUDE_CODE_EFFORT_LEVEL rejects.
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
  source?: string; // cli / vscode / … (how the native session was created)
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
  /** A send goes on in a Claude conversation seeded with this history (any provider / model), not in the tool that
   *  wrote it (`resume` is then true too). */
  continueInClaude?: boolean;
}

/** One row of the "join a source" onboarding list (settings/library). */
export interface SourceStatus {
  kind: AgentKind;
  name: string;
  installed: boolean;
  detected: boolean;
  joined: boolean;
  enabled: boolean; // joined && installed/available
  version?: string;
  count?: number;
  indexedAt?: number;
  /** First list still running past the per-source bound (no cached list yet) — not an error. */
  loading?: boolean;
  error?: string;
  disabledReason?: string;
  /** what its official interface allows: a read-only source can be viewed and searched, not continued */
  caps?: SourceCaps;
}

/** stage E5: where a conversation runs — this computer, or inside one of its WSL distros */
export type SessionEnv = { kind: 'local' } | { kind: 'wsl'; distro: string };
export interface WslDistro { name: string; claude: boolean | null; interop: boolean | null; home: string | null }
export type { SshProbe } from './remote/ssh-probe.js';
export interface OpenSessionParams {
  sessionId?: string; // resume this session; omit to start a new one
  /** stage E5: run it inside a WSL distro (local only; recorded in the session meta) */
  env?: SessionEnv;
  /** 新对话选机器: start it on this federation peer (its id); routed and dropped by federation/rewrite.ts */
  peer?: string;
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  /**
   * The permission mode the chip of a conversation that is not running showed when the user sent (no permissionMode
   * named). The server resolves the resume mode as usual; when it differs it does not start and answers
   * `{ modeChanged: <actual> }` — the client updates the chip and asks for another send. Never recorded, never escalates.
   */
  expectMode?: PermissionMode;
  effort?: EffortLevel;
  ultracode?: boolean;
  /** the model subagents run on ('' = the same as the main model); absent = the conversation's own pick for its
   *  provider, else the provider's default (models/subagent.ts) */
  subagentModel?: string;
  fork?: boolean;
  resumeAt?: string; // fork from this message uuid (implies fork)
  worktree?: string; // create a git worktree with this name for the session
  workspaceId?: string;
  providerId?: string; // API provider profile; omit / 'claude' = the claude.ai login
  features?: SessionFeatures; // extra CLI flags / env
  /** Transcript entries to resume a Claude session from (SessionStore.load); used when a session continues one
   *  Claude has no native JSONL for (a claude.ai export). */
  resumeEntries?: Record<string, unknown>[];
  /** Server-set: the run is driven from IM, a scheduled task or the orchestra — its replies are not read in Claude Web
   *  first, so no ```nodegraph hint (review D-minor) */
  drivenBy?: 'im' | 'schedule' | 'orchestra';
}

/** The Claude Code binary every session runs on (the Agent SDK's own, or a global / CLAUDE_WEB_EXE one). */
export interface EngineInfo {
  version?: string;
  path: string;
  source: 'bundled' | 'global' | 'env';
  /** 操控电脑 (the `computer` MCP server) can run on the machine this server is on — Windows, for now */
  computerUse?: boolean;
}

/** `claude-account`: another Claude (Pro / Max) account — its long-lived token from `claude setup-token` in `apiKey` */
export type ProviderType = 'anthropic' | 'claude-account';
/** A third-party API endpoint profile. Stored in ~/.claude-web/meta.json; the key is injected into the session process env only. */
/** 从其它工具导入 (server/src/import/): one thing another tool on this computer has configured. */
export interface ImportItem {
  key: string;
  kind: 'provider' | 'mcp';
  /** the tool it comes from (import/scan.ts SourceId) */
  from: string;
  name: string;
  /** a provider's base URL, an MCP server's command line or URL */
  detail: string;
  type?: ProviderType;
  hasKey?: boolean;
  models?: number;
  /** this app has it already (same endpoint and key / an MCP server of that name) */
  already: boolean;
  /** an MCP server whose command is a full path to a file that is not there (an updated extension's old folder) */
  missing?: boolean;
}
export interface ImportScan { items: ImportItem[]; unreadable: { from: string; reason: 'encrypted' | 'browser-db' }[]; scanned: string[] }
export interface ImportResult { providers: string[]; mcp: string[]; skipped: string[]; failed: { key: string; error: string }[] }

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string; // masked (sk-…1234) when sent to the client
  models?: string[]; // last probe result
  /**
   * Display names the model list gave, where they differ from the id (DeepSeek's `deepseek-flash` is named
   * 「DeepSeek-V4.1-Flash」; Anthropic `display_name`, Gemini `displayName`, OpenRouter `name`). Only for showing.
   */
  modelNames?: Record<string, string>;
  /**
   * Thinking-strength levels the model list declares (official DeepSeek: `effort.supported_levels` /
   * `default_level`), only the five we know, in order. Pulled with the list, replaced with it.
   */
  modelEfforts?: Record<string, { levels: EffortLevel[]; default?: EffortLevel }>;
  /** context window (tokens) each model's list entry declared (`context_length`, `max_input_tokens`…), pulled with the list */
  modelContext?: Record<string, number>;
  /** context window (tokens) the user set per model in the provider's settings; wins over everything else */
  contextWindows?: Record<string, number>;
  /** 自动压缩 (A7): compact at this many tokens on this provider's conversations (CLAUDE_CODE_AUTO_COMPACT_WINDOW, over the user's settings.json); unset = follow the window. For a claude-account profile, contextWindows holds the family picks (opus / sonnet / fable → 200000 | 1000000). */
  compactAt?: number;
  /** when `models` was last pulled from the endpoint's model list (providers.refreshModels / probe) */
  modelsAt?: number;
  /** the last model-list pull failed (the previous `models` are kept) */
  modelsError?: string;
  defaultModel?: string;
  modelMap?: { haiku?: string; sonnet?: string; opus?: string };
  createdAt: number;
  /** anthropic: 1-hour prompt-cache TTL (ENABLE_PROMPT_CACHING_1H) */
  cache1h?: boolean;
  /**
   * How the key is sent (spec 2026-10-26 §5.1): `Authorization: Bearer`, `x-api-key`, or both. Unset = each path's
   * old behaviour (sessions Bearer, the model list both). Honoured by the session env and the model-list probe.
   */
  authStyle?: 'bearer' | 'x-api-key' | 'both';
}
export const CLAUDE_PROVIDER_ID = 'claude';
/** One profile's result of `providers.refreshModels` (model list only — no chat request, no tokens). */
export interface ModelRefreshResult { id: string; name: string; ok: boolean; count: number; error?: string; ms: number }
/**
 * `config.compactSource`: the compaction point (CLAUDE_CODE_AUTO_COMPACT_WINDOW) in effect for the user and where it
 * comes from — the user-level ~/.claude/settings.json `env`, else the server's environment, else none (no `value`).
 */
export interface CompactSource { value?: number; source: 'settings' | 'env' | 'none' }

/** Where a conversation comes from: Claude Code, or a claude.ai data export (stage F4, read-only). */
export type AgentKind = 'claude' | 'claudeai';

/**
 * Session library ids (shared by server/src/library/ids.ts and the web client): Claude keeps its bare
 * UUID; a claude.ai export's are `claudeai-<native id>`. No colons anywhere.
 */
export const LIBRARY_ID_PREFIXED_KINDS = ['claudeai'] as const satisfies readonly AgentKind[];

/** Inverse of `libraryId`. An id with no recognised prefix is a native Claude id. */
export function parseLibraryId(id: string): { kind: AgentKind; nativeId: string } {
  for (const k of LIBRARY_ID_PREFIXED_KINDS) if (id.startsWith(`${k}-`)) return { kind: k, nativeId: id.slice(k.length + 1) };
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

// ---- 联网: web search + the built-in browser, for every agent (server/src/web) ----
/** One operation on the built-in browser. Args: open `{url}`, read `{offset?, maxChars?}`, find `{query}`, click `{ref}`,
 *  type `{ref, text, submit?}`, key `{key}`, scroll `{direction: 'up' | 'down', amount?}`, back `{}`, screenshot `{}`. */
/** `search`: load a search engine's result page (in a page of its own, not the conversation's tab) and list what it shows. `computer`: mouse and keyboard at coordinates of the last screenshot. */
/** `console` `{errorsOnly?}` / `network` `{failedOnly?}`: what the page's DevTools protocol recorded (the shell keeps
 *  the last 200 of each). `snapshot` `{}`: the page's structure, one element a line, with the refs click / type take.
 *  `wait` `{text? | ref?, timeoutMs}`. `tabs` `{action: 'list' | 'switch' | 'new' | 'close', id?, url?}`: the
 *  conversation's own tabs only. `viewport` `{preset: 'auto' | 'phone' | 'tablet' | 'desktop'}`. */
/** `hover` `{ref}` / `drag` `{from, to}` (refs; a real mouse), `select` `{ref, value: string | string[]}` (a list's
 *  option by value or text), `eval` `{script}` (run in the page; the result as JSON, cut to 8 KB). Page-changing ops
 *  carry `site`: the host the server checked (web/site-gate.ts) — the window refuses when its page is elsewhere now. */
export type BrowserOp = 'open' | 'read' | 'find' | 'click' | 'type' | 'key' | 'scroll' | 'back' | 'screenshot' | 'search' | 'computer' | 'console' | 'network' | 'snapshot' | 'wait' | 'tabs' | 'viewport' | 'hover' | 'drag' | 'select' | 'eval';
/** One console message of a page (console.*, an uncaught error, the browser's own lines such as a failed load). `at`: ms since 1970. */
export interface BrowserConsoleEntry { level: string; text: string; at: number; url?: string }
/** One request of a page. No `status` and no `failed`: still on its way. `ms`: how long it took. */
export interface BrowserNetworkEntry { method: string; url: string; status?: number; ms?: number; type?: string; failed?: string }
/** A tab of the conversation's Agent; `active`: the one its browser tools work in. */
export interface BrowserTabInfo { id: string; url: string; title: string; active: boolean }
/** Something on the page the agent can act on (`ref` goes back in click / type). */
export interface BrowserElement { ref: string; role: string; name: string; value?: string; href?: string }
/** A page as text. `text` starts at the offset that was asked for (0 for open); `nextOffset` is where the rest begins. */
export interface BrowserPage { url: string; title: string; text: string; truncated?: boolean; nextOffset?: number; elements?: BrowserElement[] }
/** Sent to the ONE window hosting the browser (`browser.command`); it answers with the request `browser.result` and the same id. */
export interface BrowserCommand { id: string; sessionId: string; op: BrowserOp; args: Record<string, unknown> }
/** What a result page listed, as the page had it (the server knows each engine's link wrapping): `failed` = the page could not be loaded. */
export interface BrowserSearchPage { url: string; title: string; text: string; candidates: { title: string; href: string; snippet?: string; alt?: string }[]; failed?: string }
/** `image.width / height`: the picture's own size in pixels — the frame `computer` coordinates are given in. */
export interface BrowserAnswer { page?: BrowserPage; elements?: BrowserElement[]; image?: { mime: 'image/jpeg' | 'image/png'; data: string; width?: number; height?: number }; note?: string; search?: BrowserSearchPage; console?: BrowserConsoleEntry[]; network?: BrowserNetworkEntry[]; tabs?: BrowserTabInfo[]; result?: string }
/** `web.status`: the switch (`web.mcp`), the search engine, whether a desktop window is hosting the browser. Keys never leave the server. */
export interface WebStatus {
  enabled: boolean; engine: string; engines: { id: string; label: string; needsKey: boolean; hasKey?: boolean; browser?: boolean }[]; host: boolean; isolated: boolean;
  /** Which browser Claude acts in (`web.browser.agent`) and whether ego lite's `ego-browser` command was found. */
  agentBrowser: 'auto' | 'builtin';
  ego: { found: boolean; version?: string };
}
export interface WebSearchResult { title: string; url: string; snippet: string }
/** What `web.search` answers (the settings page's 「试一下」). `weak`: the results match little of the query (Bing answering a program) and nothing better was to be had. */
export interface WebSearchAnswer { engine: string; results: WebSearchResult[]; weak?: boolean }

/** Optional per-session switches. Each maps to a CLI flag or env var; unknown to the engine = ignored/error. */
export interface SessionFeatures {
  chrome?: boolean; // --chrome (Claude in Chrome MCP)
  /** kept for stored defaults; ignored — the engine has computer use only in its own terminal interface (session-runner featureArgs) */
  computerUse?: boolean;
  brief?: boolean; // --brief (SendUserMessage tool)
  env?: Record<string, string>; // extra env for the CLI process (provider keys, LANGFUSE_*, ...)
  /** 只聊天: no tools at all — no files, no commands, no MCP (remembered per conversation: SessionMeta.chatOnly) */
  chatOnly?: boolean;
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

export interface Workspace { id: string; path: string; name: string; addedAt: number; order: number; /** extra folders (stage C2): never the main path; [] for old data */ folders: string[]; /** 项目页 (stage F2): appended to the system prompt of every conversation in the project */ instructions?: string; /** the sessions tools of its conversations only see this project's conversations */ sessionsScope?: 'project'; /** the permission mode 派活 (stage F3) starts its conversations in */ permissionMode?: PermissionMode; /** made by 导入 claude.ai 数据 from this claude.ai project (stage F4) */ claudeAiUuid?: string }
export interface SessionMeta {
  /** replies pinned with 📌 under them (the info column's 钉住 card): their item id and first words */
  pinnedMsgs?: { id: string; text: string }[];
  /** a rename made while the conversation's process ran (server/src/meta/store.ts) */
  /** stage E1 自动处理评论: when the switch went on (0 / absent = off), comment ids already handed over (newest 200), the batch waiting for a push */
  prAutoComments?: number; prCommentsDone?: string[]; prCommentsSent?: { ids: string[]; sha: string; at: number; /** local HEAD when the batch went, and the commit made after it (fix E-I2) */ head?: string; commit?: string };
  /** stage E5: the machine it runs on (WSL); stage E3: the built-in browser's recordings (newest 20) */
  env?: SessionEnv; browserRecordings?: { path: string; start: number; end: number }[];
  pendingTitle?: string; /** 只聊天: started without tools; a resume keeps it that way */ chatOnly?: boolean; /** 保持电脑唤醒 while this conversation is busy */ keepAwake?: boolean; /** 代码审查卡: findings dismissed here, `<toolUseId>#<index>` */ reviewDismissed?: string[]; /** 任务 chip: suggestions dismissed (tool use ids), and started (tool use id → the new conversation) */ taskDismissed?: string[]; taskStarted?: Record<string, string>; /** PR 监控条: 自动修 CI on, and the failures it already asked about */ prAutoFix?: boolean; prFixed?: string[]; pinned?: boolean; archived?: boolean; workspaceId?: string; tags?: string[]; providerId?: string; /** sidebar grouping directory when it differs from the cwd (orchestration worktrees) */ groupCwd?: string; /** the model its subagents run on, picked for this provider ('' = the main model) */ subagent?: { providerId: string; model: string }; /** the permission mode it last ran with: a resume without a pick comes back in it (the SDK never says it) */ permissionMode?: PermissionMode; /** 思考用的语言 for this conversation: '' / absent = the setting `ai.thinkingLanguage`, 'off' = none here, 'auto' = the interface language, else a THINKING_LANGUAGES id */ thinkingLanguage?: string; /** a `continueInClaude` source's conversation: the Claude conversation it goes on in */ continuedAs?: string; /** the Claude conversation of a `continuedAs`: what it goes on from, and how many of its messages are in it */ continuedFrom?: string; replayed?: number; /** 派活 (stage F3): started by a dispatch, and from where */ origin?: 'dispatch'; dispatchFrom?: DispatchFrom; /** 交给常开机器继续 (stage F1): handed to that machine, read-only here */ handedOff?: HandoffInfo; /** the always-on machine's copy: where it came from */ handoffFrom?: HandoffFrom; /** the project instructions it started with (new conversations only; a resume keeps them) */ projectInstructions?: string }
export interface Schedule { id: string; name: string; cwd: string; prompt: string; everyMinutes: number; cron?: string; enabled: boolean; lastRunAt?: number; nextRunAt?: number; sessionId?: string; model?: string; permissionMode?: string; freshSession?: boolean; lastError?: string; runs?: number; /** 手动: only 立即运行 starts it */ manual?: boolean; /** each run in its own worktree (with freshSession) */ worktree?: boolean }
export interface LimitWindow { label: string; percent: number; resetsAt: string | null; active: boolean; severity?: string }
// ---- remote access / phones / IM (phase 6) ----
export interface DeviceInfo { id: string; name: string; createdAt: number; lastSeenAt: number; ip?: string; ua?: string; /** another computer (federation) */ kind?: 'peer' }
export interface RemoteStatus { enabled: boolean; running: boolean; port: number; addresses: string[]; error: string; devices: DeviceInfo[]; pair: { code: string; expiresAt: number } | null; /** 不让电脑睡眠 (setting remote.keepAwake) */ keepAwake: boolean }
/** remote.pairCode: `url` is the LAN QR address. */
export interface RemotePairCode { code: string; expiresAt: number; url: string }
/** Another machine running claude-web, reached through an ssh port-forward. */
export interface RemoteHost { id: string; name: string; target: string; sshPort?: number; identityFile?: string; remotePort: number; token?: string; startCommand?: string }
export interface TunnelInfo { hostId: string; localPort: number; url: string; state: 'connecting' | 'up' | 'down'; error: string; since: number }
export type ImKind = 'telegram' | 'discord' | 'slack' | 'feishu' | 'dingtalk' | 'wecom';
export interface ImGatewayConfig { id: string; kind: ImKind; name: string; enabled: boolean; config: Record<string, string>; allowUsers: string[]; allowNames: Record<string, string>; openAccess: boolean; defaultCwd: string; permissionMode: string; verbose: boolean; /** '' / absent = the new-conversation default, 'claude' = the account, else a provider id */ providerId?: string }
export interface ImBinding { gatewayId: string; chatId: string; sessionId: string; cwd: string; since: number }
export interface ImGatewayInfo extends ImGatewayConfig { state: 'stopped' | 'starting' | 'running' | 'error'; error: string; botName: string; inbound: boolean; pairCode: string; pairExpiresAt: number; bindings: ImBinding[] }
export interface ImKindDef { kind: ImKind; name: string; icon: string; inbound: boolean; fields: { key: string; label: string; secret?: boolean; hint?: string }[]; help: string }

// ---- phase 7: issue / PR boards, goals, android ----
export interface VcsRepo { provider: 'github' | 'gitlab'; host: string; owner: string; repo: string; url: string; authOk: boolean; user: string; error: string; cli: 'gh' | 'glab'; defaultBranch?: string; openIssues?: number; private?: boolean }
/** PR 监控条: a pull request's checks, summed up (`failures`: where to look — `runId` for `gh run view --log-failed`). */
export interface PrChecks { total: number; passed: number; failed: number; pending: number; failures: { name: string; url: string; runId?: number }[] }
/** PR 监控条: the pull request of a conversation's branch. `sha`: its head commit (a new push re-arms the CI auto-fix). */
export interface BranchPr { /** GitHub's review decision (none when the repository needs no review) */ review?: 'approved' | 'changes' | 'required'; id: string; number: number; title: string; url: string; state: 'open' | 'closed' | 'merged'; draft: boolean; mergeable?: boolean; autoMerge: boolean; sha: string; checks: PrChecks; /** stage E: which forge (missing = github) */ host?: 'github' | 'gitlab'; /** the target branch */ base?: string }
/** A PR/MR review comment (stage E1). `body` is untrusted text from whoever wrote it. */
export interface PrComment { id: string; kind: 'thread' | 'general'; threadId?: string; replyTo?: string; author: string; bot: boolean; trusted: boolean; body: string; path?: string; line?: number; diff?: string; url: string; createdAt: string }
export type PrCommentRef = Pick<PrComment, 'id' | 'kind' | 'threadId' | 'replyTo'>
export interface VcsItem { number: number; title: string; state: 'open' | 'closed' | 'merged'; isPr: boolean; draft?: boolean; author: string; labels: { name: string; color: string }[]; assignees: string[]; comments: number; createdAt: string; updatedAt: string; url: string; milestone?: string; head?: string; base?: string; additions?: number; deletions?: number; changedFiles?: number; reviewDecision?: string; checks?: 'success' | 'failure' | 'pending' | 'none'; mergeable?: boolean }
export interface VcsDetail extends VcsItem { body: string; comments: any; commentsList: { id: string; author: string; body: string; createdAt: string; url: string }[]; reviews?: { author: string; state: string; submittedAt: string }[]; files?: { path: string; additions: number; deletions: number; status: string }[]; checkRuns?: { name: string; status: string; conclusion: string; url: string }[]; mergeableState?: string }
export type GoalStatus = 'draft' | 'active' | 'paused' | 'complete' | 'blocked' | 'max_turns';
export interface GoalStep { id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }
export interface GoalEvidence { at: number; kind: 'file' | 'command' | 'test' | 'commit' | 'note' | 'error' | 'blocked'; summary: string; ref?: string; ok?: boolean }
export interface Goal { id: string; objective: string; spec: string; cwd: string; sessionId?: string; status: GoalStatus; turnsExecuted: number; maxTurns: number; tokensUsed: number; tokenBudget: number | null; costUsd?: number; createdAt: number; updatedAt: number; startedAt?: number; completedAt?: number; steps: GoalStep[]; evidence: GoalEvidence[]; lastResult?: string; permissionMode?: string; model?: string }
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
  /** stage E5: running inside this WSL distro; `dropped` = injected MCP servers that could not start there */
  wsl?: { distro: string; dropped: string[] };
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
  /** Claude: the model subagents run on (absent = the same as the main model) */
  subagentModel?: string;
  claudeCodeVersion?: string;
  /** Claude: fast mode as the CLI last reported it (absent: it never said — an engine without it) */
  fastMode?: 'off' | 'cooldown' | 'on';
  /** why fast mode can't serve right now (the SDK's FastModeDisabledReason) */
  fastModeOff?: string;
  /**
   * Claude: the autocompact cap this conversation's engine runs with — `CLAUDE_CODE_AUTO_COMPACT_WINDOW` as its CLI
   * ends up with it (the runner's own cap for the official binary, the session's / 本机环境变量, the user's settings
   * files, the server's environment: `runtime/user-env.ts` `compactCap`). The engine caps the context window at it, so
   * every context percentage outside the engine's own count divides by `min(model window, compactWindow)`
   * (`web/src/features/composer/stats.ts` estimateContext). Absent: no cap. A per-provider compaction setting is to
   * feed this same field.
   */
  compactWindow?: number;
  /** the model's context window in this conversation as the engine will use it (A7): the provider's setting, or on the account 1M / 200K per the family pick */
  contextWindow?: number;
  providerId?: string;
  providerName?: string;
  features?: SessionFeatures;
  error?: string;
}

// ---- requests ----
/** One question and answer of a side chat (旁聊), as the CLI wants them. */
/** A file Claude wrote (Write / Artifact) in a recent conversation, still on disk. */
export interface ArtifactRef { path: string; sessionId: string; title: string; at: number }

export interface SideTurn { question: string; response: string }

export type ClientRequest =
  | { kind: 'sessions.list'; limit?: number }
  | { kind: 'sessions.projects' }
  /** `page`: answer `{ messages, next? }` — the newest page (or the one before `cursor`) instead of the whole array */
  | { kind: 'transcript.load'; sessionId: string; page?: boolean; cursor?: string }
  | { kind: 'transcript.subagent'; sessionId: string; agentId: string }
  | { kind: 'transcript.subagents'; sessionId: string }
  | { kind: 'session.open'; params: OpenSessionParams }
  | { kind: 'session.info'; sessionId: string }
  | { kind: 'session.send'; params: SendParams }
  | { kind: 'session.interrupt'; sessionId: string }
  /** @ file completion: files under `root` matching `query` → `{ files: string[] }` (relative, `/`-separated) */
  | { kind: 'fs.findFiles'; root: string; query: string; limit?: number }
  /** 旁聊: a question about the conversation that never enters it → `{ text: string | null; synthetic? }`, or
   *  `{ error: 'not-open' | 'unsupported' }`. `history`: this side chat's earlier turns */
  | { kind: 'session.side'; sessionId: string; question: string; history?: SideTurn[] }
  | { kind: 'session.close'; sessionId: string }
  | { kind: 'session.setPermissionMode'; sessionId: string; mode: PermissionMode }
  /** The permission mode a resume of this conversation that names none would run in (its record, else 新对话默认权限): what the chip of one that is not running shows. `{ permissionMode?: PermissionMode }` */
  | { kind: 'session.resumeMode'; sessionId: string }
  /** `providerId`: the provider the pick was made for ('claude' = the account); a switch in between drops the pick */
  | { kind: 'session.setModel'; sessionId: string; model: string; providerId?: string }
  | { kind: 'session.setEffort'; sessionId: string; effort: EffortLevel }
  | { kind: 'session.setUltracode'; sessionId: string; on: boolean }
  /** '' = the same as the main model. `providerId`: the provider the pick was made for (a switch in between drops it) */
  | { kind: 'session.setSubagentModel'; sessionId: string; model: string; providerId?: string }
  | { kind: 'session.setProvider'; sessionId: string; providerId?: string; model?: string } // model: the respawned process starts on it
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
  | { kind: 'session.fastMode'; sessionId: string; on: boolean }
  /** the browser's empty page: a project's .claude/launch.json servers, and starting one (preview/service.ts) */
  | { kind: 'preview.list'; cwd: string }
  | { kind: 'preview.start'; cwd: string; name: string }
  | { kind: 'session.toggleMcp'; sessionId: string; name: string; enabled: boolean }
  | { kind: 'permission.respond'; requestId: string; response: PermissionResponse }
  | { kind: 'workspaces.list' }
  | { kind: 'workspaces.add'; path: string }
  | { kind: 'workspaces.remove'; id: string }
  | { kind: 'workspaces.rename'; id: string; name: string }
  | { kind: 'workspaces.reorder'; ids: string[] }
  /** 编辑项目 (stage C2): the name and / or the extra folders (absolute, existing folders) → the updated Workspace */
  | { kind: 'workspaces.update'; id: string; name?: string; folders?: string[]; /** stage F2 (null clears) */ instructions?: string | null; sessionsScope?: 'project' | null; permissionMode?: PermissionMode | null }
  | { kind: 'sessions.meta' }
  | { kind: 'session.setMeta'; sessionId: string; patch: SessionMeta }
  | { kind: 'schedules.list' }
  | { kind: 'schedules.upsert'; schedule: Partial<Schedule> }
  | { kind: 'schedules.remove'; id: string }
  | { kind: 'schedules.runNow'; id: string }
  | { kind: 'limits.get'; force?: boolean }
  | { kind: 'engine.info' }
  | { kind: 'engine.cli'; args: string[]; cwd?: string }
  | { kind: 'providers.list' }
  | { kind: 'providers.upsert'; provider: Partial<Provider> & { id?: string } }
  | { kind: 'providers.remove'; id: string }
  | { kind: 'providers.probe'; id?: string; provider?: Partial<Provider>; listOnly?: boolean } // saved profile by id, or an unsaved draft; listOnly: the model list, no chat check
  | { kind: 'providers.refreshModels'; ids?: string[] } // pull /v1/models for these (default: every non-gateway) profiles
  | { kind: 'import.scan' } // 从其它工具导入: what other tools on this computer have (no keys)
  | { kind: 'import.run'; keys: string[] } // take the picked items in
  | { kind: 'settings.get' }
  | { kind: 'settings.set'; key: string; value: unknown }
  /** The outbound proxy in use (net/proxy.ts); `refresh` looks at the system again. Set it with settings.set 'network.proxy'. */
  | { kind: 'network.proxy'; refresh?: boolean }
  | { kind: 'sessions.search'; query: string; limit?: number }
  | { kind: 'shell.open'; path: string; app?: 'explorer' | 'reveal' | 'code' | 'cursor' | 'zed' }
  /** the editors 「用 … 打开」 can offer: the ones on PATH (macOS: also the app bundles) → `{ editors: ('code'|'cursor'|'zed')[] }` */
  | { kind: 'shell.editors' }
  /** 更新内容: the newest versions of the app's changelog in `lang` → `{ markdown, version }` */
  | { kind: 'app.changelog'; lang: string }
  /** 生成的文件 across the recent conversations here → `{ items: ArtifactRef[] }` */
  | { kind: 'artifacts.list' }
  /** 本机环境变量: names only → `{ names: string[] }`; a value only on `env.reveal` → `{ value }`; `env.set` with
   *  `value: null` removes. In every conversation / terminal started here, under 供应商's own variables */
  | { kind: 'env.list' }
  | { kind: 'env.set'; name: string; value: string | null }
  | { kind: 'env.reveal'; name: string }
  /** the user's custom.css (appearance/custom-css.ts): its text, and making it with the template */
  | { kind: 'ui.customCss' }
  | { kind: 'ui.customCss.create' }
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
  | { kind: 'config.mcp.get'; name: string; cwd?: string }
  /** from: a row's key → the key it had when the form opened (so a masked value follows a renamed row) */
  | { kind: 'config.mcp.update'; name: string; json: string; cwd?: string; from?: Record<string, string> }
  | { kind: 'config.auth'; force?: boolean }
  | { kind: 'config.settings.read'; scope: 'user' | 'project' | 'local'; cwd?: string }
  | { kind: 'config.settings.write'; scope: 'user' | 'project' | 'local'; cwd?: string; json: string }
  | { kind: 'config.skills' }
  | { kind: 'config.agents' }
  | { kind: 'config.hooks' }
  | { kind: 'config.doctor' }
  /** → CompactSource (user level, no sessionId: not routed to a peer) */
  | { kind: 'config.compactSource' }
  | { kind: 'usage.session'; sessionId: string }
  | { kind: 'usage.global'; days?: number }
  | { kind: 'files.changed'; sessionId: string }
  | { kind: 'files.diff'; sessionId: string; path: string }
  | { kind: 'fs.list'; path: string }
  | { kind: 'fs.read'; path: string }
  // `fallback`: the page has its own folder browser — answer `{ unavailable }` instead of a silent null when no native
  // dialog can be shown to this client (issue #12: Linux without zenity / a display, a browser on another machine)
  | { kind: 'fs.pickDir'; fallback?: boolean }
  | { kind: 'fs.dirs'; path?: string }
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
  /** run a chat code block on this computer (the user confirmed; a window on this machine only) */
  | { kind: 'code.run'; lang: string; code: string; cwd?: string; sessionId?: string }
  | { kind: 'mcp.registry'; query: string; limit?: number }
  | { kind: 'mcp.health'; cwd?: string }
  | { kind: 'secrets.status' }
  | { kind: 'secrets.migrate' } // re-protect every provider key with the platform scheme
  | { kind: 'ledger.list'; days?: number; sessionId?: string }
  | { kind: 'ledger.export'; days?: number } // CSV path
  | { kind: 'schedules.history'; id?: string; limit?: number }
  | { kind: 'schedules.templates' }
  | { kind: 'remote.status' }
  /** `keepAwake` is the setting remote.keepAwake; the listener restarts only for enabled / port. */
  | { kind: 'remote.set'; enabled?: boolean; port?: number; keepAwake?: boolean }
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
  | { kind: 'remote.hosts.test'; target: string; sshPort?: number; identityFile?: string; remotePort?: number }
  // stage E5: WSL (local only; install runs only the shown command after the user said yes)
  | { kind: 'wsl.list' }
  | { kind: 'wsl.check'; distro: string }
  | { kind: 'wsl.installCommand' }
  | { kind: 'wsl.install'; distro: string; confirmed: true }
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
  /** PR 监控条: the newest pull request whose head is this folder's branch → `{ pr?: BranchPr; why?: string }` */
  | { kind: 'vcs.prForBranch'; cwd: string }
  /** squash-merge on its own once the checks pass (GitHub auto-merge; the repository must allow it) */
  | { kind: 'vcs.autoMerge'; cwd: string; prId: string; on: boolean }
  // stage E: PR / MR comments, GitLab job logs, forge tokens (host names only on the wire, never a token value back)
  | { kind: 'vcs.prComments'; cwd: string; number: number; base?: string }
  | { kind: 'vcs.replyComment'; cwd: string; number: number; comment: PrCommentRef; body: string }
  | { kind: 'vcs.resolveComment'; cwd: string; number: number; comment: PrCommentRef }
  | { kind: 'vcs.failureLog'; cwd: string; jobId: number }
  /** PR 监控条: the window that does a conversation's automatic actions (fix E-I3); release = its bar left the screen */
  | { kind: 'vcs.autoLease'; sessionId: string; holder: string; release?: boolean }
  | { kind: 'vcs.tokens.list' }
  | { kind: 'vcs.tokens.set'; host: string; token: string | null }
  | { kind: 'vcs.create'; cwd: string; repo?: string; title: string; body?: string; isPr?: boolean; head?: string; base?: string; draft?: boolean; labels?: string[] }
  | { kind: 'vcs.checkout'; cwd: string; repo?: string; number: number; worktree?: boolean }
  | { kind: 'goals.list' }
  | { kind: 'goals.create'; objective: string; spec?: string; cwd: string; maxTurns?: number; tokenBudget?: number | null; permissionMode?: string; model?: string }
  | { kind: 'goals.update'; id: string; patch: Partial<Pick<Goal, 'objective' | 'spec' | 'maxTurns' | 'tokenBudget' | 'cwd' | 'permissionMode' | 'model'>> }
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
  | { kind: 'terminal.open'; cwd: string; cols: number; rows: number; wsl?: { distro: string } }
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
  // ---- 联网 (server/src/web): the settings live in settings.set `web.mcp` / `web.search.engine` / `web.search.braveKey` /
  // `web.search.braveKey` (keys come back masked) / `web.browser.isolated` ----
  /** This window hosts the built-in browser (a desktop window only: refused from a phone or another machine). The most recent one gets the commands. */
  | { kind: 'browser.host'; on: boolean }
  /** The answer to a `browser.command` event, from the window it was sent to. */
  | { kind: 'browser.result'; id: string; ok: boolean; answer?: BrowserAnswer; error?: string }
  | { kind: 'web.status' }
  /** Look for ego lite again (PATH re-read from the registry first) → WebStatus. */
  | { kind: 'web.egoDetect' }
  /** 允许的网站: one entry off the list, and its 完全放开 mark (on the server's write queue) → { sites, auto } as they are now. */
  | { kind: 'web.allowedSites.remove'; host: string }
  /** One search with the configured engine → WebSearchAnswer. */
  | { kind: 'web.search'; query: string; count?: number }
  // ---- privacy pipeline (privacy/service.ts) ----
  | PrivacyRequest
  // ---- sync (spec 2026-10-26 §8) ----
  | SyncRequest
  // ---- orchestration ----
  | OrchestraRequest
  // ---- 后台: running sub-agents / workflows / commands ----
  | BackgroundRequest
  // ---- 网吧: the character library ----
  | CharactersRequest
  // ---- 字符画主题: the user's own themes (themes/service.ts) ----
  /** saved themes → ThemeSource[] (usable ones only) */
  | { kind: 'themes.list' }
  | { kind: 'themes.delete'; id: string }
  /** this window runs the theme skill's trial runs (`themes.trial` events) */
  | { kind: 'themes.trialHost'; on: boolean }
  /** the answer to a `themes.trial` event */
  | { kind: 'themes.trialResult'; id: string; png?: string; errors: string[]; avgMs?: number; maxMs?: number; note?: string }

  // ---- cross-machine sessions (federation) ----
  | PeerRequest
  // ---- stage F: local versions of claude.ai features ----
  | CloudRequest;

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
  /** 隐私保护's settings or counters changed (at most once a second): the privacy center shows this */
  | { kind: 'privacy.changed'; status: PrivacyStatus }
  /** conversations whose record changed on disk (a CLI in a terminal): an open one that is not running here re-reads it */
  | { kind: 'transcripts.changed'; sessionIds: string[] }
  /** ~/.claude-web/custom.css was written / made / removed: windows read it again (ui.customCss) */
  | { kind: 'customCss.changed' }
  /** a saved character theme was added / changed / removed: windows ask again (themes.list) */
  | { kind: 'themes.changed' }
  /** run this theme draft for the skill and answer with themes.trialResult (to one window) */
  | { kind: 'themes.trial'; id: string; source: { id: string; json: string; backdrop?: string; css?: string } }
  | { kind: 'meta.changed' }
  /** something the server did on its own that the user should hear about (a scheduled catch-up run); `notify`: also the OS */
  | { kind: 'notice'; text: string; notify?: boolean; sessionId?: string }
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
  // a library mutation (join / leave / rename / archive / delete / fork) — refetch sessions.list
  | { kind: 'library.changed' }
  /** Sent to one connection only: the window that announced `browser.host`. */
  | { kind: 'browser.command'; command: BrowserCommand }
  /** `web.status` would answer differently now (a host came or went, a setting changed). */
  | { kind: 'web.changed' }
  | PeerEvent
  | OrchestraEvent
  | BackgroundEvent
  | CharactersEvent;

// ---------- phase 3: files / search / git ----------
export interface FsEntry { name: string; dir: boolean; size?: number; mtime?: number; symlink?: boolean }
export interface FsStat { path: string; dir: boolean; size: number; mtime: number; binary?: boolean }
/** `fs.pickDir` with `fallback`: the chosen folder, null when cancelled, or why no native dialog can be shown. */
export type PickDirResult = string | null | { unavailable: 'remote' | 'no-display' | 'no-dialog' };
/** One folder for the page's folder browser: its subfolders (names), its parent (null at a root), the roots to jump to. */
export interface FsDirs { path: string; parent: string | null; dirs: string[]; roots: string[]; home: string; sep: string }
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
export interface SecretsStatus { scheme: 'dpapi' | 'keychain' | 'libsecret' | 'plain'; total: number; protected: number }
/** One model call as seen from the runner (per `result` / assistant message). */
export interface LedgerEntry { ts: number; sessionId: string; model: string; durationMs: number; apiMs?: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; ok: boolean; error?: string; turns?: number; providerId?: string; /** cost not known (a model the price table does not know): costUsd is 0 but must not read as $0 */ costUnknown?: boolean }
export interface ScheduleRun { id: string; scheduleId: string; at: number; sessionId?: string; ok: boolean; durationMs?: number; summary?: string; error?: string; /** run for a time missed while the app was closed / asleep */ catchUp?: boolean }

export type WireDown = { type: 'reply'; reply: ReplyEnvelope } | { type: 'event'; event: ServerEvent };
export type WireUp = { type: 'request'; request: RequestEnvelope };

export * from './privacy/types.js';
import type { PrivacyRequest, PrivacyStatus } from './privacy/types.js';
export type * from './sync/types.js';
import type { SyncRequest } from './sync/types.js';

// ---- stage F: local versions of claude.ai features (handoff, project page, dispatch, claude.ai import, publish) ----
export type DispatchFrom = 'phone' | 'im' | 'app';
export interface ProjectFile { name: string; size: number; mtime: number }
/** 交给常开机器继续: what went where (the conversation here is read-only from then on) */
export interface HandoffInfo { id: string; peerId: string; peerName: string; remote: string; branch: string; commit: string; base: string; remoteSessionId?: string; at: number; /** local branches 取回 made */ fetched?: string[] }
export interface HandoffFrom { id: string; from: string; branch: string; url: string; cwd: string; at: number }
export type PublishExpiry = '1d' | '7d' | 'never';
export interface PublishedItem { id: string; name: string; source: string; entry: string; createdAt: number; updatedAt: number; expiresAt: number | null; files: number; bytes: number; peerId?: string; peerName?: string; url?: string; /** 撤回待完成: the peer could not be told yet; retried when it is back */ revokePending?: boolean }
export interface ClaudeAiScan { conversations: number; projects: number; docs: number; add: number; update: number; same: number; skipped: number; user?: string }
export interface ClaudeAiImportResult extends ClaudeAiScan { projectsCreated: number; projectsUpdated: number; filesWritten: number; filesKept: number; /** projects whose instructions were cut to the 20 000-character limit */ instructionsShortened?: number }
export type CloudRequest =
  | { kind: 'projects.files.list'; workspaceId: string }
  | { kind: 'projects.files.remove'; workspaceId: string; name: string }
  | { kind: 'dispatch.start'; prompt: string; peer?: string; workspaceId?: string; from?: DispatchFrom }
  | { kind: 'dispatch.defaults'; peer?: string }
  | { kind: 'handoff.check'; sessionId: string }
  | { kind: 'handoff.start'; sessionId: string; peerId: string; prompt?: string; /** carry new untracked files too (key / credential files never) */ includeUntracked?: boolean }
  | { kind: 'handoff.receive'; id: string; url: string; branch: string; title?: string; events: unknown[]; permissionMode?: PermissionMode; prompt?: string; from: string }
  | { kind: 'handoff.publish'; branch: string }
  | { kind: 'handoff.fetchBack'; sessionId: string }
  | { kind: 'publish.create'; path: string; expiry: PublishExpiry; id?: string }
  | { kind: 'publish.list' }
  | { kind: 'publish.revoke'; id: string }
  | { kind: 'publish.toPeer'; path: string; expiry: PublishExpiry; peerId: string }
  | { kind: 'publish.receive'; name: string; entry: string; source: string; expiry: PublishExpiry; files: { rel: string; data: string }[] }
  | { kind: 'publish.inline'; path: string }
  | { kind: 'publish.files'; path: string }
  | { kind: 'claudeai.scan'; path: string }
  | { kind: 'claudeai.import'; path: string; folder?: string };
