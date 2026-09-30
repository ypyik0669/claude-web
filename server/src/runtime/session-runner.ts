import { query, type Query, type SDKMessage, type SDKUserMessage, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolveEngine, spawnClaude } from '../claude-exe.js';
import { loopbackNoProxy, providerEnv, type SessionProvider } from '../providers/service.js';
import { ccbAccountEnv, ccbModel, effortLevels, modelLabel, modelsFor, preferredRuntime, supportsUltracode } from '../models/catalog.js';
import { claudeMcpServer } from '../memory/launcher.js';
import { markUnknownCost } from '../usage/pricing.js';
import type { AttachmentRef, EffortLevel, OpenSessionParams, PermissionMode, PermissionRequestEvent, PermissionResponse, Provider, RunnerState, SessionFeatures, SessionInfoSnapshot } from '../protocol.js';

const esc = (s: string) => s.replace(/"/g, '&quot;');

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
    const extra: Partial<Options> = params.sessionId ? { resume: params.sessionId, forkSession: params.fork || !!params.resumeAt, resumeSessionAt: params.resumeAt } : { sessionId: this.sessionId };
    // Handover from another agent: Claude has no JSONL for this id, so feed it synthesized entries
    // through the documented SessionStore hook — the SDK materializes them to a temp transcript the
    // subprocess resumes from natively. `persistSession: false` is incompatible with sessionStore.
    if (params.resumeEntries?.length) {
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
    this.emit('state', s, error);
  }

  private start(extra: Partial<Options>) {
    const engine = resolveEngine(this.provider ? preferredRuntime(this.provider) : undefined);
    const exe = engine.file;
    this.info.runtime = engine.kind;
    const fenv = this.featureEnv();
    // a claude.ai-login session on the bundled ccb: its alias table predates the Claude 5 family (see
    // OFFICIAL_ALIAS_TARGETS) — the CLI's own variables align it with the official one; the user's env / settings win
    if (engine.kind === 'ccb' && !this.provider) for (const [k, v] of Object.entries(ccbAccountEnv())) if (!(k in fenv) && !process.env[k]) fenv[k] = v;
    // a provider session must not inherit provider-ish env from this process (e.g. a global ANTHROPIC_API_KEY)
    const base = { ...process.env };
    // …including a stray CLAUDE_CODE_USE_* switch, which would route the profile to another ccb provider
    if (this.provider) for (const k of Object.keys(base)) if (/^((ANTHROPIC|OPENAI|GEMINI|GROK|XAI)_|CLAUDE_CODE_USE_)/.test(k) && !(k in fenv)) delete base[k];
    const env = Object.keys(fenv).length ? { ...base, ...fenv } : undefined;
    // the cache shim / model gateway live on 127.0.0.1: an HTTP(S)_PROXY from the user's environment must not carry
    // those requests off to a proxy (a remote one cannot reach our loopback, and the turn just hangs)
    if (env) Object.assign(env, loopbackNoProxy(env));
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
      pathToClaudeCodeExecutable: exe,
      spawnClaudeCodeProcess: spawnClaude as Options['spawnClaudeCodeProcess'],
      abortController: this.abort,
      allowDangerouslySkipPermissions: true,
      canUseTool: (toolName, input, o) => this.onCanUseTool(toolName, input, o),
      stderr: (s) => process.stderr.write(`[claude ${this.sessionId.slice(0, 8)}] ${s}`),
      ...extra,
    };
    this.q = query({ prompt: this.input, options });
    void this.pump();
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
          // The CLI's own list wins; the catalog only supplies the versioned display name
          // ("Fable 5.1", not "Fable") and the per-model effort range when the CLI omits them.
          this.info.models = this.provider?.models?.length
            ? this.provider.models.map((v) => ({ value: v, displayName: modelLabel('claude', v), description: this.provider!.name, supportsEffort: true, supportedEffortLevels: effortLevels('claude', v) }))
            : modelSrc.length
              ? modelSrc.map((m) => ({ value: m.value, displayName: m.displayName && m.displayName !== m.value ? m.displayName : modelLabel('claude', m.value), description: m.description ?? '', supportsEffort: m.supportsEffort ?? true, supportedEffortLevels: m.supportedEffortLevels?.length ? m.supportedEffortLevels : effortLevels('claude', m.value) }))
              : modelsFor('claude');
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
      if (!this.closed && this.q === q) this.setState('error', e?.message ?? String(e));
    }
  }

  private ingest(m: SDKMessage) {
    if (m.type === 'system' && m.subtype === 'init') {
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
        state: 'idle',
      };
      this.emit('info', this.info);
      this.setState('idle');
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
    if (this.closed || this.state === 'closed' || this.state === 'error') throw new Error(`session ${this.sessionId} is ${this.closed ? 'closed' : this.state}; reopen it to continue`);
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
    try {
      await this.q?.setModel(this.info.runtime === 'ccb' ? ccbModel(model) : model);
      this.model = model;
      this.info.model = model;
      this.emit('info', this.info);
    } catch (e) {
      // fall back to respawn with resume
      this.model = model;
      await this.respawn();
    }
  }

  async setEffort(effort: EffortLevel) {
    this.effort = effort;
    this.info.effort = effort;
    if (this.info.ultracode) this.info.ultracode = false; // picking a rung leaves ultracode
    // No runtime control for effort: send the slash command through the conversation.
    this.send(`/effort ${effort}`);
  }

  /**
   * ultracode = xhigh + dynamic workflow orchestration, session-scoped. It is NOT an effort value:
   * `CLAUDE_CODE_EFFORT_LEVEL` rejects it and settings.json carries it as its own boolean, so it can
   * only be reached through `/effort ultracode` in the conversation. Turning it off restores the rung.
   */
  async setUltracode(on: boolean) {
    this.info.ultracode = on;
    this.send(`/effort ${on ? 'ultracode' : this.effort ?? 'high'}`);
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
    try {
      await old?.return(undefined);
    } catch {
      /* ignore */
    }
    if (this.closed) return; // closed while the old process was shutting down: don't spawn an orphan
    this.setState('starting');
    this.start({ resume: this.sessionId, extraArgs: { ...this.extraArgs } });
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
    try {
      await this.q?.return(undefined);
    } catch {
      /* ignore */
    }
    this.setState('closed');
    this.removeAllListeners();
  }
}
