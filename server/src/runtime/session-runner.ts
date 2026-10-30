import { query, type Query, type SDKMessage, type SDKUserMessage, type Options, type PermissionResult, type McpServerConfig, type HookCallback, type HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { nodegraphHintPrompt } from './nodegraph-hint.js';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { withExplanation } from '../errors/explain.js';
import { spawnWsl } from '../wsl/spawn.js';
import { rewriteMcpForWsl, type StdioServer } from '../wsl/launch.js';
import { toWslPath } from '../wsl/paths.js';
import { wslService } from '../wsl/service.js';
import { addTranscriptRoot, dropEmptyBlocks, findClaudeTranscript, hasClaudeTranscript, hasEntry, lastCostState, lastHumanPrompt, repairLeaf } from './transcript-file.js';
import { compactCap, ownAnthropicBase, ownOverride, settingsOverride, userAnthropicEnv } from './user-env.js';
import { providerKey, splitSupport, subAlias, subagentTarget, unalias, type SplitKind, type SubagentPick } from '../models/subagent.js';
import { splitEndpoint, splitTarget, type SplitSub } from '../gateway/split.js';
import { desktopSkillsPlugin } from './desktop-skills.js';
import { writeFlagSettings, type FlagSettings } from './flag-settings.js';
import { resolveEngine, spawnClaude } from '../claude-exe.js';
import { loopbackNoProxy, providerEnv, type SessionProvider } from '../providers/service.js';
import { privacyRoute } from '../privacy/route.js';
import { ENGINE_DEFAULT_WINDOW, ONE_M, contextWindowFor, contextWindowsEnv, isClaudeModel, officialWindow } from '../models/context-window.js';
import { ccbAccountEnv, ccbMisthinks, ccbModel, isChatModel, modelCaps, modelLabel, modelsFor, preferredRuntime, providerModelId, supportsUltracode, webCapsEnv } from '../models/catalog.js';
import { turnShare, type RunningTotals } from '../usage/turn-cost.js';
import { claudeMcpServer } from '../memory/launcher.js';
import { webAllowedTools, webClaudeMcpServer, webMcpEnabled } from '../web/launcher.js';
import { cafePluginDir } from '../characters/tools.js';
import { asciiPluginDir } from '../themes/tools.js';
import { computerAllowedTools, computerClaudeMcpServer } from '../computer/launcher.js';
import { ENGINE_SEARCH_TOOL, engineSearchOff, userPickedSearchAdapter } from '../web/engine-search.js';
import { markUnknownCost } from '../usage/pricing.js';
import type { AttachmentRef, EffortLevel, ModelInfo, OpenSessionParams, PermissionMode, PermissionRequestEvent, PermissionResponse, Provider, RunnerState, SessionFeatures, SessionInfoSnapshot, SideTurn } from '../protocol.js';
import type { ToolGate } from '../agents/types.js';
import { killTree } from '../agents/kill-tree.js';
import { getLocale, tr } from '../i18n/index.js';
import { thinkingLanguageFor, thinkingLanguagePrompt } from './thinking-language.js';
import { subagentPolicyPrompt } from './subagent-policy.js';
import { accountModel, accountWindowOf, compactAtOk, effectiveCompact, familyWindows, type AccountWindows } from '../models/account-window.js';
import { localEnv } from './local-env.js';
import { SESSIONS_ALLOWED, SESSIONS_SERVER, sessionsMcpEnabled, sessionsMcpServer } from '../sessions-mcp/tools.js';
import { PREVIEW_ALLOWED, PREVIEW_SERVER, previewEnabled, previewMcpServer, verifyInstructions } from '../preview/tools.js';

/** A conversation above this share of the next model's window is compacted before the switch. */
const FIT_SHARE = 0.8;
/** the official binary's lowest CLAUDE_CODE_AUTO_COMPACT_WINDOW (it reads a smaller one as this: phase 27, measured) */
const OFFICIAL_COMPACT_FLOOR = 100_000;

const esc = (s: string) => s.replace(/"/g, '&quot;');

/** The last lines the CLI wrote to stderr, for an error message (noise left out). */
export function cliSaid(stderr: string): string {
  return stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^Warning: no stdin data/i.test(l)).slice(-3).join(' · ').slice(-400);
}

/**
 * Whether Claude Code has a transcript for this id, in any project folder. It writes the JSONL with the first
 * message, not at start: a conversation that never ran a turn (switched to another provider before the first
 * message, reaped while idle) cannot be `--resume`d — "No conversation found with session ID" — and has to be
 * started anew on the same id (user report 2026-10-01).
 */
export { hasClaudeTranscript };

/** What missingCwd's two messages call the folder, in each language (sendRefused tells them from other reasons by it). */
const CWD_WORDS = [tr('项目文件夹'), 'project folder'];

/**
 * A conversation whose folder is gone (moved, renamed, deleted, a drive not mounted): Windows reports the spawn as
 * ENOENT on the executable and the SDK words it "Claude Code executable at … exists but failed to launch" — say what it is.
 */
export function missingCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  try {
    if (statSync(cwd).isDirectory()) return undefined;
    return tr('对话的项目文件夹不是一个文件夹：{cwd}。在输入框左下角换一个项目文件夹，新开对话。', { cwd });
  } catch {
    return tr('找不到这个对话的项目文件夹：{cwd}（可能被移动、改名或删除了）。在输入框左下角换一个存在的项目文件夹，新开对话；或者把文件夹放回原处。', { cwd });
  }
}

/** Why a message was not taken (shown as the window's toast and on the conversation): the reason the process died, and what to do. */
export function sendRefused(failed: boolean, reason?: string): string {
  if (!failed) return tr('这个对话的进程已经关闭。再发一次会重新打开它。');
  // the folder is gone: the provider is fine, and resending fails the same way (missingCwd says what to do)
  if (reason && CWD_WORDS.some((w) => reason.includes(w))) return tr('这个对话的进程没能启动：{reason}', { reason });
  // the reason is explained already (withExplanation: a Chinese line, then the original), so the advice goes after it
  return tr("这个对话的进程出错退出了{v}\n再发一次会重新打开它；还是不行的话，到 设置 → 供应商 点「测试连接」看看。", { v: reason ? `：${reason}` : '。' });
}

/** Unbounded async queue used as the SDK's streaming-input prompt. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;
  push(m: SDKUserMessage) {
    if (this.closed) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: m, done: false });
    } else this.items.push(m);
  }
  close() {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as never, done: true });
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => (this.waiter = res));
      },
    };
  }
}

interface PendingPermission {
  event: PermissionRequestEvent;
  resolve: (r: PermissionResult) => void;
}

let promptSuggestionsOn = true;
/** Settings → 下一句提示 (`ui.promptSuggestions`); a query started from now on asks for them or not. */
export function setPromptSuggestions(on: boolean) { promptSuggestionsOn = on; }
let nodegraphHintOn = true;
/** spec D4: the ```nodegraph hint in the appended system prompt (setting ui.nodegraphHint); read when a process starts. */
export function setNodegraphHint(on: boolean): void { nodegraphHintOn = on; }

let thinkingLanguageSetting: unknown = '';
/** Settings → 思考用的语言 (`ai.thinkingLanguage`); conversations pick it up through refreshThinkingLanguage(). */
export function setThinkingLanguageSetting(v: unknown) { thinkingLanguageSetting = v; }

/** The own Claude login's 200K / 1M picks per family and its 自动压缩 point (A7; settings claude.contextWindows / claude.compactAt). */
export interface AccountPrefs { windows: AccountWindows; compactAt?: number }

export interface RunnerEvents {
  message: (m: SDKMessage) => void;
  state: (s: RunnerState, error?: string) => void;
  info: (i: SessionInfoSnapshot) => void;
  permission: (e: PermissionRequestEvent) => void;
  permissionResolved: (requestId: string) => void;
}

/**
 * One live Claude Code process bound to one session id. Lives across turns via streaming input.
 * Re-spawns itself (with resume) when the model changes, since model is fixed per process
 * unless the CLI supports setModel (it does; we use it and fall back to respawn on failure).
 */
/** What the account path reads instead of the user's own Anthropic env, for another Claude account. */
const NO_RELAY: ReturnType<typeof userAnthropicEnv> = { env: {}, relay: false };

/**
 * A gated conversation's PreToolUse hook: the CLI's own hook timeout is short, and a hook that times out is a
 * non-blocking error — the call would fall through to the normal permissions (fail open). So the matcher gets a
 * generous timeout, and the gate is cut off before it (GATE_DEADLINE_MS): the hook always answers, with a refusal.
 */
export const GATE_HOOK_TIMEOUT_S = 600;
export const GATE_DEADLINE_MS = (GATE_HOOK_TIMEOUT_S - 10) * 1000;
/** the gate's answer, or a refusal once `signal` aborts or GATE_DEADLINE_MS passes (a late answer is dropped) */
function untilAbortOrDeadline(answer: Promise<PermissionResult>, signal?: AbortSignal): Promise<PermissionResult> {
  if (signal?.aborted) return Promise.resolve({ behavior: 'deny', message: 'cancelled' });
  return new Promise((resolve) => {
    const done = (r: PermissionResult) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(r); };
    const onAbort = () => done({ behavior: 'deny', message: 'cancelled' });
    const timer = setTimeout(() => done({ behavior: 'deny', message: tr('策略检查太久没有回答，这一步没有执行') }), GATE_DEADLINE_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    answer.then(done, () => done({ behavior: 'deny', message: tr('没有人在看这个对话，这一步没法批准，没有执行') }));
  });
}

/**
 * The tool set a sidecar-backed conversation gets (Gemini web / WorkBuddy). Those upstreams take the tool schemas
 * as text inside the prompt, so every extra tool costs latency and can push a turn over the sidecar's 128 KB
 * attachment limit. These six cover reading, searching, editing and running commands — the core of a coding turn.
 */
const LEAN_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'TodoWrite'];

export class SessionRunner extends EventEmitter {
  readonly id: string; // sessionId (known up front for resume; assigned from init otherwise)
  sessionId: string;
  state: RunnerState = 'starting';
  cwd: string;
  private q: Query | null = null;
  private input = new InputQueue();
  private abort = new AbortController();
  private pending = new Map<string, PendingPermission>();
  /** the tools this query runs without asking (Options.allowedTools): ccb asks for them wrapped, see onCanUseTool */
  private preAllowed = new Set<string>();
  /** 值班 Bot: answers a tool's permission before the card (null / a throw = the card as usual); see AgentDriver.gate */
  gate?: ToolGate;
  /**
   * OpenSessionParams.gated: every tool call is answered by `gate` in a PreToolUse hook — canUseTool is skipped for
   * settings allow rules, acceptEdits / bypassPermissions and allowedTools, so it alone let a bot `git push` unseen
   */
  readonly gated: boolean;
  /** OpenSessionParams.botId (only with gated): the memory MCP server gets that bot's own scope */
  private readonly botId?: string;
  /** what the hook answered per tool_use_id: canUseTool reached for the same call reuses it (one gate run, one audit row) */
  private hookAnswers = new Map<string, PermissionResult>();
  private history: SDKMessage[] = []; // messages since spawn, replayed to late-joining clients
  info: SessionInfoSnapshot;
  private model?: string;
  private effort?: EffortLevel;
  private permissionMode: PermissionMode;
  private provider?: SessionProvider; // resolved third-party profile (undefined = claude.ai login)
  /**
   * Another Claude account (a `claude-account` profile, settings → 账号与登录): the claude.ai-login path — the CLI's
   * own models, aliases, effort levels and windows — with that account's token instead of the ~/.claude login.
   */
  private account?: SessionProvider;
  /** prompt-cache route key: this session's id (a fork keeps its parent's, whose prefix it shares) */
  private cacheKey: string;
  /** the id the shim's ledger rows go under; unset for an SDK fork, whose id only arrives at init */
  private ledgerId?: string;
  private features: SessionFeatures;
  lastActivity = Date.now();
  private closed = false;
  /** CLI flags from open (features / worktree), re-applied when the process is respawned */
  private extraArgs: Record<string, string | null> = {};
  /** the CLI has (or is about to write) a transcript for this id: a respawn resumes instead of starting anew */
  private hasTranscript = false;
  /** `plan().key` of the running process: a model / effort change that needs another one restarts it */
  private planKey = '';
  /** a restart asked for during a turn: done when that turn's result arrives */
  private respawnPending = false;
  /** the next start takes empty blocks out of the transcript first (dropEmptyBlocks): set by that 400 and by a model switch */
  private repairEmptyBlocks = false;
  /** …and every thinking block with them: the API refused a signature */
  private repairUnsigned = false;
  /** the CLI's running totals (`total_cost_usd` / `modelUsage` are cumulative per process): each result is turned into its own turn's share */
  private totals: RunningTotals = { cost: 0, models: {} };
  /** the CLI process of `q`, and the end of what it wrote to stderr */
  private child: ChildProcess | null = null;
  /** the prompts this conversation's processes were given (and the last one on disk when one started): any other is a turn from elsewhere */
  private known = new Set<string>();
  private stderrTail = '';
  /** the `--settings` file of the process about to be spawned (removed when that process ends) */
  private nextFlag: FlagSettings | null = null;
  /** official binary, 深度编排 picked before the start: `/effort ultracode` goes before the first message */
  private ultracodeFirst = false;
  /** the model subagents run on ('' = the main model): `CLAUDE_CODE_SUBAGENT_MODEL`, read once at start */
  private subagent = '';
  /** the model this process's subagents really run on (forced by the variable; real name, not the alias), '' = none */
  private subRuns = '';
  /** 思考用的语言 of this conversation (SessionMeta.thinkingLanguage: '' = the setting) */
  private ownThinkingLanguage = '';
  /** the thinking-language section the running process was started with ('' = none) */
  private thinkingSection = '';
  /**
   * The own claude.ai login's picks (settings claude.contextWindows / claude.compactAt, given by the pool): which
   * families run at 1M (`[1m]`) and where to compact. Another Claude account reads its own profile's instead.
   */
  private accountPrefs: AccountPrefs = { windows: {} };
  /**
   * a change of those (or of another Claude account's profile: reprovide) that shrinks the window, made mid-turn:
   * applied (compaction first) when the turn is over
   */
  private deferredChange: (() => Promise<void>) | null = null;
  /** bumped by each setAccountPrefs / claude-account reprovide: an older one still waiting for its compaction gives way */
  private prefsSeq = 0;

  /** the project's extra folders (stage C2), read once when the conversation opens: the SDK's additionalDirectories (a respawn keeps them) */
  private extraDirs: string[];
  /** stage E5: running inside this WSL distro (its own claude, its own login) */
  private wsl: { distro: string } | null;

  /** 项目页 (stage F2): the project's instructions, read once when the conversation opens (a respawn keeps them) */
  private projectInstructions = '';
  /** IM / a scheduled task / the orchestra drives this run: its replies are read elsewhere first — no ```nodegraph hint */
  private drivenBy: OpenSessionParams['drivenBy'];
  constructor(params: OpenSessionParams, provider?: SessionProvider, opts: { thinkingLanguage?: string; account?: AccountPrefs; additionalDirectories?: string[]; projectInstructions?: string } = {}) {
    super();
    this.projectInstructions = opts.projectInstructions ?? '';
    this.extraDirs = (opts.additionalDirectories ?? []).filter((d) => typeof d === 'string' && !!d);
    this.wsl = params.env?.kind === 'wsl' ? { distro: params.env.distro } : null;
    this.ownThinkingLanguage = opts.thinkingLanguage ?? '';
    if (opts.account) this.accountPrefs = { windows: familyWindows(opts.account.windows), ...(opts.account.compactAt !== undefined ? { compactAt: opts.account.compactAt } : {}) };
    this.cwd = params.cwd;
    if (provider?.type === 'claude-account') this.account = provider;
    else this.provider = provider;
    this.features = params.features ?? {};
    this.drivenBy = params.drivenBy;
    this.gated = !!params.gated;
    this.botId = this.gated && typeof params.botId === 'string' && params.botId ? params.botId : undefined;
    // a fork gets its own id from the CLI at init; until then use a placeholder so the pool
    // never clobbers the source session's runner
    const isFork = !!params.sessionId && (params.fork || !!params.resumeAt);
    this.sessionId = params.sessionId && !isFork ? params.sessionId : randomUUID();
    this.id = this.sessionId;
    this.cacheKey = params.cacheParentId ?? params.sessionId ?? this.sessionId;
    this.ledgerId = isFork ? undefined : this.sessionId;
    this.model = params.model || provider?.defaultModel || undefined;
    this.effort = params.effort;
    this.permissionMode = params.permissionMode ?? 'default';
    // in WSL (NAT) this computer's gateway is not at 127.0.0.1: subagents stay on the main model
    this.subagent = this.wsl ? '' : params.subagentModel ?? '';
    this.info = { sessionId: this.sessionId, state: 'starting', cwd: this.cwd, model: this.model, effort: this.effort, permissionMode: this.permissionMode, providerId: provider?.id, providerName: provider?.name, features: this.features, agent: 'claude', ...(this.wsl ? { wsl: { distro: this.wsl.distro, dropped: [] } } : {}) };
    if (this.subagent) this.info.subagentModel = this.subagent;
    // 深度编排 picked before the conversation started (welcome page, a reopen): our engine starts with --ultracode; the
    // official binary only has `/effort ultracode` inside the conversation — sent just before the first message (at
    // open it would make a conversation of its own, titled after the command, even if nothing is ever sent)
    if (params.ultracode) {
      this.info.ultracode = true;
      if (this.plan().engine.kind !== 'ccb') this.ultracodeFirst = true;
    }
    // Handover from another agent: Claude has no JSONL for this id, so feed it synthesized entries
    // through the documented SessionStore hook — the SDK materializes them to a temp transcript the
    // subprocess resumes from natively. `persistSession: false` is incompatible with sessionStore.
    // Only the official binary has that hook: the SDK passes `--session-mirror`, and ccb 2.8.4 exits "unknown option"
    // (every hand-over back to Claude on ccb failed, 2026-10-01) — there it is like the other agents: its own transcript
    // (if the conversation began as Claude) or a new one on the id, and the briefing as the first message.
    const mirror = !!params.resumeEntries?.length && this.plan().engine.kind === 'claude';
    const briefFirst = !!params.resumeEntries?.length && !mirror ? params.briefing : undefined;
    // an id that never ran a turn has nothing to resume: start a new conversation on the same id
    this.hasTranscript = !!params.sessionId && (isFork || mirror || hasClaudeTranscript(params.sessionId));
    const extra: Partial<Options> = this.hasTranscript ? { resume: params.sessionId, forkSession: isFork, resumeSessionAt: params.resumeAt } : { sessionId: this.sessionId };
    if (mirror && params.resumeEntries) {
      const entries = params.resumeEntries;
      extra.resume = this.sessionId;
      extra.forkSession = false;
      extra.sessionStore = {
        append: async () => { /* the local JSONL is already the durable copy */ },
        load: async () => entries as never,
      } as Options['sessionStore'];
    }
    extra.extraArgs = { ...this.featureArgs() };
    if (params.worktree) extra.extraArgs.worktree = params.worktree;
    this.extraArgs = extra.extraArgs;
    this.start(extra);
    if (briefFirst) this.send(briefFirst, undefined, false, randomUUID());
  }

  /** Map SessionFeatures to CLI flags (`--flag` = null, `--flag value` = string). */
  private featureArgs(): Record<string, string | null> {
    const f = this.features;
    const a: Record<string, string | null> = {};
    if (f.chrome) a.chrome = null;
    // (`computerUse` is not a flag: the engine's `--computer-use-mcp` only starts its stand-alone MCP mode, whose
    // tools answer "not wired to a session", and a conversation given it exits before its first message — probed
    // 2026-10-10. 操控电脑 is our own `computer` MCP server instead: see `mcpServers` below.)
    if (f.proactive) a.proactive = null;
    if (f.brief) a.brief = null;
    if (f.channels?.length) a.channels = f.channels.join(',');
    if (f.devChannels) a['dangerously-load-development-channels'] = null;
    return a;
  }

  private featureEnv(): Record<string, string> {
    const f = this.features;
    const routed = this.provider ?? this.account;
    // 本机环境变量 lowest: 供应商's variables and the session's own win over them (local-env.ts keeps routing names out)
    const env: Record<string, string> = { ...localEnv(), ...(routed ? providerEnv(routed, 'claude', { sessionKey: this.cacheKey, sessionId: this.ledgerId }) : {}), ...(f.env ?? {}) };
    if (f.coordinator) env.CLAUDE_CODE_COORDINATOR_MODE = '1';
    return env;
  }

  /**
   * Subagents on a model this conversation's own provider does not serve: the engine's base URL for its request format
   * becomes the gateway's split route, which passes the conversation's requests on to where they were going (with the
   * engine's own credential) and sends the alias's to the picked model. Returns the alias the engine asks for, or null
   * when this pair cannot be joined (models/subagent.ts splitSupport) or the route is not up yet.
   */
  private subagentSplit(pick: SubagentPick, fenv: Record<string, string>): string | null {
    const mainType: SplitKind = this.provider?.type ?? (this.account ? 'claude-account' : 'claude');
    const t = providerKey(pick.providerId) === 'claude' ? { type: 'claude' as const } : splitTarget(pick.providerId);
    if (!t || !splitSupport({ mainType, subType: t.type })) return null;
    const groupId = 'groupId' in t ? t.groupId : undefined;
    if (t.type === 'gateway' && !groupId) return null;
    const sub: SplitSub = t.type === 'claude' ? { kind: 'account' } : t.type === 'claude-account' ? { kind: 'account', token: t.token } : groupId ? { kind: 'gateway', groupId } : { kind: 'provider', providerId: pick.providerId };
    const v = mainType === 'openai' ? 'OPENAI_BASE_URL' : mainType === 'grok' ? 'GROK_BASE_URL' : mainType === 'gemini' ? 'GEMINI_BASE_URL' : 'ANTHROPIC_BASE_URL';
    const defaults: Record<string, string> = { OPENAI_BASE_URL: 'https://api.openai.com/v1', GROK_BASE_URL: 'https://api.x.ai/v1', GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' };
    // the account: claude.ai, or the relay the user set up in their settings files / environment (2026-10-19 user
    // report: Opus 5.5 through their relay, the subagents' DeepSeek ignored) — its requests go on there with the
    // relay's own key, which the engine still sends (start() puts our base URL over theirs with `ownOverride`)
    const mainBase = mainType === 'claude' ? ownAnthropicBase(this.cwd) || defaults.ANTHROPIC_BASE_URL : mainType === 'claude-account' ? defaults.ANTHROPIC_BASE_URL : fenv[v] || defaults[v];
    // this machine's login for the subagents: the engine keeps it (no provider key for it to prefer), the route puts the
    // provider's key on the conversation's own requests
    const rekey = t.type === 'claude' ? this.provider?.apiKey : undefined;
    const base = splitEndpoint({ base: mainBase, ...(rekey !== undefined ? { rekey } : {}) }, sub, pick.model);
    if (!base) return null;
    fenv[v] = base;
    if (rekey !== undefined) { delete fenv.ANTHROPIC_AUTH_TOKEN; delete fenv.ANTHROPIC_API_KEY; }
    return subAlias(pick.model, v === 'ANTHROPIC_BASE_URL' ? 'anthropic' : 'other');
  }

  getHistory() {
    return this.history;
  }
  getPendingPermissions() {
    return [...this.pending.values()].map((p) => p.event);
  }

  private setState(s: RunnerState, error?: string) {
    this.state = s;
    this.info.state = s;
    if (error) this.info.error = error;
    // the reason a conversation's process died is otherwise only in the event (a window that missed it shows nothing, server.log nothing)
    if (s === 'error') console.error(`[session ${this.sessionId.slice(0, 8)}] process failed: ${error ?? '(no message)'}`);
    this.emit('state', s, error);
  }

  /** One model of the picker: its thinking-strength levels and whether they go out natively or through the prompt. */
  private modelEntry(value: string, displayName: string, description: string, reported?: { supportsEffort?: boolean; levels?: EffortLevel[] }): ModelInfo {
    const c = modelCaps(this.provider, value);
    const onOurs = this.info.runtime === 'ccb';
    // the official binary on the account: its own answer (it has no prompt way), as before the engine change
    if (!this.provider && reported && !onOurs) {
      const own = reported.levels?.length ? reported.levels : c.levels;
      const supportsEffort = reported.supportsEffort ?? own.length > 0;
      return { value, displayName, description, supportsEffort, supportedEffortLevels: supportsEffort ? own : [], effortMode: 'native' };
    }
    const levels: EffortLevel[] = reported?.levels?.length && !this.provider ? reported.levels : c.levels;
    // the official binary sends strength only for models it knows itself (our table) and has no prompt way
    const native = onOurs ? c.native : c.native && c.reasoning;
    const supportsEffort = onOurs || native;
    return { value, displayName, description, supportsEffort, supportedEffortLevels: supportsEffort ? levels : [], effortMode: native ? 'native' : 'prompt' };
  }

  /**
   * The engine a process for `model` runs on. A provider's Anthropic-format endpoint and a Claude 5 model ccb gets the
   * thinking wrong for (`ccbMisthinks`) → the official binary — unless this conversation uses a flag only ccb has
   * (the official one refuses `--proactive` as an unknown option); then ccb, with thinking off
   * for that model (`omit thinking` is what the API asks for).
   */
  private plan(model = this.model) {
    const ccbOnly = !!(this.features.proactive || this.features.devChannels);
    // the account through a relay of the user's own (settings.json / environment) is an Anthropic-format relay too;
    // claude.ai itself takes the budget ccb sends (the ledger has Opus 5.5 turns on ccb)
    // another Claude account is claude.ai itself, whatever relay the user's own settings point the ~/.claude login at
    const own = this.provider ? null : this.account ? NO_RELAY : userAnthropicEnv();
    // …and it runs on the official binary: a relay checking the client (super-nb) refuses ccb's requests, and the
    // account has no 测试连接 that could have found that out and pinned it (2026-10-02, real relays)
    const relay = this.provider ?? (own!.relay ? { type: 'anthropic' as const, runtime: ccbOnly ? undefined : ('claude' as const), defaultModel: own!.env.ANTHROPIC_MODEL, modelMap: { opus: own!.env.ANTHROPIC_DEFAULT_OPUS_MODEL, sonnet: own!.env.ANTHROPIC_DEFAULT_SONNET_MODEL, haiku: own!.env.ANTHROPIC_DEFAULT_HAIKU_MODEL } } : undefined);
    // WSL: the distro's own `claude` on its PATH (no extension: the SDK takes it as a native binary; spawnWsl runs it)
    const engine = this.wsl ? { file: 'claude', kind: 'claude' as const } : resolveEngine(relay ? preferredRuntime(relay, ccbOnly ? undefined : model ?? '') : ccbOnly ? undefined : this.account?.runtime);
    const anthropicWire = relay?.type === 'anthropic' || relay?.type === 'gateway';
    const noThinking = engine.kind === 'ccb' && anthropicWire && ccbMisthinks(providerModelId(relay!, model ?? ''));
    // the official binary's earlier compaction is an environment variable, read once at start: a model that needs
    // another one (a window set smaller than the binary assumes) is another process (2026-10-14) — and so is a
    // 自动压缩 point the user set for the provider / the account (A7), on either engine
    const compact = this.compactPoint(engine.kind, model);
    return { engine, noThinking, key: `${engine.kind}${noThinking ? ':no-thinking' : ''}${compact ? `:compact-${compact}` : ''}${this.subagent ? `:sub-${this.subagent}` : ''}` };
  }

  private start(extra: Partial<Options>) {
    if (this.wsl) {
      const d = this.wsl.distro;
      if (toWslPath(this.cwd, d) === null) throw new Error(tr('这个文件夹不在 {d} 里，也不是本机磁盘', { d }));
      const root = wslService()?.projectsRoot(d);
      if (root) addTranscriptRoot(root, d);
    }
    const { engine, noThinking, key } = this.plan();
    this.planKey = key;
    // ultracode on: a restarted claude-web-engine process starts with it (`--ultracode`)
    const args = { ...(extra.extraArgs ?? {}) };
    if (engine.kind === 'ccb' && this.info.ultracode) args.ultracode = null;
    else delete args.ultracode;
    // Claude's thinking as text: the API's `thinking.display` defaults to "omitted" on current Claude models (the
    // blocks come back as a bare signature) — other providers' models showed their thinking and Claude's never did.
    // The official binary takes the flag (for the model the process starts on: a Claude one — an Anthropic-format relay
    // of DeepSeek / Kimi might refuse a field it does not know); ccb would exit on it as an unknown option and reads
    // CLAUDE_WEB_THINKING_DISPLAY instead (below), which it applies per request to Claude models only
    const startModel = this.model || this.provider?.defaultModel || '';
    const claudeStart = !this.provider || !startModel || /claude/i.test(providerModelId(this.provider, startModel));
    if (engine.kind === 'claude' && !noThinking && claudeStart) args['thinking-display'] = 'summarized';
    else delete args['thinking-display'];
    extra = { ...extra, extraArgs: args };
    // the transcript both engines share: the official binary resumes at its last recorded leaf (repair it after turns
    // on ccb) and continues the cost totals it saved; ccb starts every process from zero
    const resumeId = typeof extra.resume === 'string' ? extra.resume : undefined;
    const file = resumeId ? findClaudeTranscript(resumeId) : null;
    // refused for an empty block in the history (a picture sent alone before 2026-10-17, another vendor's blank
    // thinking), or about to go to another model: no process has the file now, take those blocks out (only then — it
    // reads the whole file)
    if (file && this.repairEmptyBlocks) {
      this.repairEmptyBlocks = false;
      // to a Claude model: another vendor's unsigned thinking too (「Invalid `signature` in `thinking` block」 — when
      // the API said so, whatever the model is called)
      const unsigned = this.repairUnsigned || this.toClaude(startModel);
      // the API refused a signature: a signed block it does not accept (another provider's, a relay's) — whose cannot
      // be told from here, so every thinking block goes; only the unsigned ones went before, and 重试 failed the same way
      const allThinking = this.repairUnsigned;
      this.repairUnsigned = false;
      if (dropEmptyBlocks(file, { unsigned, allThinking })) console.warn(`[runner] ${resumeId}: blocks the next model refuses taken out of the transcript`);
    }
    if (engine.kind === 'claude' && resumeId && !extra.forkSession) repairLeaf(file, resumeId);
    const saved = engine.kind === 'claude' && resumeId ? lastCostState(file, resumeId) : null;
    this.totals = saved ? { cost: saved.cost, models: saved.models, ...(saved.apiMs !== undefined ? { apiMs: saved.apiMs } : {}) } : { cost: 0, models: {} };
    const onDisk = lastHumanPrompt(file);
    if (onDisk) this.known.add(onDisk);
    const exe = engine.file;
    this.info.runtime = engine.kind;
    const fenv = this.featureEnv();
    // the subagents' model: one of this conversation's own provider goes to the engine as it is; one of another goes
    // through the gateway's split route (subagentSplit), the engine asking for it by an alias
    const target = subagentTarget(this.subagent, this.provider?.id ?? this.account?.id);
    const sameSub = target?.kind === 'same' ? target.model : undefined;
    const splitAlias = target?.kind === 'cross' ? this.subagentSplit(target.pick, fenv) : null;
    if (target?.kind === 'cross' && !splitAlias) console.warn(`[session ${this.sessionId.slice(0, 8)}] subagents stay on the main model: ${target.pick.providerId} / ${target.pick.model} cannot be reached from this conversation`);
    // 隐私保护 on, this machine's own login (claude.ai, or the relay in the user's settings files): through the privacy
    // relay to where it was going — unless the split route already took the base (it redacts on its own)
    const privacyOwn = !this.provider && !this.account && !splitAlias ? privacyRoute(ownAnthropicBase(this.cwd) || 'https://api.anthropic.com') : null;
    if (privacyOwn) fenv.ANTHROPIC_BASE_URL = privacyOwn;
    if (noThinking && !('CLAUDE_CODE_DISABLE_THINKING' in fenv)) fenv.CLAUDE_CODE_DISABLE_THINKING = '1';
    if (engine.kind === 'ccb' && !('CLAUDE_WEB_THINKING_DISPLAY' in fenv) && !process.env.CLAUDE_WEB_THINKING_DISPLAY) fenv.CLAUDE_WEB_THINKING_DISPLAY = 'summarized';
    // what each of the provider's models can do with thinking strength (claude-web-engine reads it: levels, whether it
    // reasons, models recorded as refusing the native parameter); the official binary ignores it
    if (engine.kind === 'ccb' && this.provider) {
      fenv.CLAUDE_WEB_MODEL_CAPS = webCapsEnv(this.provider, [...(this.provider.models ?? []), providerModelId(this.provider, this.model), ...(sameSub ? [providerModelId(this.provider, sameSub)] : [])]);
    }
    // each model's context window (2026-10-14: a relay's Claude compacted at 175K): claude-web-engine takes the whole
    // table (a model switched to mid-conversation keeps its own); the official binary only knows `[1m]` (engineModel)
    // and an earlier compaction for this model
    if (this.provider) {
      const windows = engine.kind === 'ccb' ? contextWindowsEnv(this.provider, [...(this.provider.models ?? []), ...Object.values(this.provider.modelMap ?? {}), this.provider.defaultModel, providerModelId(this.provider, this.model), ...(sameSub ? [providerModelId(this.provider, sameSub)] : [])]) : undefined;
      if (windows && !('CLAUDE_WEB_CONTEXT_WINDOWS' in fenv)) fenv.CLAUDE_WEB_CONTEXT_WINDOWS = windows;
    }
    // where to compact: the official binary's earlier point for a window smaller than it assumes (a provider's), and a
    // 自动压缩 point the user set for the provider / the account (A7) — the smaller one. The user's own value is theirs
    // to decide, over 本机环境变量 / the session's env; the binary's computed one, as before, gives way to those
    const compact = this.compactPoint(engine.kind, this.model);
    const userCompact = this.userCompact(this.model) !== undefined;
    if (compact && (userCompact || !('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in fenv))) fenv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(compact);
    // the cap the engine will put on the window (both engines take it): the composer's ring and the folded context card
    // divide by min(window, this) as the card's body (the engine's count) does (2026-10-24 review I3: 58 % against 82 %)
    // — a point the user set on the own login goes over settings.json through --settings too (`ownOverride` below)
    const cap = compactCap(fenv, this.cwd, !!(this.provider || this.account) || userCompact);
    const before = `${this.info.compactWindow}/${this.info.contextWindow}`;
    // the official binary will not go under 100K whatever the variable says (engine-providers: 50K set → 100K): the
    // ring and the card say where it really compacts (final review M6); ccb takes the value as it is
    if (cap) this.info.compactWindow = engine.kind === 'claude' ? Math.max(cap, OFFICIAL_COMPACT_FLOOR) : cap;
    else delete this.info.compactWindow;
    this.noteWindow(false);
    if (`${this.info.compactWindow}/${this.info.contextWindow}` !== before) this.emit('info', this.info);
    // the subagents' model (the composer's 子代理 chip), over an agent's own `model:` and the tool's haiku / sonnet /
    // opus: ccb always; the official binary only with `_FORCE` — without it the agent's own model came first, and
    // Explore (inherit) ran on the main model (2026-10-19, real: Opus 5.5 + a DeepSeek pick, the Explore subagent on
    // Opus; a user's relay showed claude-sonnet-5). On the official binary a 1M Claude gets its `[1m]` like the main model
    const sub = splitAlias ?? (sameSub ? this.engineModel(engine.kind, sameSub) : undefined);
    if (sub) { fenv.CLAUDE_CODE_SUBAGENT_MODEL = sub; fenv.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1'; }
    this.subRuns = sub ? unalias(sub) : '';
    // 下一句提示: the `promptSuggestions` option alone did not bring one on the official binary (2026-10-16, a real
    // two-turn conversation); with the CLI's own switch it did
    if (promptSuggestionsOn && !('CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION' in fenv) && process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION === undefined) fenv.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = '1';
    // 代码审查卡: /code-review reports through the ReportFindings tool (drawn as a card) instead of printing its findings
    if (!('CLAUDE_CODE_REPORT_FINDINGS' in fenv) && !process.env.CLAUDE_CODE_REPORT_FINDINGS) fenv.CLAUDE_CODE_REPORT_FINDINGS = '1';
    // a claude.ai-login session on the bundled ccb: its alias table predates the Claude 5 family (see
    // OFFICIAL_ALIAS_TARGETS) — the CLI's own variables align it with the official one; the user's env / settings win.
    // Not for a relay the user set up in settings.json / the environment: its model list is its own (the injected
    // claude-sonnet-5 default hung 220 s on model_not_found, 2026-10-01)
    const own = this.account ? NO_RELAY : userAnthropicEnv();
    if (engine.kind === 'ccb' && !this.provider && !own.relay) for (const [k, v] of Object.entries(ccbAccountEnv())) if (!(k in fenv) && !(own.env as Record<string, string | undefined>)[k]) fenv[k] = v;
    // The engine's own WebSearch tool: its default backend is a hosted Tavily proxy of the upstream project, and the
    // user wants no Tavily — searching is the `web` MCP server's, in the built-in browser. So the engine's tool is
    // taken away below (`disallowedTools`), unless the user chose a backend for it themselves (web/engine-search.ts).
    // 只聊天: no tool of any kind — the engine's own (`tools: []`), ours (no MCP servers, no plugin), the user's
    // (`strictMcpConfig`: the servers in their settings files are not loaded either)
    const chatOnly = !!this.features.chatOnly;
    // A Gemini-web / WorkBuddy sidecar has no native tool calling: every schema rides in the prompt, past 128 KB the
    // prompt is uploaded as an attachment and past ~163 KB its tail (the tool-call format) is cut. Narrowing the
    // engine's tools also takes its tool search away, so every MCP tool got inlined — the account's claude.ai
    // connectors, the user's servers, ours: 177 KB before the user said anything (2026-10-22). The core tools only
    // (62 KB): no MCP server of any origin, no plugin, no prompt section about tools that are not there.
    const lean = !chatOnly && !!this.provider?.leanTools;
    const bare = chatOnly || lean;
    const computer = this.features.computerUse && !bare ? computerClaudeMcpServer({ sessionId: this.sessionId }) : {};
    // 跨对话工具 (sessions-mcp/tools.ts): in-process, so nothing to hand out; archive_session is left to the permission mode
    const sessionsMcp: Record<string, McpServerConfig> = sessionsMcpEnabled() && !bare ? { [SESSIONS_SERVER]: sessionsMcpServer(() => this.sessionId) } : {};
    // 预览服务器 (preview/tools.ts): preview_start runs a command, so only its logs / stop are pre-allowed
    const previewMcp: Record<string, McpServerConfig> = previewEnabled() && !bare ? { [PREVIEW_SERVER]: previewMcpServer(this.cwd, () => this.sessionId) } : {};
    const verify = bare ? null : verifyInstructions(this.cwd);
    // 思考用的语言: a section of the system prompt (read once at start: a change restarts the process once idle)
    this.thinkingSection = this.thinkingLanguageSection();
    // a subagent model picked: the work goes to subagents without the user asking each time (subagent-policy.ts); the
    // pick is in the plan key, so a change restarts the process and this is read again
    // — only when the model is bound (`sub`): a pick that cannot be reached leaves the subagents on the main model, and
    // sending every piece of work to them would only cost more
    const delegate = bare || !sub ? '' : subagentPolicyPrompt(this.subagent);
    const append = [verify, this.thinkingSection, delegate, this.projectInstructions, bare || this.drivenBy ? '' : nodegraphHintPrompt(nodegraphHintOn)].filter(Boolean).join('\n\n');
    const allowed = bare ? [] : [...webAllowedTools(), ...(Object.keys(computer).length ? computerAllowedTools() : []), ...(Object.keys(sessionsMcp).length ? SESSIONS_ALLOWED : []), ...(Object.keys(previewMcp).length ? PREVIEW_ALLOWED : [])];
    this.preAllowed = new Set(allowed);
    const noEngineSearch = engineSearchOff({ engine: engine.kind, userChoice: 'WEB_SEARCH_ADAPTER' in fenv || userPickedSearchAdapter(this.cwd) });
    // a provider session must not inherit provider-ish env from this process (e.g. a global ANTHROPIC_API_KEY)
    const base = { ...process.env };
    // …including a stray CLAUDE_CODE_USE_* switch, which would route the profile to another ccb provider
    if (this.provider || this.account) for (const k of Object.keys(base)) if (/^((ANTHROPIC|OPENAI|GEMINI|GROK|XAI)_|CLAUDE_CODE_USE_)/.test(k) && !(k in fenv)) delete base[k];
    const env = Object.keys(fenv).length ? { ...base, ...fenv } : undefined;
    // the cache shim / model gateway live on 127.0.0.1: an HTTP(S)_PROXY from the user's environment must not carry
    // those requests off to a proxy (a remote one cannot reach our loopback, and the turn just hangs)
    if (env) Object.assign(env, loopbackNoProxy(env));
    // a provider conversation: what the user's settings files would lay over the provider's env goes back on top
    // through the flag tier (`settingsOverride`)
    this.nextFlag?.dispose();
    this.nextFlag = null;
    // The account: only what we set goes over the same keys there — the subagents' model, and the split route's base
    // URL over the user's own relay (both engines lay the settings files' env over the one they start with), and the
    // 自动压缩 point the user set for the account over a CLAUDE_CODE_AUTO_COMPACT_WINDOW in their settings.json (A7)
    const ours: Record<string, string> = { ...(sub ? { CLAUDE_CODE_SUBAGENT_MODEL: sub, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } : {}), ...((splitAlias || privacyOwn) && fenv.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: fenv.ANTHROPIC_BASE_URL } : {}), ...(userCompact && fenv.CLAUDE_CODE_AUTO_COMPACT_WINDOW ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: fenv.CLAUDE_CODE_AUTO_COMPACT_WINDOW } : {}) };
    const override = this.provider || this.account ? settingsOverride(fenv, this.cwd) : ownOverride(ours, this.cwd);
    if (override) {
      try {
        this.nextFlag = writeFlagSettings(override);
      } catch (e) {
        console.warn(`[session ${this.sessionId.slice(0, 8)}] could not write the --settings file (the user's settings.json env stays on top): ${(e as Error).message}`);
      }
    }
    const options: Options = {
      cwd: this.cwd,
      // a project's extra folders (stage C2): Claude Code may read and edit them like the main one
      ...(this.extraDirs.length ? { additionalDirectories: this.extraDirs } : {}),
      env,
      model: this.engineModel(engine.kind, this.model),
      // `ultra` is Codex-only; the Claude SDK's ladder tops out at max
      effort: this.effort === 'ultra' ? 'max' : this.effort,
      permissionMode: this.permissionMode,
      // The SDK defaults to an EMPTY system prompt. We want the real Claude Code prompt: same behaviour as the
      // CLI, and relays that fingerprint Claude Code requests (e.g. super-nb) reject bodies without it.
      // 自动验证: a project with .claude/launch.json is told to check its change in the running app (preview/tools.ts)
      // 思考用的语言 (thinking-language.ts) goes after it
      systemPrompt: append ? { type: 'preset', preset: 'claude_code', append } : { type: 'preset', preset: 'claude_code' },
      // Shared cross-agent memory, injected per session rather than written into ~/.claude —
      // uninstalling claude-web must not leave an MCP entry behind in the user's own config.
      // 联网 (`web`: search + the built-in browser) goes in the same way (web/launcher.ts).
      // 操控电脑 (`computer`: the whole desktop, computer/launcher.ts) only for a conversation that has it switched on.
      mcpServers: bare ? {} : { ...this.injectedMcp({ ...claudeMcpServer({ cwd: this.cwd, sessionId: this.sessionId, agent: 'claude', ...(this.botId ? { botId: this.botId } : {}) }), ...webClaudeMcpServer({ sessionId: this.sessionId }), ...computer }), ...sessionsMcp, ...previewMcp },
      // a sidecar (`lean`, see above): the core set still covers read / search / edit / run
      ...(chatOnly ? { tools: [], strictMcpConfig: true } : lean ? { tools: LEAN_TOOLS, strictMcpConfig: true } : {}),
      // 网吧's cafe-character skill, as a local plugin (both runtimes load it: 2026-10-13), only while the `web` server
      // that answers its character_* tools is handed out
      // + the official app's download of Anthropic's skills (desktop-skills.ts), so its conversations' anthropic-skills:*
      // names work here
      ...(() => {
        if (bare) return {};
        const dirs = [webMcpEnabled() ? cafePluginDir() : null, webMcpEnabled() ? asciiPluginDir() : null, desktopSkillsPlugin()].filter((d): d is string => !!d);
        return dirs.length ? { plugins: dirs.map((p) => ({ type: 'local' as const, path: p })) } : {};
      })(),
      // searching only reads: 每步询问 does not ask for every search (the browser tools follow the permission mode).
      // The computer tools are not asked about one by one either: the user approves the applications, in the app
      // (computer/access.ts), and the server's own gate holds every action to that.
      ...(allowed.length ? { allowedTools: allowed } : {}),
      ...(noEngineSearch ? { disallowedTools: [ENGINE_SEARCH_TOOL] } : {}),
      includePartialMessages: true,
      // 下一句提示: one `prompt_suggestion` after a turn (the composer shows it grey; settings → ui.promptSuggestions)
      promptSuggestions: promptSuggestionsOn,
      includeHookEvents: true,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      // 后台: every background task has its own Stop (the 后台 page, the task panel, a workflow card), so the turn's
      // Stop only stops the turn — without this the CLI kills running workflows / background agents with it
      perTaskStopAffordance: true,
      settingSources: ['user', 'project', 'local'],
      ...(this.nextFlag ? { settings: this.nextFlag.file } : {}),
      pathToClaudeCodeExecutable: exe,
      spawnClaudeCodeProcess: ((o: Parameters<typeof spawnClaude>[0]) => this.spawnProcess(o)) as Options['spawnClaudeCodeProcess'],
      abortController: this.abort,
      allowDangerouslySkipPermissions: true,
      canUseTool: (toolName, input, o) => this.onCanUseTool(toolName, input, o),
      // 思考用的语言 goes in the system prompt only: the per-step reminder hook tripped the API's safety classifier
      // (see thinking-language.ts, 2026-10-22)
      ...extra,
    };
    if (this.gated) options.hooks = { ...extra.hooks, PreToolUse: [...(extra.hooks?.PreToolUse ?? []), { hooks: [this.gateHook], timeout: GATE_HOOK_TIMEOUT_S }] };
    this.q = query({ prompt: this.input, options });
    void this.pump();
  }

  /**
   * The SDK reads the CLI's stderr only with its own spawn, so with ours it went nowhere: every failure was just
   * "exited with code 1" (the cause — ccb's "unknown option '--session-mirror'" — was one stderr line), and a pipe nobody
   * reads can fill and stall the CLI. Read it, log it, keep its end for the error message.
   */
  /**
   * The injected stdio MCP servers (Windows programs). In WSL they start through interop at their /mnt path, or are
   * dropped (interop off) and named in info.wsl. sessions / preview are in-process (the SDK's control channel): untouched.
   */
  private injectedMcp(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
    if (!this.wsl) return servers;
    const r = rewriteMcpForWsl(servers as Record<string, StdioServer>, { interop: wslService()?.cached(this.wsl.distro)?.interop !== false });
    this.info.wsl = { distro: this.wsl.distro, dropped: r.dropped };
    return r.servers as Record<string, McpServerConfig>;
  }

  private spawnProcess(o: Parameters<typeof spawnClaude>[0]) {
    const child = this.wsl ? spawnWsl(o, { distro: this.wsl.distro, cwd: toWslPath(this.cwd, this.wsl.distro)!, exe: 'claude' }) : spawnClaude(o);
    this.child = child;
    this.stderrTail = '';
    const flag = this.nextFlag;
    this.nextFlag = null;
    if (flag) {
      if (!child) flag.dispose();
      else { child.once('exit', () => flag.dispose()); child.once('error', () => flag.dispose()); }
    }
    const tag = `[claude ${this.sessionId.slice(0, 8)}] `;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (s: string) => {
      if (this.child === child) this.stderrTail = (this.stderrTail + s).slice(-4000);
      process.stderr.write(s.split(/\r?\n/).filter((l) => l.trim()).map((l) => tag + l + '\n').join(''));
    });
    return child;
  }

  /**
   * The SDK's close resolves before the CLI is gone, and on Windows waits 2 s + 5 s before killing it: meanwhile the
   * old process still answered (and billed) a turn the window never saw, and a new one on the same id sometimes failed
   * "Session ID … already in use". Give it a moment to finish writing the transcript, then make sure it is gone —
   * with its whole tree: on Windows child.kill() ends only the CLI's node, and a hung CLI's Bash tools / background
   * commands / curl loops would keep running (a bot's hard stop must stop them too).
   */
  private async endProcess(child: ChildProcess | null) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = (ms: number) => new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
      const t = setTimeout(() => { child.off('exit', done); resolve(false); }, ms);
      const done = () => { clearTimeout(t); resolve(true); };
      child.once('exit', done);
    });
    if (await exited(1500)) return;
    await killTree(child);
    await exited(2000);
  }

  private async pump() {
    const q = this.q!;
    try {
      const init = await q.initializationResult().catch(() => null);
      if (init) {
        try {
          const [cmds, models, agents, mcp] = await Promise.all([
            q.supportedCommands().catch(() => []),
            q.supportedModels().catch(() => []),
            q.supportedAgents().catch(() => []),
            q.mcpServerStatus().catch(() => []),
          ]);
          // ccb has no supported_commands/supported_models control requests; fall back to the initialize payload
          const im = init as any;
          const cmdSrc: any[] = cmds.length ? cmds : im.commands ?? [];
          const modelSrc: any[] = models.length ? models : im.models ?? [];
          this.info.slashCommands = cmdSrc.map((c) => ({ name: c.name, description: c.description ?? '', argumentHint: c.argumentHint ?? c.argument_hint ?? '' }));
          // The CLI's own list wins; the catalog only supplies the versioned display name ("Fable 5.1", not "Fable").
          // Thinking strength on our engine: every model has it — the provider's own parameter, or through the prompt
          // (`effortMode`, levels from the model list > our table > five; modelCaps). The official binary has no prompt
          // way, so there only the models with the parameter offer it. Image / embedding models are not for chatting.
          this.info.models = this.provider?.models?.length
            ? this.provider.models.filter(isChatModel).map((v) => this.modelEntry(v, modelLabel('claude', v), this.provider!.name))
            : modelSrc.length
              ? modelSrc.map((m) => this.modelEntry(m.value, m.displayName && m.displayName !== m.value ? m.displayName : modelLabel('claude', m.value), m.description ?? '', { supportsEffort: m.supportsEffort, levels: m.supportedEffortLevels }))
              : modelsFor('claude');
          // claude-web-engine: --ultracode / the `ultracode` setting on every model; the official binary: `/effort ultracode`
          this.info.supportsUltracode = supportsUltracode('claude');
          this.info.agents = agents.map((a) => ({ name: a.name, description: a.description, model: a.model }));
          this.info.mcpServers = mcp.map((m) => ({ name: m.name, status: m.status, error: m.error, tools: m.tools }));
          if (im.fast_mode_state) { this.info.fastMode = im.fast_mode_state; if (im.fast_mode_disabled_reason) this.info.fastModeOff = im.fast_mode_disabled_reason; }
          this.emit('info', this.info);
        } catch {
          /* non-fatal */
        }
        // In --resume mode the CLI only emits `system/init` when the first turn starts, so the
        // process is ready as soon as the control-channel initialize completes.
        if (this.state === 'starting') {
          const im = init as any;
          if (im.current_permission_mode) this.info.permissionMode = im.current_permission_mode;
          this.setState('idle');
        }
      }
      for await (const m of q) {
        // replaced (respawn / a forced stop): a late message from the old process is not this conversation's any more
        if (this.q !== q) break;
        this.lastActivity = Date.now();
        this.ingest(m);
      }
      // a respawn replaced this query: its end is expected, not the session closing
      if (!this.closed && this.q === q) this.setState('closed');
    } catch (e: any) {
      if (!this.closed && this.q === q) {
        // the CLI's own words ("error: unknown option '--session-mirror'") say more than the SDK's "exited with code 1"
        const said = cliSaid(this.stderrTail);
        const raw = String(e?.message ?? e) + (said && !String(e?.message ?? e).includes(said) ? tr('（CLI 输出：{said}）', { said }) : '');
        const gone = missingCwd(this.cwd);
        this.setState('error', gone ? tr("{gone}\n原文：{raw}", { gone, raw }) : withExplanation(raw));
      }
    }
  }

  private ingest(m: SDKMessage) {
    // claude-web-engine: a model refused its native thinking-strength parameter — ours to record, not the window's
    if (m.type === 'system' && (m as { subtype?: string }).subtype === 'cw_capability') {
      const model = (m as { model?: unknown }).model;
      if (typeof model === 'string' && model) this.promptOnly(model);
      return;
    }
    if (m.type === 'system' && m.subtype === 'init') {
      // resumed: the CLI says init as the first turn STARTS — that turn is running, not idle (a switch mid-turn missed
      // it and never ended the turn; Stop took the no-turn path)
      const busy = this.busy();
      this.sessionId = m.session_id;
      this.info = {
        ...this.info,
        sessionId: m.session_id,
        model: m.model,
        effort: m.effort ?? this.effort ?? null,
        permissionMode: m.permissionMode,
        tools: m.tools,
        skills: m.skills,
        plugins: m.plugins,
        claudeCodeVersion: m.claude_code_version,
        mcpServers: this.info.mcpServers ?? m.mcp_servers,
        state: busy ? this.state : 'idle',
      };
      this.emit('info', this.info);
      if (!busy) this.setState('idle');
    }
    // a workflow's agents: the engine reports `model ?? the main model`, but runs them on CLAUDE_CODE_SUBAGENT_MODEL
    // (forced) — the cards said routego/gpt-6.1-sol while DeepSeek answered (2026-10-30 user report 「子代理没按我设置的来」)
    if (this.subRuns && m.type === 'system' && Array.isArray((m as any).workflow_progress)) {
      for (const e of (m as any).workflow_progress) if (e?.type === 'workflow_agent' && typeof e.model === 'string') e.model = this.subRuns;
    }
    this.trackBackground(m);
    // a subagent through the split route: the engine names its messages after the alias it asked with
    if (m.type === 'assistant' && typeof (m as any).message?.model === 'string') (m as any).message.model = unalias((m as any).message.model);
    if ((m.type === 'result' || (m.type === 'system' && m.subtype === 'init')) && (m as any).fast_mode_state) this.noteFast((m as any).fast_mode_state, (m as any).fast_mode_disabled_reason);
    if (m.type === 'system' && m.subtype === 'session_state_changed') {
      this.setState(m.state === 'running' ? 'running' : m.state === 'requires_action' ? 'waiting' : 'idle');
    }
    if (m.type === 'system' && m.subtype === 'status' && m.permissionMode) {
      this.info.permissionMode = m.permissionMode;
      this.emit('info', this.info);
    }
    if (m.type === 'system' && m.subtype === 'commands_changed') {
      this.info.slashCommands = m.commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }));
      this.emit('info', this.info);
    }
    if (m.type === 'result') {
      // subagents through the split route are counted by the engine under the alias it asked with: under the real model
      const mu = (m as any).modelUsage;
      if (mu && typeof mu === 'object' && Object.keys(mu).some((k) => unalias(k) !== k)) {
        const out: Record<string, Record<string, unknown>> = {};
        for (const [k, v] of Object.entries(mu as Record<string, Record<string, unknown>>)) {
          const prev = out[unalias(k)];
          if (!prev) { out[unalias(k)] = { ...v }; continue; }
          for (const [f, x] of Object.entries(v)) if (typeof x === 'number') prev[f] = (typeof prev[f] === 'number' ? (prev[f] as number) : 0) + x;
        }
        (m as any).modelUsage = out;
      }
      turnShare(m as any, this.totals); // the CLI reports running totals; everything downstream adds turns up
      // ccb prices every model with Claude's table: for other vendors' models the number is fiction
      markUnknownCost(m as any, this.provider?.type);
      // refused for an empty block in the history: the process keeps that history in memory and would be refused
      // again on every turn — start it over, so the resume reads the transcript with the block taken out (dropEmptyBlocks)
      const said = `${(m as any).result ?? ''} ${JSON.stringify((m as any).errors ?? '')}`;
      if ((m as any).is_error && /empty text blocks|text content blocks must be non-empty|thinking block must contain non-whitespace|Invalid `signature` in `thinking` block/.test(said)) { this.repairEmptyBlocks = true; this.respawnPending = true; }
      if ((m as any).is_error && /Invalid `signature` in `thinking` block/.test(said)) this.repairUnsigned = true;
      this.setState('idle');
    }
    // keep history bounded to avoid unbounded memory in very long sessions; partial events are dropped from history
    if (m.type !== 'stream_event') {
      this.history.push(m);
      if (this.history.length > 5000) this.history.splice(0, 1000);
    }
    this.emit('message', m);
    // Point the file's leaf at this turn, for a `claude --resume` in the terminal: ccb writes no leaf at all, and the
    // official binary writes it when a prompt is sent and when it exits — while it sat idle, the file's leaf was the
    // entry before its last answer (2026-10-02, real relays). A moment after the answer is on disk: the CLI still
    // writes its own lines after a result.
    if (m.type === 'result' && this.hasTranscript) {
      const id = this.sessionId;
      const repair = () => repairLeaf(findClaudeTranscript(id), id);
      if (this.info.runtime === 'ccb') setTimeout(repair, 1500).unref?.();
      else void this.flushed(5000).then(() => setTimeout(repair, 1500).unref?.());
    }
    // a model / effort change made during the turn that needs another process: now that the turn is over
    // — and once its background subagents / workflows are back: a restart would take them down (their notification
    // starts a turn of its own, whose result lands here again)
    // An account window change deferred to the turn's end goes first (it may compact on the current process before
    // the new window takes effect); a restart pending for something else follows it, unless the change restarted already
    if (m.type === 'result' && this.deferredChange && !this.closed) {
      const change = this.deferredChange;
      this.deferredChange = null;
      const pending = this.respawnPending;
      this.respawnPending = false;
      const q = this.q;
      void change().then(() => { if (pending && this.q === q && !this.closed) return this.respawnWhenIdle(); }).catch(() => { /* the old process keeps going */ });
      return;
    }
    if (m.type === 'result' && this.respawnPending && !this.closed && !this.hasBackgroundWork()) {
      this.respawnPending = false;
      void this.respawn();
    }
  }

  /**
   * Restart the process now, or — mid-turn, or while background subagents / workflows of it still run — once that is
   * over (a restart would cut the turn off, and kill the background work: 2026-10-19, a settings change restarted a
   * conversation idling while its subagents worked).
   */
  private respawnWhenIdle(): Promise<void> {
    if (this.busy() || this.hasBackgroundWork()) { this.respawnPending = true; return Promise.resolve(); }
    return this.respawn();
  }

  private onCanUseTool(toolName: string, input: Record<string, unknown>, o: { signal: AbortSignal; suggestions?: unknown[]; toolUseID?: string; blockedPath?: string; decisionReason?: string }): Promise<PermissionResult> {
    const requestId = randomUUID();
    const event: PermissionRequestEvent = { requestId, sessionId: this.sessionId, toolName, input, toolUseId: o.toolUseID, suggestions: o.suggestions, blockedPath: o.blockedPath, decisionReason: o.decisionReason };
    if (o.signal.aborted) return Promise.resolve({ behavior: 'deny', message: 'cancelled' });
    if (this.gated) {
      // the PreToolUse hook already asked the gate about this call: its answer, not a second gate run (and audit row)
      const decided = o.toolUseID ? this.hookAnswers.get(o.toolUseID) : undefined;
      if (decided) { this.hookAnswers.delete(o.toolUseID!); return Promise.resolve(decided); }
      // the backstop (a call the hook never saw): gated here, no card, no allowed-tools shortcut
      return this.askGate(event);
    }
    // claude-web-engine (ccb) defers MCP tools behind ExecuteExtraTool { tool_name, params }: `allowedTools` names the tool
    // inside, so the wrapper asked every time (2026-10-16, the sessions tools on ccb). Allowed when what it runs is.
    if (toolName === 'ExecuteExtraTool' && typeof input.tool_name === 'string' && this.preAllowed.has(input.tool_name)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    if (this.gate) {
      return this.gate(event).then((r) => r ?? this.askUser(event, o.signal)).catch(() => this.askUser(event, o.signal));
    }
    return this.askUser(event, o.signal);
  }

  /** a gated conversation's answer: the gate's, else refused — nobody is there to see a card */
  private async askGate(event: PermissionRequestEvent): Promise<PermissionResult> {
    const nobody: PermissionResult = { behavior: 'deny', message: tr('没有人在看这个对话，这一步没法批准，没有执行') };
    if (!this.gate) return nobody;
    try { return (await this.gate(event)) ?? nobody; } catch (e) {
      console.warn(`[session ${this.sessionId}] gate failed for ${event.toolName}:`, e);
      return nobody;
    }
  }

  /** OpenSessionParams.gated: the PreToolUse hook that puts every tool call — whatever would skip canUseTool — before the gate */
  private gateHook: HookCallback = async (input, toolUseID, opts) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const toolInput = input.tool_input && typeof input.tool_input === 'object' && !Array.isArray(input.tool_input) ? input.tool_input as Record<string, unknown> : {};
    const id = toolUseID ?? input.tool_use_id;
    // the turn aborted, or the gate is still thinking near the hook's timeout: refused, never left to the CLI
    const r = await untilAbortOrDeadline(this.askGate({ requestId: randomUUID(), sessionId: this.sessionId, toolName: input.tool_name, input: toolInput, toolUseId: id }), opts?.signal);
    // a refused call never reaches canUseTool: only an allow is kept for it
    if (id && r.behavior === 'allow') {
      this.hookAnswers.set(id, r);
      // calls the hook allowed and canUseTool never asked about: keep the map small
      if (this.hookAnswers.size > 200) this.hookAnswers.delete(this.hookAnswers.keys().next().value!);
    }
    const out: HookJSONOutput = r.behavior === 'allow'
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', ...(r.updatedInput ? { updatedInput: r.updatedInput } : {}) } }
      : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.message } };
    return out;
  };

  /** the usual permission card: pending until respondPermission() or the turn's abort */
  private askUser(event: PermissionRequestEvent, signal: AbortSignal): Promise<PermissionResult> {
    const requestId = event.requestId;
    // a gate that said null / threw after the turn was aborted: the abort listener below would never fire
    if (signal.aborted) return Promise.resolve({ behavior: 'deny', message: 'cancelled' });
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { event, resolve });
      signal.addEventListener('abort', () => {
        if (this.pending.delete(requestId)) {
          resolve({ behavior: 'deny', message: 'cancelled' });
          this.emit('permissionResolved', requestId);
        }
      }, { once: true });
      this.setState('waiting');
      this.emit('permission', event);
    });
  }

  respondPermission(requestId: string, r: PermissionResponse): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    // an allow says what to run with: claude-web-engine (ccb) checks the answer against a schema where `updatedInput`
    // is required and turned every 允许 without it into "Tool permission request failed" — every tool that asks
    // failed (user report 2026-10-14, a relay's Claude on ccb). The input as it was asked is what was allowed.
    const answer = r.behavior === 'allow' && !r.updatedInput ? { ...r, updatedInput: p.event.input as Record<string, unknown> } : r;
    p.resolve(answer as PermissionResult);
    this.emit('permissionResolved', requestId);
    if (this.pending.size === 0) this.setState('running');
    return true;
  }

  send(text: string, images?: { mediaType: string; data: string }[], steer = false, uuid?: string, attachments?: AttachmentRef[]) {
    // the query loop is gone: queueing would flip the UI to "running" with nothing ever answering
    if (this.closed || this.state === 'closed' || this.state === 'error') throw new Error(sendRefused(this.state === 'error' && !this.closed, this.info.error));
    if (this.ultracodeFirst) {
      this.ultracodeFirst = false;
      this.send('/effort ultracode');
    }
    this.hasTranscript = true; // the CLI writes the JSONL with this message
    uuid ??= randomUUID(); // becomes the transcript uuid: how this conversation's own prompts are told from others
    this.known.add(uuid);
    const content: any[] = [];
    for (const im of images ?? []) content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } });
    // attachments: markers the model can act on (Read the path) and the web UI decodes back into chips
    if (attachments?.length) {
      const marks = attachments.map((a) => {
        const attrs = `kind="${a.kind}" name="${esc(a.name)}"${a.path ? ` path="${esc(a.path)}"` : ''}${a.size !== undefined ? ` size="${a.size}"` : ''}`;
        return a.kind === 'text' && a.text !== undefined ? `<attached ${attrs}>\n${a.text}\n</attached>` : `<attached ${attrs} />`;
      });
      text = `${text}\n\n${marks.join('\n')}`;
    }
    // a picture alone: no text block — an empty one is refused by the API, and from the transcript on every later turn
    if (text.trim() || !content.length) content.push({ type: 'text', text });
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: images?.length ? content : text },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      origin: { kind: 'human' },
      // client-minted uuid: becomes the transcript uuid, echoed as user_message_uuid on the first reply frame / result,
      // so the local echo id == fork/rewind point
      ...(uuid ? { uuid } : {}),
      ...(steer ? { priority: 'now' } : {}),
    } as SDKUserMessage;
    this.lastActivity = Date.now();
    this.setState('running');
    this.input.push(msg);
    this.emit('sent', msg);
  }

  /** After Stop the CLI gets this long to end the turn itself; then its process is killed and the turn ended here. */
  static STOP_GRACE_MS = 8_000;

  /**
   * 旁聊 (spec 2026-10-16 chat-input §1): the engine answers a question from this conversation's context and writes
   * nothing to it. `askSideQuestion` is on the SDK's Query but not in its types; the CLI wants the side chat's earlier
   * turns as {question, response}. `text: null`: the engine had no answer.
   */
  async askSide(question: string, history: SideTurn[]): Promise<{ text: string | null; synthetic?: boolean }> {
    const q = this.q as (Query & { askSideQuestion?: (q: string, o: { history: SideTurn[] }) => Promise<{ response: string; synthetic: boolean } | null> }) | null;
    if (!q?.askSideQuestion) throw new Error(tr('这个对话的进程没在运行'));
    const r = await q.askSideQuestion(question, { history });
    return r ? { text: r.response, synthetic: r.synthetic } : { text: null };
  }

  /**
   * Stop always stops. The CLI normally answers the interrupt with a `result`; one stuck on a request that never
   * returns (or anywhere it no longer reads its control channel) would leave the conversation "thinking" for good —
   * after the grace period the turn is ended here and the process restarted on the same conversation.
   */
  async interrupt(o: { closing?: boolean } = {}) {
    // deny any pending permission first so the turn can unwind
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.resolve({ behavior: 'deny', message: 'interrupted by user', interrupt: true });
      this.emit('permissionResolved', id);
    }
    const q = this.q;
    if (!q || !this.busy()) { await q?.interrupt().catch(() => {}); return; }
    const grace = SessionRunner.STOP_GRACE_MS;
    await Promise.race([q.interrupt().catch(() => {}), new Promise((r) => setTimeout(r, grace))]);
    if (await this.settles(q, grace)) return;
    await this.forceStop(q, o.closing);
  }

  /**
   * Resolves once the last answer this process gave is in its transcript (or after `ms`). The CLI writes it about 2 s
   * after the turn's result: a fork copied right after a turn lost that answer (2026-10-01, real relays).
   */
  async flushed(ms = 3000): Promise<void> {
    const last = [...this.history].reverse().find((m: any) => m.type === 'assistant' && typeof m.uuid === 'string') as { uuid: string } | undefined;
    if (!last) return;
    const until = Date.now() + ms;
    while (!hasEntry(findClaudeTranscript(this.sessionId), last.uuid) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  }

  /**
   * While this process sat idle, its conversation got a turn from somewhere else — `claude --resume` in a terminal. Its
   * context no longer has that turn: the next message here was answered without it and branched it off for good
   * (2026-10-01, real CLI). A few seconds of quiet first: the CLI keeps writing its own lines after a result.
   */
  wroteElsewhere(): boolean {
    if (this.closed || this.state !== 'idle' || this.respawnPending || Date.now() - this.lastActivity < 3000) return false;
    const last = lastHumanPrompt(findClaudeTranscript(this.sessionId));
    return !!last && !this.known.has(last);
  }

  /** Idle, nothing waiting to restart or still running in the background, quiet for a few seconds: safe to write its transcript from outside. */
  quiet(): boolean {
    return !this.closed && this.state === 'idle' && !this.respawning && !this.respawnPending && !this.hasBackgroundWork() && Date.now() - this.lastActivity >= 3000;
  }

  /**
   * Not quiet yet, but about to be on its own: starting, restarting, or idle and only inside the 3 s after its last
   * output. Background work or a restart waiting for its turn can last minutes: a send must not wait for those.
   */
  settling(): boolean {
    if (this.closed || this.respawnPending || this.hasBackgroundWork()) return false;
    return this.state === 'starting' || this.respawning || (this.state === 'idle' && !this.quiet());
  }

  /**
   * Close after `wroteElsewhere()`. The official binary writes its own idea of the leaf as it exits — the turn before
   * the terminal's — so the next resume would branch the terminal's turns off again; that line does not count.
   */
  async yieldToOutside(): Promise<void> {
    const file = findClaudeTranscript(this.sessionId);
    let from: number | undefined;
    try { from = file ? statSync(file).size : undefined; } catch { /* gone */ }
    await this.close();
    if (file && from !== undefined) repairLeaf(file, this.sessionId, { ignoreLeavesFrom: from });
  }

  /**
   * Rows were appended to the transcript while idle (a conversation that went on from DeepSeek Harness catching up):
   * restart the process so its context has them. The leaf the official binary writes as it exits does not count, as
   * in `yieldToOutside` — unlike that, the conversation stays open.
   */
  reloadTranscript(): Promise<void> {
    // one restart at a time: two at once left two processes resuming the same conversation (verifier, 2026-10-22)
    if (this.reloading) return this.reloading;
    const file = findClaudeTranscript(this.sessionId);
    let from: number | undefined;
    try { from = file ? statSync(file).size : undefined; } catch { /* gone */ }
    this.beforeRestart = file && from !== undefined ? () => repairLeaf(file, this.sessionId, { ignoreLeavesFrom: from }) : null;
    this.reloading = this.respawn().finally(() => { this.reloading = null; });
    return this.reloading;
  }
  private beforeRestart: (() => void) | null = null;
  private reloading: Promise<void> | null = null;
  /** respawn() is between ending the old process and starting the new one (the state still says idle then) */
  private respawning = false;

  private busy() {
    return this.state === 'running' || this.state === 'waiting';
  }

  /** Tasks of this process still going (sub-agents, workflows, background commands; not the ambient watchers). */
  private bgLive = new Set<string>();

  private trackBackground(m: SDKMessage) {
    if (m.type !== 'system') return;
    const x = m as any;
    if (x.subtype === 'background_tasks_changed' && Array.isArray(x.tasks)) {
      // the CLI's level signal: what runs in the background now (a foreground task in flight keeps the turn busy anyway)
      for (const id of [...this.bgLive]) if (!x.tasks.some((t: any) => t?.task_id === id)) this.bgLive.delete(id);
      for (const t of x.tasks) if (typeof t?.task_id === 'string' && t.ambient !== true) this.bgLive.add(t.task_id);
    } else if (x.subtype === 'task_started' && typeof x.task_id === 'string' && x.ambient !== true && x.skip_transcript !== true) {
      this.bgLive.add(x.task_id);
    } else if (x.subtype === 'task_notification' && typeof x.task_id === 'string') {
      this.bgLive.delete(x.task_id);
    } else if (x.subtype === 'task_updated' && typeof x.task_id === 'string' && ['completed', 'failed', 'killed'].includes(x.patch?.status)) {
      this.bgLive.delete(x.task_id);
    }
  }

  /**
   * Work still going in this process after its turn ended — a workflow, a background sub-agent or command (后台).
   * The pool does not reap such a process: it would take that work down with it, and its result (a task
   * notification starting a turn of its own) would never come.
   */
  hasBackgroundWork(): boolean {
    return this.bgLive.size > 0;
  }

  /** Resolves true once the turn is over (a result put the state back to idle) or the process was replaced / closed. */
  private settles(q: Query, ms: number): Promise<boolean> {
    const over = () => this.closed || this.q !== q || !this.busy();
    if (over()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v: boolean) => { clearTimeout(t); this.off('state', onState); resolve(v); };
      const onState = () => { if (over()) done(true); };
      const t = setTimeout(() => done(over()), ms);
      this.on('state', onState);
    });
  }

  /**
   * End the turn with a result of our own (the reducer, the ledger and the UI finish it like any other), then restart —
   * unless a close comes next (`closing`): that ends the hung process (and its tree) itself, a restart would be wasted.
   */
  private async forceStop(q: Query, closing = false) {
    if (this.closed || this.q !== q) return;
    const reason = closing ? tr('已强制停止：运行内核没有响应中断，已结束它的进程') : tr('已强制停止：运行内核没有响应中断，已结束它的进程并重新接上这个对话');
    this.ingest({
      type: 'result', subtype: 'error_during_execution', is_error: true, result: reason, errors: [reason], terminal_reason: 'aborted_forced',
      duration_ms: 0, duration_api_ms: 0, num_turns: 0, total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: {}, permission_denials: [], session_id: this.sessionId, uuid: randomUUID(),
    } as unknown as SDKMessage);
    if (!closing) await this.respawn();
  }

  async setPermissionMode(mode: PermissionMode) {
    await this.q?.setPermissionMode(mode);
    this.permissionMode = mode;
    this.info.permissionMode = mode;
    this.emit('info', this.info);
  }

  /**
   * The model as the engine takes it: ccb's own spelling, or — on the official binary with a provider — `[1m]` after a
   * Claude model whose window is over 200K (with no model picked, the provider's default one, so it gets the suffix too).
   */
  private engineModel(kind: string | undefined, model: string | undefined): string | undefined {
    // the account (claude.ai: the own login, another Claude account): the family's 200K / 1M pick decides `[1m]`
    // whatever the menu's id said (A7: new conversations sometimes started on Opus 5.5 at 200K) — before ccb's spelling,
    // which keeps the suffix
    const w = this.accountWindows();
    if (w) model = accountModel(model, w);
    if (kind === 'ccb') return ccbModel(model);
    if (kind !== 'claude' || !this.provider) return model;
    const id = providerModelId(this.provider, model);
    if (!id || !officialWindow(contextWindowFor(this.provider, id), id).suffix) return model;
    return `${model && model !== 'default' ? model.replace(/\[1m\]$/i, '') : id}[1m]`;
  }

  /**
   * The family picks this conversation's model names and windows follow: on claude.ai itself only — the own login
   * (the pool's settings) or another Claude account (its profile). Undefined for a provider, and for the own login
   * through a relay the user set up in settings.json / the environment: its models and windows are its own, and a
   * `[1m]` it was never sent before could be refused there.
   */
  private accountWindows(prefs = this.accountPrefs): AccountWindows | undefined {
    if (this.provider) return undefined;
    if (this.account) return familyWindows(this.account.contextWindows);
    return userAnthropicEnv().relay ? undefined : prefs.windows;
  }

  /** The official binary's `CLAUDE_CODE_AUTO_COMPACT_WINDOW` for `model` on this provider (none: it assumes right). */
  private officialCompactWindow(model: string | undefined): number | undefined {
    if (!this.provider) return undefined;
    const id = providerModelId(this.provider, model);
    return id ? officialWindow(contextWindowFor(this.provider, id), id).compactWindow : undefined;
  }

  /**
   * The 自动压缩 point the user set for this conversation's provider / account (A7) as it holds for `model`: 50K or more
   * (under that it is left out), and no further than its window when that is known — a point past it is capped there
   * (final review M4: leaving it out let the user's settings.json win again, against the editor's 「设了就以这里为准」;
   * the account's point is checked against its largest pick, so a 200K family meets a 700K one). Undefined: none set.
   */
  private userCompact(model: string | undefined): number | undefined {
    const set = this.provider ? this.provider.compactAt : this.account ? this.account.compactAt : this.accountPrefs.compactAt;
    if (!compactAtOk(set, undefined)) return undefined;
    const window = this.windowOf(model);
    return window ? Math.min(set!, window) : set;
  }

  /** Where `model` compacts on `kind`: the official binary's earlier point and the user's, the smaller one (none: the engine's own). */
  private compactPoint(kind: string, model: string | undefined): number | undefined {
    return effectiveCompact(kind === 'claude' ? this.officialCompactWindow(model) : undefined, this.userCompact(model));
  }

  /**
   * The context window `model` will have here, when it is known: the provider's settings (engine default otherwise);
   * on the account, the family's 200K / 1M pick (A7; haiku 200K, "default" is whatever the plan says); the own login
   * through a relay of the user's: `[1m]` is 1M and a plain id the 200K both engines give it. `prefs`: the own login's
   * picks to read it under (setAccountPrefs asks with the new ones before they take effect).
   */
  private windowOf(model: string | undefined, prefs = this.accountPrefs): number | undefined {
    if (this.provider) {
      const id = providerModelId(this.provider, model);
      return id ? contextWindowFor(this.provider, id) ?? ENGINE_DEFAULT_WINDOW : undefined;
    }
    const w = this.accountWindows(prefs);
    if (w) return accountWindowOf(model, w);
    if (!model || model === 'default') return undefined;
    return /\[1m\]$/i.test(model) ? ONE_M : ENGINE_DEFAULT_WINDOW;
  }

  /** `info.contextWindow` = the current model's window (absent when unknown); emitted when it changed (`emit`). */
  private noteWindow(emit = true) {
    const w = this.windowOf(this.model);
    if (w === this.info.contextWindow) return;
    if (w) this.info.contextWindow = w;
    else delete this.info.contextWindow;
    if (emit) this.emit('info', this.info);
  }

  /**
   * Switching to a model with a smaller window than the conversation already uses (Claude 1M → GPT 272K at 600K):
   * the new model could not even read the conversation to compact it, so the current one compacts it first
   * (`/compact`), then the switch goes ahead. Nothing happens while a turn runs, or when it fits (FIT_SHARE).
   * `window`: the window `model` will have after the change (the account's 200K / 1M pick moving: setAccountPrefs).
   */
  private fitBeforeSwitch(model: string, window = this.windowOf(model)): Promise<boolean> {
    // one at a time (final review I1: two account saves ms apart both passed the busy check below and both sent
    // /compact): a second caller waits for the one under way — it compacted (the context is small now), or it did not
    // (it fit its window, or gave way), and the second looks again with its own window
    if (this.fitting) return this.fitting.then((did) => did || this.fitBeforeSwitch(model, window));
    const run = this.fitNow(model, window).finally(() => { if (this.fitting === run) this.fitting = null; });
    this.fitting = run;
    return run;
  }
  /** the compaction fitBeforeSwitch has under way */
  private fitting: Promise<boolean> | null = null;

  private async fitNow(model: string, window: number | undefined): Promise<boolean> {
    if (!this.q || this.busy() || !this.hasTranscript || this.closed) return false;
    if (!window) return false;
    const q = this.q;
    let used = 0;
    try { const u = await this.contextUsage('summary'); used = Number(u?.totalTokens ?? u?.total_tokens ?? 0); } catch { return false; }
    // the answer takes a moment: a turn may have started, or the process been replaced / closed meanwhile
    if (this.closed || this.q !== q || this.busy()) return false;
    if (!(used > window * FIT_SHARE)) return false;
    const k = (n: number) => `${Math.round(n / 1000)}K`;
    this.notice(used >= window ? tr('对话已经用了 {k}，{model} 最多只能装 {k2}：先用现在的模型把对话压缩一下，再换过去', { k: k(used), model, k2: k(window) }) : tr('对话已经用了 {k}，快到 {model} 的上限 {k2} 了：先用现在的模型把对话压缩一下，再换过去', { k: k(used), model, k2: k(window) }));
    const done = new Promise<void>((resolve) => {
      const t = setTimeout(() => { this.off('message', on); resolve(); }, 15 * 60_000);
      t.unref?.();
      const on = (m: SDKMessage) => { if (m.type === 'result') { clearTimeout(t); this.off('message', on); resolve(); } };
      this.on('message', on);
    });
    this.send('/compact');
    await done;
    return true;
  }

  /** A line in the conversation from this app (not the model): every window shows it; it is not in the transcript. */
  private notice(text: string) {
    const m = { type: 'system', subtype: 'cw_notice', text, uuid: randomUUID(), session_id: this.sessionId } as unknown as SDKMessage;
    this.history.push(m);
    this.emit('message', m);
  }

  /**
   * Whether `model` ('' = the default) is a Claude model — what the Anthropic API checks the thinking signatures of.
   * A model of another provider picked in this conversation (`cw-x:<provider>:<model>`) counts by its own name.
   */
  private toClaude(model: string): boolean {
    const id = this.provider ? providerModelId(this.provider, model || undefined) : model;
    return id ? isClaudeModel(id.replace(/^cw-x:[^:]*:/, '')) : !this.provider;
  }

  async setModel(model: string) {
    await this.fitBeforeSwitch(model);
    // the model can decide the engine (see plan()): crossing over means another process, resuming this conversation
    // what one vendor's model left in the history another's API can refuse (DeepSeek's blank thinking → Claude): the
    // next process reads the transcript cleaned. An in-process switch keeps the history in memory — the 400 does it;
    // so from another vendor's model to Claude it is always another process (its thinking is unsigned: every turn a 400)
    if (this.plan(model).key !== this.planKey || (this.toClaude(model) && !this.toClaude(this.model ?? ''))) {
      this.model = model;
      this.info.model = model;
      this.noteWindow(false);
      this.emit('info', this.info);
      this.repairEmptyBlocks = true;
      await this.respawnWhenIdle();
      return;
    }
    try {
      await this.q?.setModel(this.engineModel(this.info.runtime, model));
      this.model = model;
      this.info.model = model;
      this.noteWindow(false);
      this.emit('info', this.info);
    } catch (e) {
      // fall back to respawn with resume
      this.model = model;
      this.info.model = model;
      this.noteWindow(false);
      this.emit('info', this.info);
      this.repairEmptyBlocks = true;
      await this.respawnWhenIdle();
    }
  }

  async setEffort(effort: EffortLevel) {
    this.effort = effort;
    this.info.effort = effort;
    if (this.info.ultracode) this.info.ultracode = false; // picking a rung leaves ultracode
    this.ultracodeFirst = false;
    if (this.info.runtime === 'ccb') {
      this.emit('info', this.info);
      // claude-web-engine: the level (and leaving ultracode, in the same call) is a flag setting of the running
      // process — the next request has it, no restart, not even mid-turn. `ultra` is Codex's own: max here.
      try {
        await this.q?.applyFlagSettings({ effortLevel: effort === 'ultra' ? 'max' : effort, ultracode: false } as any);
      } catch {
        await this.respawnWhenIdle(); // an engine without it: the level is an option of the process
      }
      return;
    }
    // The official binary has no runtime control for effort: send the slash command through the conversation.
    this.send(`/effort ${effort}`);
  }

  /**
   * ultracode = xhigh + workflow orchestration, session-scoped; NOT an effort value. claude-web-engine: the
   * `ultracode` flag setting (every model; `--ultracode` when the process restarts). The official binary: only
   * `/effort ultracode` in the conversation. Turning it off restores the rung.
   */
  async setUltracode(on: boolean) {
    this.info.ultracode = on;
    this.ultracodeFirst = false; // the command below says it now
    this.emit('info', this.info);
    if (this.info.runtime === 'ccb') {
      try {
        await this.q?.applyFlagSettings({ ultracode: on } as any);
      } catch {
        await this.respawnWhenIdle();
      }
      return;
    }
    this.send(`/effort ${on ? 'ultracode' : this.effort ?? 'high'}`);
  }

  /**
   * The model subagents run on ('' = the main model). An environment variable read once at start: another process,
   * resuming this conversation (mid-turn: once the turn is done — subagents already out keep theirs).
   */
  async setSubagentModel(model: string) {
    this.subagent = model;
    if (model) this.info.subagentModel = model;
    else delete this.info.subagentModel;
    this.emit('info', this.info);
    if (this.plan().key !== this.planKey) await this.respawnWhenIdle();
  }

  private thinkingLanguageSection(): string {
    return thinkingLanguagePrompt(thinkingLanguageFor(this.ownThinkingLanguage, thinkingLanguageSetting, getLocale()));
  }

  /**
   * 思考用的语言 changed — this conversation's pick (`own`), or the setting / the interface language (no argument): the
   * system prompt is read once at start, so another process, resuming this conversation, once the turn is done. Nothing
   * restarts when the instruction comes out the same.
   */
  async refreshThinkingLanguage(own?: string) {
    if (own !== undefined) this.ownThinkingLanguage = own;
    if (this.closed || this.thinkingLanguageSection() === this.thinkingSection) return;
    await this.respawnWhenIdle();
  }

  /**
   * Its provider was saved in settings (a context window, a key, the model map…): read once at start, so the next
   * process starts with it — once the turn is done. 2026-10-19: a window set to 1M did nothing to the conversation
   * already compacting every two minutes on the old one.
   */
  async reprovide(p: SessionProvider | undefined) {
    // another Claude account is a profile too (its token, its 200K / 1M picks and 自动压缩 point: A7)
    const cur = this.provider ?? this.account;
    if (!p || !cur || p.id !== cur.id || (p.type === 'claude-account') !== !!this.account) return;
    const changed = JSON.stringify({ ...cur, modelsAt: 0 }) !== JSON.stringify({ ...p, modelsAt: 0 });
    if (this.account) {
      // its 200K / 1M picks may shrink the current model's window: as for the own login's (setAccountPrefs), the
      // conversation is compacted on the current window first, mid-turn once the turn is over (final review I2); the
      // latest save wins
      const seq = ++this.prefsSeq;
      this.deferredChange = null;
      if (changed && !(await this.fitForShrink(seq, accountWindowOf(this.model, familyWindows(p.contextWindows)), () => this.reprovide(p)))) return;
      this.account = p;
    }
    else this.provider = p;
    this.noteWindow();
    if (changed) await this.respawnWhenIdle();
  }

  /**
   * A change that would take the current model's window to `then` (the account's 200K / 1M picks: setAccountPrefs; a
   * claude-account profile saved: reprovide). When it shrinks: mid-turn the change waits for the turn's end (`redo`
   * runs then, from ingest), idle the conversation is compacted on the current window first (fitBeforeSwitch).
   * Whether the caller goes on now — not when it waits, or a later change (`seq`) took over meanwhile.
   */
  private async fitForShrink(seq: number, then: number | undefined, redo: () => Promise<void>): Promise<boolean> {
    const now = this.windowOf(this.model);
    if (!then || (now && then >= now)) return true;
    if (this.busy()) { this.deferredChange = redo; return false; }
    await this.fitBeforeSwitch(this.model ?? '', then);
    return seq === this.prefsSeq && !this.closed;
  }

  /** The subagents' model as the engine is given it, when it is one of this conversation's own provider / account. */
  private subEngineModel(kind: string | undefined): string | undefined {
    const t = subagentTarget(this.subagent, this.provider?.id ?? this.account?.id);
    return t?.kind === 'same' ? this.engineModel(kind, t.model) : undefined;
  }

  /**
   * The own login's 200K / 1M picks or 自动压缩 point changed in settings (the pool passes them on, A7). The compaction
   * point is an environment variable and in the plan key: another process once idle. Only the main model's name
   * changing (`[1m]` on or off): switched in the process like a model pick, another process if the engine cannot.
   */
  async setAccountPrefs(p: AccountPrefs) {
    if (this.provider || this.account || this.closed) return;
    const next: AccountPrefs = { windows: familyWindows(p.windows), ...(typeof p.compactAt === 'number' ? { compactAt: p.compactAt } : {}) };
    // the latest call wins: one waiting for its compaction, or deferred to the end of a turn, gives way
    const seq = ++this.prefsSeq;
    this.deferredChange = null;
    if (JSON.stringify(next) === JSON.stringify(this.accountPrefs)) return;
    // the current model's window shrinking (Opus 1M → 200K at 500K): as for a model switch (fitBeforeSwitch), the
    // conversation is compacted on the current window first. Mid-turn that cannot happen: the whole change waits for
    // the turn's end (ingest), and the fit runs then, before the new window takes effect
    if (!(await this.fitForShrink(seq, this.windowOf(this.model, next), () => this.setAccountPrefs(next)))) return;
    const kind = this.info.runtime;
    const before = { main: this.engineModel(kind, this.model), sub: this.subEngineModel(kind) };
    this.accountPrefs = next;
    this.noteWindow();
    if (this.plan().key !== this.planKey || this.subEngineModel(kind) !== before.sub) { await this.respawnWhenIdle(); return; }
    const main = this.engineModel(kind, this.model);
    if (main === before.main) return;
    try {
      await this.q?.setModel(main);
    } catch {
      // a later call took over while this one waited (it restarted, or will): a restart from here would be a second
      // process next to that one's (final review I1)
      if (seq === this.prefsSeq && !this.closed) await this.respawnWhenIdle();
    }
  }

  /** Set by the pool: a model of this conversation's provider refused its native thinking-strength parameter. */
  onPromptOnly?: (providerId: string, model: string) => void;

  /** The engine's `cw_capability`: the model gets the strength through the prompt from now on (and next time). */
  private promptOnly(model: string) {
    if (this.provider) {
      const list = this.provider.promptEffortModels ?? [];
      if (!list.includes(model)) this.provider = { ...this.provider, promptEffortModels: [...list, model] };
      this.onPromptOnly?.(this.provider.id, model);
    }
    if (this.info.models) this.info.models = this.info.models.map((e) => (e.value === model ? { ...e, effortMode: 'prompt' } : e));
    this.emit('info', this.info);
  }

  private noteFast(state: 'off' | 'cooldown' | 'on', reason?: string) {
    if (this.info.fastMode === state && this.info.fastModeOff === reason) return;
    this.info.fastMode = state;
    if (reason) this.info.fastModeOff = reason;
    else delete this.info.fastModeOff;
    this.emit('info', this.info);
  }

  /** 快速模式 (phase 6 §4): a flag setting of the running process, like the effort level; the CLI says what it became. */
  async setFastMode(on: boolean) {
    await this.q?.applyFlagSettings({ fastMode: on });
    this.noteFast(on ? 'on' : 'off', this.info.fastModeOff);
  }

  /**
   * A rename while the process runs: it keeps the title in memory and writes it back into the transcript later, which
   * undid a rename made in the list (2026-10-17 user report). The official binary takes the new title (`rename_session`);
   * our engine does not know that request — the caller then keeps the name itself until the process ends.
   */
  async renameLive(title: string): Promise<boolean> {
    if (!this.q) return false;
    try { await (this.q as any).renameSession(title, this.sessionId); return true; } catch { return false; }
  }

  /** A connector on / off for this conversation (the + menu's 连接器 ›): the CLI's own switch, then its new list. */
  async toggleMcp(name: string, enabled: boolean) {
    if (!this.q) throw new Error(tr('对话没在运行，连接器要在它运行时才能开关'));
    await this.q.toggleMcpServer(name, enabled);
    const mcp = await this.q.mcpServerStatus().catch(() => null);
    if (mcp) {
      this.info.mcpServers = mcp.map((m) => ({ name: m.name, status: m.status, error: m.error, tools: m.tools }));
      this.emit('info', this.info);
    }
  }

  async stopTask(taskId: string) {
    await (this.q as any)?.stopTask?.(taskId);
  }

  async contextUsage(detail: 'summary' | 'full' = 'summary') {
    return (this.q as any)?.getContextUsage?.({ detail });
  }

  /**
   * Kill the process and start a new one resuming the same session. One at a time: a call while one is under way
   * joins it — that one starts its process last, with whatever this conversation is set to by then (final review I1:
   * two restarts at once left two engine processes).
   */
  respawn(): Promise<void> {
    if (this.respawnRun) return this.respawnRun;
    const run = this.respawnNow();
    this.respawnRun = run;
    return run;
  }
  /** the respawn() under way (cleared as its new process starts) */
  private respawnRun: Promise<void> | null = null;

  private async respawnNow() {
    this.respawning = true;
    try {
      const old = this.q;
      this.q = null; // detach first: the old pump sees it was replaced and doesn't report 'closed'
      this.input.close();
      this.input = new InputQueue();
      this.abort.abort();
      this.abort = new AbortController();
      const oldChild = this.child;
      try {
        await old?.return(undefined);
      } catch {
        /* ignore */
      }
      await this.endProcess(oldChild);
      const repair = this.beforeRestart;
      this.beforeRestart = null;
      if (this.closed) return; // closed while the old process was shutting down: don't spawn an orphan
      try { repair?.(); } catch { /* the next resume repairs what it can */ }
      this.bgLive.clear(); // the old process's background went with it
      this.setState('starting');
      this.start(this.hasTranscript ? { resume: this.sessionId, extraArgs: { ...this.extraArgs } } : { sessionId: this.sessionId, extraArgs: { ...this.extraArgs } });
    } finally {
      this.respawning = false;
      this.respawnRun = null;
    }
  }

  async close() {
    this.closed = true;
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'session closed' });
      this.emit('permissionResolved', id);
    }
    this.pending.clear();
    this.input.close();
    this.abort.abort();
    const child = this.child;
    try {
      await this.q?.return(undefined);
    } catch {
      /* ignore */
    }
    await this.endProcess(child);
    this.nextFlag?.dispose(); // never spawned
    this.nextFlag = null;
    this.setState('closed');
    this.removeAllListeners();
  }
}
