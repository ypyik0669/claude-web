import { query, type Query, type SDKMessage, type SDKUserMessage, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { withExplanation } from '../errors/explain.js';
import { findClaudeTranscript, hasClaudeTranscript, hasEntry, lastCostState, lastHumanPrompt, repairLeaf } from './transcript-file.js';
import { settingsOverride, userAnthropicEnv } from './user-env.js';
import { writeFlagSettings, type FlagSettings } from './flag-settings.js';
import { resolveEngine, spawnClaude } from '../claude-exe.js';
import { loopbackNoProxy, providerEnv, type SessionProvider } from '../providers/service.js';
import { ccbAccountEnv, ccbMisthinks, ccbModel, isChatModel, modelCaps, modelLabel, modelsFor, preferredRuntime, providerModelId, supportsUltracode, webCapsEnv } from '../models/catalog.js';
import { turnShare, type RunningTotals } from '../usage/turn-cost.js';
import { claudeMcpServer } from '../memory/launcher.js';
import { markUnknownCost } from '../usage/pricing.js';
import type { AttachmentRef, EffortLevel, ModelInfo, OpenSessionParams, PermissionMode, PermissionRequestEvent, PermissionResponse, Provider, RunnerState, SessionFeatures, SessionInfoSnapshot } from '../protocol.js';

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

/**
 * A conversation whose folder is gone (moved, renamed, deleted, a drive not mounted): Windows reports the spawn as
 * ENOENT on the executable and the SDK words it "Claude Code executable at … exists but failed to launch" — say what it is.
 */
export function missingCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  try {
    if (statSync(cwd).isDirectory()) return undefined;
    return `对话的项目文件夹不是一个文件夹：${cwd}。在输入框左下角换一个项目文件夹，新开对话。`;
  } catch {
    return `找不到这个对话的项目文件夹：${cwd}（可能被移动、改名或删除了）。在输入框左下角换一个存在的项目文件夹，新开对话；或者把文件夹放回原处。`;
  }
}

/** Why a message was not taken (shown as the window's toast and on the conversation): the reason the process died, and what to do. */
export function sendRefused(failed: boolean, reason?: string): string {
  if (!failed) return '这个对话的进程已经关闭。再发一次会重新打开它。';
  // the folder is gone: the provider is fine, and resending fails the same way (missingCwd says what to do)
  if (reason?.includes('项目文件夹')) return `这个对话的进程没能启动：${reason}`;
  // the reason is explained already (withExplanation: a Chinese line, then the original), so the advice goes after it
  return `这个对话的进程出错退出了${reason ? `：${reason}` : '。'}\n再发一次会重新打开它；还是不行的话，到 设置 → 供应商 点「测试连接」看看。`;
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
export class SessionRunner extends EventEmitter {
  readonly id: string; // sessionId (known up front for resume; assigned from init otherwise)
  sessionId: string;
  state: RunnerState = 'starting';
  cwd: string;
  private q: Query | null = null;
  private input = new InputQueue();
  private abort = new AbortController();
  private pending = new Map<string, PendingPermission>();
  private history: SDKMessage[] = []; // messages since spawn, replayed to late-joining clients
  info: SessionInfoSnapshot;
  private model?: string;
  private effort?: EffortLevel;
  private permissionMode: PermissionMode;
  private provider?: SessionProvider; // resolved third-party profile (undefined = claude.ai login)
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

  constructor(params: OpenSessionParams, provider?: SessionProvider) {
    super();
    this.cwd = params.cwd;
    this.provider = provider;
    this.features = params.features ?? {};
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
    this.info = { sessionId: this.sessionId, state: 'starting', cwd: this.cwd, model: this.model, effort: this.effort, permissionMode: this.permissionMode, providerId: provider?.id, providerName: provider?.name, features: this.features, agent: 'claude' };
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
    if (f.computerUse) a['computer-use-mcp'] = null;
    if (f.proactive) a.proactive = null;
    if (f.brief) a.brief = null;
    if (f.channels?.length) a.channels = f.channels.join(',');
    if (f.devChannels) a['dangerously-load-development-channels'] = null;
    return a;
  }

  private featureEnv(): Record<string, string> {
    const f = this.features;
    const env: Record<string, string> = { ...(this.provider ? providerEnv(this.provider, 'claude', { sessionKey: this.cacheKey, sessionId: this.ledgerId }) : {}), ...(f.env ?? {}) };
    if (f.coordinator) env.CLAUDE_CODE_COORDINATOR_MODE = '1';
    return env;
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
    const supportsEffort = onOurs || c.native;
    return { value, displayName, description, supportsEffort, supportedEffortLevels: supportsEffort ? levels : [], effortMode: c.native ? 'native' : 'prompt' };
  }

  /**
   * The engine a process for `model` runs on. A provider's Anthropic-format endpoint and a Claude 5 model ccb gets the
   * thinking wrong for (`ccbMisthinks`) → the official binary — unless this conversation uses a flag only ccb has
   * (the official one refuses `--proactive` / `--computer-use-mcp` as unknown options); then ccb, with thinking off
   * for that model (`omit thinking` is what the API asks for).
   */
  private plan(model = this.model) {
    const ccbOnly = !!(this.features.proactive || this.features.computerUse || this.features.devChannels);
    // the account through a relay of the user's own (settings.json / environment) is an Anthropic-format relay too;
    // claude.ai itself takes the budget ccb sends (the ledger has Opus 5.5 turns on ccb)
    const own = this.provider ? null : userAnthropicEnv();
    // …and it runs on the official binary: a relay checking the client (super-nb) refuses ccb's requests, and the
    // account has no 测试连接 that could have found that out and pinned it (2026-10-02, real relays)
    const relay = this.provider ?? (own!.relay ? { type: 'anthropic' as const, runtime: ccbOnly ? undefined : ('claude' as const), defaultModel: own!.env.ANTHROPIC_MODEL, modelMap: { opus: own!.env.ANTHROPIC_DEFAULT_OPUS_MODEL, sonnet: own!.env.ANTHROPIC_DEFAULT_SONNET_MODEL, haiku: own!.env.ANTHROPIC_DEFAULT_HAIKU_MODEL } } : undefined);
    const engine = resolveEngine(relay ? preferredRuntime(relay, ccbOnly ? undefined : model ?? '') : undefined);
    const anthropicWire = relay?.type === 'anthropic' || relay?.type === 'gateway';
    const noThinking = engine.kind === 'ccb' && anthropicWire && ccbMisthinks(providerModelId(relay!, model ?? ''));
    return { engine, noThinking, key: `${engine.kind}${noThinking ? ':no-thinking' : ''}` };
  }

  private start(extra: Partial<Options>) {
    const { engine, noThinking, key } = this.plan();
    this.planKey = key;
    // ultracode on: a restarted claude-web-engine process starts with it (`--ultracode`)
    const args = { ...(extra.extraArgs ?? {}) };
    if (engine.kind === 'ccb' && this.info.ultracode) args.ultracode = null;
    else delete args.ultracode;
    extra = { ...extra, extraArgs: args };
    // the transcript both engines share: the official binary resumes at its last recorded leaf (repair it after turns
    // on ccb) and continues the cost totals it saved; ccb starts every process from zero
    const resumeId = typeof extra.resume === 'string' ? extra.resume : undefined;
    const file = resumeId ? findClaudeTranscript(resumeId) : null;
    if (engine.kind === 'claude' && resumeId && !extra.forkSession) repairLeaf(file, resumeId);
    const saved = engine.kind === 'claude' && resumeId ? lastCostState(file, resumeId) : null;
    this.totals = saved ? { cost: saved.cost, models: saved.models } : { cost: 0, models: {} };
    const onDisk = lastHumanPrompt(file);
    if (onDisk) this.known.add(onDisk);
    const exe = engine.file;
    this.info.runtime = engine.kind;
    const fenv = this.featureEnv();
    if (noThinking && !('CLAUDE_CODE_DISABLE_THINKING' in fenv)) fenv.CLAUDE_CODE_DISABLE_THINKING = '1';
    // what each of the provider's models can do with thinking strength (claude-web-engine reads it: levels, whether it
    // reasons, models recorded as refusing the native parameter); the official binary ignores it
    if (engine.kind === 'ccb' && this.provider) {
      fenv.CLAUDE_WEB_MODEL_CAPS = webCapsEnv(this.provider, [...(this.provider.models ?? []), providerModelId(this.provider, this.model)]);
    }
    // a claude.ai-login session on the bundled ccb: its alias table predates the Claude 5 family (see
    // OFFICIAL_ALIAS_TARGETS) — the CLI's own variables align it with the official one; the user's env / settings win.
    // Not for a relay the user set up in settings.json / the environment: its model list is its own (the injected
    // claude-sonnet-5 default hung 220 s on model_not_found, 2026-10-01)
    const own = userAnthropicEnv();
    if (engine.kind === 'ccb' && !this.provider && !own.relay) for (const [k, v] of Object.entries(ccbAccountEnv())) if (!(k in fenv) && !(own.env as Record<string, string | undefined>)[k]) fenv[k] = v;
    // a provider session must not inherit provider-ish env from this process (e.g. a global ANTHROPIC_API_KEY)
    const base = { ...process.env };
    // …including a stray CLAUDE_CODE_USE_* switch, which would route the profile to another ccb provider
    if (this.provider) for (const k of Object.keys(base)) if (/^((ANTHROPIC|OPENAI|GEMINI|GROK|XAI)_|CLAUDE_CODE_USE_)/.test(k) && !(k in fenv)) delete base[k];
    const env = Object.keys(fenv).length ? { ...base, ...fenv } : undefined;
    // the cache shim / model gateway live on 127.0.0.1: an HTTP(S)_PROXY from the user's environment must not carry
    // those requests off to a proxy (a remote one cannot reach our loopback, and the turn just hangs)
    if (env) Object.assign(env, loopbackNoProxy(env));
    // a provider conversation: what the user's settings files would lay over the provider's env goes back on top
    // through the flag tier (`settingsOverride`)
    this.nextFlag?.dispose();
    this.nextFlag = null;
    const override = this.provider ? settingsOverride(fenv, this.cwd) : null;
    if (override) {
      try {
        this.nextFlag = writeFlagSettings(override);
      } catch (e) {
        console.warn(`[session ${this.sessionId.slice(0, 8)}] could not write the --settings file (the user's settings.json env stays on top): ${(e as Error).message}`);
      }
    }
    const options: Options = {
      cwd: this.cwd,
      env,
      model: engine.kind === 'ccb' ? ccbModel(this.model) : this.model,
      // `ultra` is Codex-only; the Claude SDK's ladder tops out at max
      effort: this.effort === 'ultra' ? 'max' : this.effort,
      permissionMode: this.permissionMode,
      // The SDK defaults to an EMPTY system prompt. We want the real Claude Code prompt: same behaviour as the
      // CLI, and relays that fingerprint Claude Code requests (e.g. super-nb) reject bodies without it.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Shared cross-agent memory, injected per session rather than written into ~/.claude —
      // uninstalling claude-web must not leave an MCP entry behind in the user's own config.
      mcpServers: claudeMcpServer({ cwd: this.cwd, sessionId: this.sessionId, agent: 'claude' }),
      includePartialMessages: true,
      includeHookEvents: true,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      settingSources: ['user', 'project', 'local'],
      ...(this.nextFlag ? { settings: this.nextFlag.file } : {}),
      pathToClaudeCodeExecutable: exe,
      spawnClaudeCodeProcess: ((o: Parameters<typeof spawnClaude>[0]) => this.spawnProcess(o)) as Options['spawnClaudeCodeProcess'],
      abortController: this.abort,
      allowDangerouslySkipPermissions: true,
      canUseTool: (toolName, input, o) => this.onCanUseTool(toolName, input, o),
      ...extra,
    };
    this.q = query({ prompt: this.input, options });
    void this.pump();
  }

  /**
   * The SDK reads the CLI's stderr only with its own spawn, so with ours it went nowhere: every failure was just
   * "exited with code 1" (the cause — ccb's "unknown option '--session-mirror'" — was one stderr line), and a pipe nobody
   * reads can fill and stall the CLI. Read it, log it, keep its end for the error message.
   */
  private spawnProcess(o: Parameters<typeof spawnClaude>[0]) {
    const child = spawnClaude(o);
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
   * "Session ID … already in use". Give it a moment to finish writing the transcript, then make sure it is gone.
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
    try { child.kill(); } catch { /* already gone */ }
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
        const raw = String(e?.message ?? e) + (said && !String(e?.message ?? e).includes(said) ? `（CLI 输出：${said}）` : '');
        const gone = missingCwd(this.cwd);
        this.setState('error', gone ? `${gone}\n原文：${raw}` : withExplanation(raw));
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
      turnShare(m as any, this.totals); // the CLI reports running totals; everything downstream adds turns up
      // ccb prices every model with Claude's table: for other vendors' models the number is fiction
      markUnknownCost(m as any, this.provider?.type);
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
    if (m.type === 'result' && this.respawnPending && !this.closed) {
      this.respawnPending = false;
      void this.respawn();
    }
  }

  /** Restart the process now, or — mid-turn — once the turn's result is in (a restart would cut the turn off). */
  private respawnWhenIdle(): Promise<void> {
    if (this.busy()) { this.respawnPending = true; return Promise.resolve(); }
    return this.respawn();
  }

  private onCanUseTool(toolName: string, input: Record<string, unknown>, o: { signal: AbortSignal; suggestions?: unknown[]; toolUseID?: string; blockedPath?: string; decisionReason?: string }): Promise<PermissionResult> {
    const requestId = randomUUID();
    const event: PermissionRequestEvent = { requestId, sessionId: this.sessionId, toolName, input, toolUseId: o.toolUseID, suggestions: o.suggestions, blockedPath: o.blockedPath, decisionReason: o.decisionReason };
    if (o.signal.aborted) return Promise.resolve({ behavior: 'deny', message: 'cancelled' });
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { event, resolve });
      o.signal.addEventListener('abort', () => {
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
    p.resolve(r as PermissionResult);
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
    content.push({ type: 'text', text });
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
   * Stop always stops. The CLI normally answers the interrupt with a `result`; one stuck on a request that never
   * returns (or anywhere it no longer reads its control channel) would leave the conversation "thinking" for good —
   * after the grace period the turn is ended here and the process restarted on the same conversation.
   */
  async interrupt() {
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
    await this.forceStop(q);
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

  private busy() {
    return this.state === 'running' || this.state === 'waiting';
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

  /** End the turn with a result of our own (the reducer, the ledger and the UI finish it like any other), then restart. */
  private async forceStop(q: Query) {
    if (this.closed || this.q !== q) return;
    const reason = '已强制停止：运行内核没有响应中断，已结束它的进程并重新接上这个对话';
    this.ingest({
      type: 'result', subtype: 'error_during_execution', is_error: true, result: reason, errors: [reason], terminal_reason: 'aborted_forced',
      duration_ms: 0, duration_api_ms: 0, num_turns: 0, total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: {}, permission_denials: [], session_id: this.sessionId, uuid: randomUUID(),
    } as unknown as SDKMessage);
    await this.respawn();
  }

  async setPermissionMode(mode: PermissionMode) {
    await this.q?.setPermissionMode(mode);
    this.permissionMode = mode;
    this.info.permissionMode = mode;
    this.emit('info', this.info);
  }

  async setModel(model: string) {
    // the model can decide the engine (see plan()): crossing over means another process, resuming this conversation
    if (this.plan(model).key !== this.planKey) {
      this.model = model;
      this.info.model = model;
      this.emit('info', this.info);
      await this.respawnWhenIdle();
      return;
    }
    try {
      await this.q?.setModel(this.info.runtime === 'ccb' ? ccbModel(model) : model);
      this.model = model;
      this.info.model = model;
      this.emit('info', this.info);
    } catch (e) {
      // fall back to respawn with resume
      this.model = model;
      this.info.model = model;
      this.emit('info', this.info);
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

  async stopTask(taskId: string) {
    await (this.q as any)?.stopTask?.(taskId);
  }

  async contextUsage(detail: 'summary' | 'full' = 'summary') {
    return (this.q as any)?.getContextUsage?.({ detail });
  }

  /** Kill the process and start a new one resuming the same session. */
  async respawn() {
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
    if (this.closed) return; // closed while the old process was shutting down: don't spawn an orphan
    this.setState('starting');
    this.start(this.hasTranscript ? { resume: this.sessionId, extraArgs: { ...this.extraArgs } } : { sessionId: this.sessionId, extraArgs: { ...this.extraArgs } });
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
