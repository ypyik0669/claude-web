import { query, type Query, type SDKMessage, type SDKUserMessage, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolveClaudeExe, spawnClaude } from '../claude-exe.js';
import type { EffortLevel, OpenSessionParams, PermissionMode, PermissionRequestEvent, PermissionResponse, RunnerState, SessionInfoSnapshot } from '../protocol.js';

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
  lastActivity = Date.now();
  private closed = false;

  constructor(params: OpenSessionParams) {
    super();
    this.cwd = params.cwd;
    // a fork gets its own id from the CLI at init; until then use a placeholder so the pool
    // never clobbers the source session's runner
    const isFork = !!params.sessionId && (params.fork || !!params.resumeAt);
    this.sessionId = params.sessionId && !isFork ? params.sessionId : randomUUID();
    this.id = this.sessionId;
    this.model = params.model;
    this.effort = params.effort;
    this.permissionMode = params.permissionMode ?? 'default';
    this.info = { sessionId: this.sessionId, state: 'starting', cwd: this.cwd, model: this.model, effort: this.effort, permissionMode: this.permissionMode };
    const extra: Partial<Options> = params.sessionId ? { resume: params.sessionId, forkSession: params.fork || !!params.resumeAt, resumeSessionAt: params.resumeAt } : { sessionId: this.sessionId };
    if (params.worktree) extra.extraArgs = { worktree: params.worktree };
    this.start(extra);
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
    const exe = resolveClaudeExe();
    const options: Options = {
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      permissionMode: this.permissionMode,
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
          this.info.slashCommands = cmds.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }));
          this.info.models = models.map((m) => ({ value: m.value, displayName: m.displayName, description: m.description, supportsEffort: m.supportsEffort, supportedEffortLevels: m.supportedEffortLevels }));
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
        this.lastActivity = Date.now();
        this.ingest(m);
      }
      if (!this.closed) this.setState('closed');
    } catch (e: any) {
      if (!this.closed) this.setState('error', e?.message ?? String(e));
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
    if (m.type === 'result') this.setState('idle');
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
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { event, resolve });
      o.signal.addEventListener('abort', () => {
        if (this.pending.delete(requestId)) {
          resolve({ behavior: 'deny', message: 'cancelled' });
          this.emit('permissionResolved', requestId);
        }
      });
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

  send(text: string, images?: { mediaType: string; data: string }[], steer = false) {
    const content: any[] = [];
    for (const im of images ?? []) content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } });
    content.push({ type: 'text', text });
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: images?.length ? content : text },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      origin: { kind: 'human' },
      ...(steer ? { priority: 'now' } : {}),
    } as SDKUserMessage;
    this.lastActivity = Date.now();
    this.setState('running');
    this.input.push(msg);
  }

  async interrupt() {
    // deny any pending permission first so the turn can unwind
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.resolve({ behavior: 'deny', message: 'interrupted by user', interrupt: true });
      this.emit('permissionResolved', id);
    }
    await this.q?.interrupt();
  }

  async setPermissionMode(mode: PermissionMode) {
    await this.q?.setPermissionMode(mode);
    this.permissionMode = mode;
    this.info.permissionMode = mode;
    this.emit('info', this.info);
  }

  async setModel(model: string) {
    try {
      await this.q?.setModel(model);
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
    // No runtime control for effort: send the slash command through the conversation.
    this.send(`/effort ${effort}`);
  }

  async stopTask(taskId: string) {
    await (this.q as any)?.stopTask?.(taskId);
  }

  async contextUsage() {
    return (this.q as any)?.getContextUsage?.();
  }

  /** Kill the process and start a new one resuming the same session. */
  async respawn() {
    const old = this.q;
    this.input.close();
    this.input = new InputQueue();
    this.abort.abort();
    this.abort = new AbortController();
    try {
      await old?.return(undefined);
    } catch {
      /* ignore */
    }
    this.setState('starting');
    this.start({ resume: this.sessionId });
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
