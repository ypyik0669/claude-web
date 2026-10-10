import { EventEmitter } from 'node:events';
import { modelLabel, modelsFor } from '../models/catalog.js';
import { randomUUID } from 'node:crypto';
import type { AgentKind, AttachmentRef, EffortLevel, OpenSessionParams, PermissionMode, PermissionRequestEvent, PermissionResponse, RunnerState, SessionInfoSnapshot } from '../protocol.js';
import { JsonRpcProcess } from './jsonrpc.js';
import { insertCodexConfig } from '../memory/launcher.js';
import { insertWebCodexConfig } from '../web/launcher.js';
import { MessageSynth } from './normalize.js';
import { codexItemMessages, type CodexItemState } from './codex-items.js';
import type { AgentTranscripts } from './transcript.js';
import { CODEX_KEY_ENV } from '../gateway/agents.js';
import { CodexUsageMeter } from './codex-usage.js';
import type { AgentDriver } from './types.js';

interface PendingPerm { event: PermissionRequestEvent; resolve: (r: any) => void; kind: 'command' | 'file' | 'permissions' }

// Codex's own ladder, verbatim: low | medium | high | xhigh | max | ultra. `max` and `ultra` are real
// members here (unlike Claude, where the top rung is a separate ultracode flag).
/** How long a resume waits for the mirror to take in the Codex CLI's turns before going ahead anyway. */
const MIRROR_SYNC_MS = 20_000;
const EFFORT_MAP: Record<EffortLevel, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'ultra' };

/**
 * OpenAI Codex via `codex app-server` (JSON-RPC v2 over stdio): thread/start|resume → turn/start,
 * item/* notifications → SDK-shaped messages, approval requests → permission events.
 */
export class CodexDriver extends EventEmitter implements AgentDriver {
  readonly id: string;
  sessionId: string;
  state: RunnerState = 'starting';
  cwd: string;
  info: SessionInfoSnapshot;
  lastActivity = Date.now();
  private rpc: JsonRpcProcess | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private synth: MessageSynth;
  private history: unknown[] = [];
  private pending = new Map<string, PendingPerm>();
  private items: CodexItemState = new Map();
  private turnActive = false;
  private queue: { text: string; images?: { mediaType: string; data: string }[] }[] = [];
  private closed = false;
  private model?: string;
  private effort?: EffortLevel;
  private permissionMode: PermissionMode;
  /** per-turn usage from the cumulative thread totals (cached tokens are inside Codex's inputTokens) */
  private usage = new CodexUsageMeter();
  /** Resolves once the mirror is up to date for this start (`hooks.beforeResume` ran): prompts are recorded after it. */
  private mirrorReady: Promise<void>;
  private mirrorIsReady = false;
  private markMirrorReady!: () => void;

  /**
   * `hooks.beforeResume`: runs before a thread is resumed — the library brings the turns the Codex CLI added to the
   * thread into the mirror, so the prompt this driver records next lands after them, not in front.
   */
  constructor(private kind: AgentKind, private launch: { command: string; args: string[]; env: Record<string, string>; model?: string; name: string }, params: OpenSessionParams, private transcripts: AgentTranscripts, private hooks: { beforeResume?: () => Promise<unknown> } = {}) {
    super();
    this.mirrorReady = new Promise<void>((res) => { this.markMirrorReady = () => { this.mirrorIsReady = true; res(); }; });
    this.cwd = params.cwd;
    this.sessionId = params.sessionId ?? randomUUID();
    this.id = this.sessionId;
    this.model = params.model || launch.model;
    this.effort = params.effort;
    this.permissionMode = params.permissionMode ?? 'default';
    this.synth = new MessageSynth(this.sessionId, this.model ?? '');
    this.info = { sessionId: this.sessionId, state: 'starting', cwd: this.cwd, model: this.model, effort: this.effort, permissionMode: this.permissionMode, agent: kind, agentName: launch.name, runtime: 'ccb', slashCommands: [], models: [] };
    void this.start(params);
  }

  getHistory() { return this.history; }
  getPendingPermissions() { return [...this.pending.values()].map((p) => p.event); }
  private setState(s: RunnerState, error?: string) { this.state = s; this.info.state = s; if (error) this.info.error = error; this.emit('state', s, error); }
  private push(m: any) {
    this.lastActivity = Date.now();
    if (m.type !== 'stream_event') { this.history.push(m); if (this.history.length > 5000) this.history.splice(0, 1000); this.transcripts.append(this.sessionId, m); }
    this.emit('message', m);
  }
  private pushAll(ms: any[]) { for (const m of ms) this.push(m); }
  private record(m: any) { this.history.push(m); this.transcripts.append(this.sessionId, m); }

  /** Claude permission modes → codex approval / sandbox policy. */
  private policy(): { approvalPolicy: any; sandbox: string } {
    switch (this.permissionMode) {
      case 'bypassPermissions': return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
      case 'dontAsk': return { approvalPolicy: 'never', sandbox: 'workspace-write' };
      case 'acceptEdits': case 'auto': return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
      case 'plan': return { approvalPolicy: 'on-request', sandbox: 'read-only' };
      default: return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
    }
  }

  private async start(params: OpenSessionParams) {
    // a thread to resume: the mirror first takes in what the Codex CLI wrote to it meanwhile (alongside the app-server
    // starting; bounded, a slow read must not hold the conversation up)
    const prior = params.sessionId ? await this.transcripts.head(this.sessionId).catch(() => null) : null;
    const synced = prior?.nativeSessionId && this.hooks.beforeResume
      ? Promise.race([this.hooks.beforeResume().catch(() => {}), new Promise((r) => setTimeout(r, MIRROR_SYNC_MS).unref?.())])
      : Promise.resolve();
    void synced.then(() => this.markMirrorReady());
    try {
      // the shared memory store and 联网 (web search + the built-in browser), injected as `-c` overrides so
      // ~/.codex/config.toml is never touched
      const args = insertWebCodexConfig(insertCodexConfig(this.launch.args, { cwd: this.cwd, sessionId: this.sessionId, agent: this.kind }), { sessionId: this.sessionId });
      const rpc = new JsonRpcProcess(this.launch.command, args, { cwd: this.cwd, env: this.launch.env });
      this.rpc = rpc;
      rpc.on('exit', (code, err) => { if (!this.closed) this.setState('error', `Codex 退出（${code}）${err ? ` ${err}` : ''}\n${rpc.stderrTail.slice(-800)}`); });
      rpc.on('notification', (m, p) => this.onNotification(m, p));
      rpc.onRequest('item/commandExecution/requestApproval', (p) => this.onApproval('command', p));
      rpc.onRequest('item/fileChange/requestApproval', (p) => this.onApproval('file', p));
      rpc.onRequest('item/permissions/requestApproval', (p) => this.onApproval('permissions', p));
      rpc.onRequest('execCommandApproval', (p) => this.onApproval('command', p));
      rpc.onRequest('applyPatchApproval', (p) => this.onApproval('file', p));
      await rpc.request('initialize', { clientInfo: { name: 'claude-web', title: 'Claude Web', version: '0.1.0' }, capabilities: null }, 60_000);
      rpc.notify('initialized', {});
      const pol = this.policy();
      if (!(await this.transcripts.exists(this.sessionId))) await this.transcripts.create({ agent: this.kind, cwd: this.cwd, title: '', createdAt: Date.now(), sessionId: this.sessionId, model: this.model });
      const head = await this.transcripts.head(this.sessionId);
      let thread: any = null;
      if (params.sessionId && head?.nativeSessionId) {
        await synced;
        let resumed: any = null;
        try { resumed = await rpc.request('thread/resume', { threadId: head.nativeSessionId, cwd: this.cwd, model: this.model ?? null, approvalPolicy: pol.approvalPolicy, sandbox: pol.sandbox }, 120_000); thread = resumed.thread; } catch { thread = null; }
        if (!thread) this.push(this.synth.systemNote('Codex 线程无法恢复，已新开线程；上面的历史仅供查看。', 'warning'));
        // reopened without a model: the one the thread runs on (the chip and the ledger had none — model "")
        else if (!this.model) {
          const m = resumed?.model ?? head.model;
          if (m) { this.model = m; this.synth.setModel(m); this.info.model = m; }
        }
      }
      if (!thread) {
        const r = await rpc.request('thread/start', { cwd: this.cwd, model: this.model ?? null, approvalPolicy: pol.approvalPolicy, sandbox: pol.sandbox, sessionStartSource: null }, 120_000);
        thread = r.thread;
        if (!this.model && r.model) { this.model = r.model; this.synth.setModel(r.model); this.info.model = r.model; }
        await this.transcripts.patchHead(this.sessionId, { nativeSessionId: thread.id, model: this.model });
      }
      this.threadId = thread.id;
      let rawModels: any[] = [];
      try {
        const ml = await rpc.request('model/list', {}, 30_000);
        rawModels = ml?.data ?? [];
        const reported = (ml?.data ?? []).filter((m: any) => !m.hidden).map((m: any) => ({ value: m.model, displayName: m.displayName ?? modelLabel('codex', m.model), description: m.description ?? '', supportsEffort: (m.supportedReasoningEfforts ?? []).length > 0, supportedEffortLevels: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort ?? e).filter((e: any) => typeof e === 'string') }));
        this.info.models = reported.length ? reported : modelsFor('codex');
      } catch { /* optional */ }
      // config.toml may name a model this account cannot use (ChatGPT plans reject some ids) — prefer a listed one
      const listed = this.info.models ?? [];
      // (not for a gateway profile: the models behind the gateway are never in the ChatGPT account's list)
      const viaGateway = !!this.launch.env?.[CODEX_KEY_ENV];
      if (listed.length && this.model && !listed.some((m) => m.value === this.model) && !this.launch.model && !viaGateway) {
        const pick = rawModels.find((m: any) => m.isDefault && !m.hidden)?.model ?? listed[0].value;
        this.push(this.synth.systemNote(`Codex 配置里的模型 ${this.model} 不在可用列表，这个对话改用 ${pick}（可在模型菜单切换）。`, 'warning'));
        this.model = pick; this.synth.setModel(pick); this.info.model = pick;
        await this.transcripts.patchHead(this.sessionId, { model: pick });
      }
      this.push(this.synth.init({ cwd: this.cwd, permissionMode: this.permissionMode, version: 'codex', agent: this.kind }));
      this.setState('idle');
      this.emit('info', this.info);
      this.flush();
    } catch (e: any) {
      this.setState('error', `Codex 启动失败：${e.message}${this.rpc?.stderrTail ? `\n${this.rpc.stderrTail.slice(-800)}` : ''}`);
    }
  }

  private onNotification(method: string, p: any) {
    switch (method) {
      case 'turn/started': this.turnId = p?.turn?.id ?? null; break;
      case 'item/agentMessage/delta': this.pushAll(this.synth.delta('text', p.delta ?? '')); break;
      case 'account/rateLimits/updated': {
        const rl = p.rateLimits ?? {};
        const win = rl.primary ?? rl.secondary;
        if (win) {
          const used = win.usedPercent ?? 0;
          const status = rl.rateLimitReachedType ? 'rejected' : used >= 80 ? 'allowed_warning' : 'allowed';
          this.push({ type: 'rate_limit_event', session_id: this.sessionId, uuid: randomUUID(), rate_limit_info: { status, resetsAt: win.resetsAt ?? undefined, rateLimitType: (win.windowDurationMins ?? 0) >= 10080 ? 'seven_day' : 'five_hour', utilization: used / 100, plan: rl.planType } });
        }
        break;
      }
      case 'warning': this.push(this.synth.systemNote(`Codex：${p.message ?? ''}`, 'warning')); break;
      case 'mcpServer/startupStatus/updated': if (p.status === 'failed') this.push(this.synth.systemNote(`Codex MCP「${p.name}」启动失败：${p.error ?? ''}`, 'warning')); break;
      case 'item/reasoning/textDelta': case 'item/reasoning/summaryTextDelta': this.pushAll(this.synth.delta('thinking', p.delta ?? '')); break;
      case 'item/started': this.onItem(p.item, false); break;
      case 'item/completed': this.onItem(p.item, true); break;
      case 'item/commandExecution/outputDelta': { const it = this.items.get(p.itemId); if (it) it.output += p.delta ?? ''; break; }
      // only this thread's: sub-agent threads report their own cumulative totals on the same connection
      case 'thread/tokenUsage/updated': if (!p?.threadId || p.threadId === this.threadId) this.usage.update(p?.tokenUsage); break;
      case 'error': if (!p?.willRetry) this.push(this.synth.systemNote(`Codex 错误：${p?.error?.message ?? ''}`, 'error')); break;
      case 'turn/completed': this.onTurnCompleted(p?.turn); break;
      case 'thread/name/updated': if (p?.name) void this.transcripts.patchHead(this.sessionId, { title: p.name }); break;
      default: break;
    }
  }

  private onItem(item: any, completed: boolean) {
    this.pushAll(codexItemMessages(this.synth, this.items, item, completed));
  }

  private onTurnCompleted(turn: any) {
    const status = turn?.status;
    const ok = status === 'completed' || status === 'interrupted';
    this.pushAll(this.synth.endTurn({ ok, error: turn?.error?.message, stopReason: status, usage: this.usage.turn() }));
    this.turnActive = false;
    this.turnId = null;
    if (!this.closed && this.state !== 'error') { this.setState('idle'); this.flush(); }
  }

  private async onApproval(kind: PendingPerm['kind'], p: any) {
    const auto = this.permissionMode === 'bypassPermissions' || this.permissionMode === 'dontAsk' || (this.permissionMode === 'acceptEdits' && kind === 'file');
    if (auto) return { decision: 'accept' };
    const requestId = randomUUID();
    const input = kind === 'command' ? { command: p.command, description: p.reason ?? undefined, cwd: p.cwd } : kind === 'file' ? { file_path: p.grantRoot ?? this.cwd, reason: p.reason } : { permissions: p.permissions ?? p, reason: p.reason };
    const event: PermissionRequestEvent = { requestId, sessionId: this.sessionId, toolName: kind === 'command' ? 'Bash' : kind === 'file' ? 'Edit' : 'Permissions', input, toolUseId: p.itemId, decisionReason: p.reason ?? undefined };
    return new Promise((resolve) => {
      this.pending.set(requestId, { event, resolve, kind });
      this.setState('waiting');
      this.emit('permission', event);
    });
  }

  respondPermission(requestId: string, r: PermissionResponse): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    p.resolve({ decision: r.behavior === 'allow' ? 'accept' : 'decline' });
    this.emit('permissionResolved', requestId);
    if (this.pending.size === 0) this.setState('running');
    return true;
  }

  send(text: string, images?: { mediaType: string; data: string }[], steer = false, uuid?: string, attachments?: AttachmentRef[]) {
    let body = text;
    for (const a of attachments ?? []) body += a.kind === 'text' && a.text ? `\n\n<attached name="${a.name}">\n${a.text}\n</attached>` : `\n\n<attached kind="${a.kind}" name="${a.name}" path="${a.path ?? ''}" />`;
    // the web client already echoed it locally; keep it for transcripts / resume only — after the turns the mirror is
    // still taking in from the Codex CLI (a resume), never in front of them
    const user = this.synth.user(body, uuid, images);
    if (this.mirrorIsReady) this.record(user);
    else void this.mirrorReady.then(() => this.record(user));
    this.emit('sent', user);
    if (steer && this.turnActive && this.rpc && this.threadId) {
      this.rpc.request('turn/steer', { threadId: this.threadId, turnId: this.turnId, input: [{ type: 'text', text: body, text_elements: [] }] }, 30_000).catch(() => this.queue.push({ text: body, images }));
      return;
    }
    this.queue.push({ text: body, images });
    this.flush();
  }

  private flush() {
    if (this.turnActive || this.state === 'starting' || this.state === 'error' || !this.rpc || !this.threadId) return;
    const next = this.queue.shift();
    if (!next) return;
    this.turnActive = true;
    this.setState('running');
    this.synth.beginTurn();
    this.usage.beginTurn();
    const input: any[] = [{ type: 'text', text: next.text, text_elements: [] }];
    for (const im of next.images ?? []) input.push({ type: 'image', url: `data:${im.mediaType};base64,${im.data}` });
    const pol = this.policy();
    this.rpc.request('turn/start', { threadId: this.threadId, input, model: this.model ?? null, effort: this.effort ? EFFORT_MAP[this.effort] : null, approvalPolicy: pol.approvalPolicy, sandboxPolicy: null }, 0).then((r) => { this.turnId = r?.turn?.id ?? this.turnId; }, (e) => {
      this.pushAll(this.synth.endTurn({ ok: false, error: e.message }));
      this.turnActive = false;
      if (!this.closed && this.state !== 'error') { this.setState('idle'); this.flush(); }
    });
  }

  async interrupt() {
    this.queue = [];
    for (const [id, p] of this.pending) { p.resolve({ decision: 'cancel' }); this.pending.delete(id); this.emit('permissionResolved', id); }
    if (this.rpc && this.threadId && this.turnId) await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 15_000).catch(() => {});
  }
  async setPermissionMode(mode: PermissionMode) { this.permissionMode = mode; this.info.permissionMode = mode; this.emit('info', this.info); }
  async setModel(model: string) { this.model = model; this.synth.setModel(model); this.info.model = model; this.emit('info', this.info); await this.transcripts.patchHead(this.sessionId, { model }); }
  async setEffort(effort: EffortLevel) { this.effort = effort; this.info.effort = effort; this.emit('info', this.info); }
  async close() {
    this.closed = true;
    await this.interrupt();
    this.rpc?.kill();
    this.setState('closed');
  }
}
