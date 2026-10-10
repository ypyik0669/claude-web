import { EventEmitter } from 'node:events';
import { modelsFor } from '../models/catalog.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { AgentKind, AttachmentRef, OpenSessionParams, PermissionMode, PermissionRequestEvent, PermissionResponse, RunnerState, SessionInfoSnapshot } from '../protocol.js';
import { JsonRpcProcess } from './jsonrpc.js';
import { acpMcpServers } from '../memory/launcher.js';
import { webAcpMcpServers } from '../web/launcher.js';
import { MessageSynth, mapToolName } from './normalize.js';
import type { AgentTranscripts } from './transcript.js';
import type { AgentDriver } from './types.js';

interface PendingPerm { event: PermissionRequestEvent; resolve: (r: any) => void; options: { optionId: string; kind: string }[] }

/**
 * Agent Client Protocol (Gemini CLI, Qwen Code, Kimi, Zed-style agents): JSON-RPC over stdio.
 * We are the "client": we start the agent, open a session, send prompts, stream `session/update`
 * notifications into SDK-shaped messages and answer `session/request_permission` / `fs/*` requests.
 */
export class AcpDriver extends EventEmitter implements AgentDriver {
  readonly id: string;
  sessionId: string;
  state: RunnerState = 'starting';
  cwd: string;
  info: SessionInfoSnapshot;
  lastActivity = Date.now();
  private rpc: JsonRpcProcess | null = null;
  private acpSessionId: string | null = null;
  private synth: MessageSynth;
  private history: unknown[] = [];
  private pending = new Map<string, PendingPerm>();
  private tools = new Map<string, { name: string; input: Record<string, unknown>; done: boolean }>();
  private turnActive = false;
  private queue: { text: string; images?: { mediaType: string; data: string }[] }[] = [];
  private closed = false;
  private caps: any = {};
  private model?: string;
  private permissionMode: PermissionMode;
  private autoApprove = false;

  constructor(private kind: AgentKind, private launch: { command: string; args: string[]; env: Record<string, string>; model?: string; name: string; login?: string }, params: OpenSessionParams, private transcripts: AgentTranscripts, private resumeHistory: unknown[] | null) {
    super();
    this.cwd = params.cwd;
    this.sessionId = params.sessionId ?? randomUUID();
    this.id = this.sessionId;
    this.model = params.model || launch.model;
    this.permissionMode = params.permissionMode ?? 'default';
    this.autoApprove = this.permissionMode === 'bypassPermissions' || this.permissionMode === 'acceptEdits' || this.permissionMode === 'auto' || this.permissionMode === 'dontAsk';
    this.synth = new MessageSynth(this.sessionId, this.model ?? '');
    this.info = { sessionId: this.sessionId, state: 'starting', cwd: this.cwd, model: this.model, permissionMode: this.permissionMode, agent: kind, agentName: launch.name, runtime: 'ccb', slashCommands: [], models: modelsFor(kind) };
    void this.start(params);
  }

  getHistory() { return this.history; }
  getPendingPermissions() { return [...this.pending.values()].map((p) => p.event); }

  private setState(s: RunnerState, error?: string) {
    this.state = s;
    this.info.state = s;
    if (error) this.info.error = error;
    this.emit('state', s, error);
  }
  private push(m: any) {
    this.lastActivity = Date.now();
    if (m.type !== 'stream_event') { this.history.push(m); if (this.history.length > 5000) this.history.splice(0, 1000); this.transcripts.append(this.sessionId, m); }
    this.emit('message', m);
  }
  private pushAll(ms: any[]) { for (const m of ms) this.push(m); }
  private record(m: any) { this.history.push(m); this.transcripts.append(this.sessionId, m); }

  private async start(params: OpenSessionParams) {
    try {
      const rpc = new JsonRpcProcess(this.launch.command, this.launch.args, { cwd: this.cwd, env: this.launch.env });
      this.rpc = rpc;
      rpc.on('exit', (code, err) => { if (!this.closed) { this.setState('error', `${this.launch.name} 退出（${code}）${err ? ` ${err}` : ''}\n${rpc.stderrTail.slice(-800)}`); } });
      rpc.on('notification', (method, p) => this.onNotification(method, p));
      rpc.onRequest('session/request_permission', (p) => this.onPermission(p));
      rpc.onRequest('fs/read_text_file', async (p) => ({ content: await fs.readFile(p.path, 'utf8') }));
      rpc.onRequest('fs/write_text_file', async (p) => { await fs.writeFile(p.path, p.content, 'utf8'); return null; });
      const init = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: 'claude-web', version: '0.1.0' } }, 60_000);
      this.caps = init?.agentCapabilities ?? {};
      if (!(await this.transcripts.exists(this.sessionId))) await this.transcripts.create({ agent: this.kind, cwd: this.cwd, title: '', createdAt: Date.now(), sessionId: this.sessionId, model: this.model });
      const head = await this.transcripts.head(this.sessionId);
      let loaded = false;
      // the shared memory store and 联网 (web search + the built-in browser), handed to the agent inline — we never
      // touch its own settings file
      const mcpServers = [...acpMcpServers({ cwd: this.cwd, sessionId: this.sessionId, agent: this.kind }), ...webAcpMcpServers({ sessionId: this.sessionId })];
      if (params.sessionId && head?.nativeSessionId && this.caps.loadSession) {
        try { await rpc.request('session/load', { sessionId: head.nativeSessionId, cwd: this.cwd, mcpServers }, 120_000); this.acpSessionId = head.nativeSessionId; loaded = true; } catch { /* fall back to a fresh session */ }
      }
      if (!loaded) {
        // an agent that chokes on our server must still get a session, so retry bare once
        const newSession = async () => {
          try { return await rpc.request('session/new', { cwd: this.cwd, mcpServers }, 120_000); } catch (e) {
            if (!mcpServers.length) throw e;
            const r = await rpc.request('session/new', { cwd: this.cwd, mcpServers: [] }, 120_000);
            this.push(this.synth.systemNote(`${this.launch.name} 不接受${mcpServers.map((s) => (s.name === 'web' ? '联网' : '共享记忆')).join(' / ')} MCP，已改为不带它启动。`, 'warning'));
            return r;
          }
        };
        let r: any;
        try { r = await newSession(); } catch (e: any) {
          // ACP: -32000 auth_required → try the agent's auth methods that need no interaction, else tell the user how to log in
          const methods: any[] = init?.authMethods ?? [];
          const silent = methods.find((m) => /api[-_ ]?key|env|vertex/i.test(`${m.id} ${m.name}`)) ?? null;
          if (silent && /auth|api key|login|credential|-32000/i.test(String(e.message))) {
            try { await rpc.request('authenticate', { methodId: silent.id }, 60_000); r = await newSession(); } catch { /* fall through to the hint */ }
          }
          if (!r) throw new Error(`${e.message}${this.launch.login ? `\n需要先登录：在终端里运行 \`${this.launch.login}\`（设置 → Agents 与子代理 → 其它 Agent 有「登录」按钮）` : ''}`);
        }
        this.acpSessionId = r.sessionId;
        await this.transcripts.patchHead(this.sessionId, { nativeSessionId: r.sessionId });
        if (params.sessionId && this.resumeHistory?.length) this.push(this.synth.systemNote(`${this.launch.name} 不支持恢复上下文，已新开一个对话；上面的历史仅供查看。`, 'warning'));
      }
      if (this.model && this.caps?.sessionCapabilities?.setModel !== false) {
        try { await rpc.request('session/set_model', { sessionId: this.acpSessionId, modelId: this.model }, 30_000); } catch { /* not supported */ }
      }
      this.push(this.synth.init({ cwd: this.cwd, permissionMode: this.permissionMode, version: this.launch.name, agent: this.kind }));
      this.setState('idle');
      this.emit('info', this.info);
      this.flush();
    } catch (e: any) {
      this.setState('error', `${this.launch.name} 启动失败：${e.message}${this.rpc?.stderrTail ? `\n${this.rpc.stderrTail.slice(-800)}` : ''}`);
    }
  }

  private onNotification(method: string, p: any) {
    if (method !== 'session/update' || !p?.update) return;
    const u = p.update;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': if (u.content?.type === 'text') this.pushAll(this.synth.delta('text', u.content.text)); break;
      case 'agent_thought_chunk': if (u.content?.type === 'text') this.pushAll(this.synth.delta('thinking', u.content.text)); break;
      case 'tool_call': {
        const name = mapToolName(u.kind, u.title, u);
        const input = this.toolInput(name, u);
        this.tools.set(u.toolCallId, { name, input, done: false });
        this.pushAll(this.synth.toolUse(u.toolCallId, name, input));
        if (u.status === 'completed' || u.status === 'failed') this.finishTool(u.toolCallId, u);
        else if (u.status === 'in_progress') this.push(this.synth.toolProgress(u.toolCallId, name));
        break;
      }
      case 'tool_call_update': {
        const t = this.tools.get(u.toolCallId);
        if (!t) { const name = mapToolName(u.kind, u.title, u); this.tools.set(u.toolCallId, { name, input: this.toolInput(name, u), done: false }); this.pushAll(this.synth.toolUse(u.toolCallId, name, this.toolInput(name, u))); }
        if (u.status === 'completed' || u.status === 'failed') this.finishTool(u.toolCallId, u);
        else if (u.status === 'in_progress') this.push(this.synth.toolProgress(u.toolCallId, this.tools.get(u.toolCallId)!.name));
        break;
      }
      case 'plan': {
        const todos = (u.entries ?? []).map((e: any) => ({ content: e.content, status: e.status === 'completed' ? 'completed' : e.status === 'in_progress' ? 'in_progress' : 'pending', activeForm: e.content }));
        const id = `plan_${Date.now().toString(36)}`;
        this.pushAll(this.synth.toolUse(id, 'TodoWrite', { todos }));
        this.push(this.synth.toolResult(id, 'Todos updated', false, { oldTodos: [], newTodos: todos }));
        break;
      }
      case 'available_commands_update':
        this.info.slashCommands = (u.availableCommands ?? []).map((c: any) => ({ name: c.name, description: c.description ?? '', argumentHint: c.input?.hint ?? '' }));
        this.emit('info', this.info);
        break;
      case 'current_mode_update':
        break;
      default:
        break;
    }
  }

  private toolInput(name: string, u: any): Record<string, unknown> {
    const loc = u.locations?.[0];
    const raw = u.rawInput ?? {};
    if (name === 'Read') return { file_path: loc?.path ?? raw.path ?? raw.file_path ?? u.title };
    if (name === 'Edit' || name === 'Write') return { file_path: loc?.path ?? raw.path ?? raw.file_path ?? u.title, ...(raw.content ? { content: raw.content } : {}) };
    if (name === 'Bash') return { command: raw.command ?? raw.cmd ?? u.title, description: u.title };
    if (name === 'Grep' || name === 'Glob') return { pattern: raw.pattern ?? raw.query ?? u.title, path: loc?.path ?? raw.path };
    if (name === 'WebFetch') return { url: raw.url ?? u.title };
    return { ...raw, title: u.title };
  }

  private finishTool(id: string, u: any) {
    const t = this.tools.get(id);
    if (!t || t.done) return;
    t.done = true;
    const texts: string[] = [];
    const images: string[] = [];
    let structured: any;
    for (const c of u.content ?? []) {
      if (c.type === 'content' && c.content?.type === 'text') texts.push(c.content.text);
      else if (c.type === 'content' && c.content?.type === 'image') images.push(`data:${c.content.mimeType};base64,${c.content.data}`);
      else if (c.type === 'diff') { texts.push(`--- ${c.path}\n+++ ${c.path}`); structured = { filePath: c.path, oldString: c.oldText ?? '', newString: c.newText ?? '' }; }
      else if (c.type === 'terminal') texts.push(`[terminal ${c.terminalId}]`);
    }
    if (t.name === 'Bash' && !structured) structured = { stdout: texts.join('\n'), stderr: '', interrupted: false };
    this.push(this.synth.toolResult(id, texts.join('\n') || (u.status === 'failed' ? 'failed' : 'done'), u.status === 'failed', structured, images));
  }

  private async onPermission(p: any) {
    const tc = p.toolCall ?? {};
    const known = tc.toolCallId ? this.tools.get(tc.toolCallId) : undefined;
    const name = known?.name ?? mapToolName(tc.kind, tc.title, tc);
    const input = known ? { ...known.input, ...(tc.rawInput ?? {}) } : this.toolInput(name, tc);
    const options: { optionId: string; kind: string }[] = p.options ?? [];
    const pick = (kinds: string[]) => options.find((o) => kinds.includes(o.kind))?.optionId ?? options[0]?.optionId;
    if (this.autoApprove) return { outcome: { outcome: 'selected', optionId: pick(['allow_once', 'allow_always']) } };
    const requestId = randomUUID();
    const event: PermissionRequestEvent = { requestId, sessionId: this.sessionId, toolName: name, input, toolUseId: tc.toolCallId };
    return new Promise((resolve) => {
      this.pending.set(requestId, { event, resolve, options });
      this.setState('waiting');
      this.emit('permission', event);
    });
  }

  respondPermission(requestId: string, r: PermissionResponse): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    const pick = (kinds: string[]) => p.options.find((o) => kinds.includes(o.kind))?.optionId ?? p.options[0]?.optionId;
    const optionId = r.behavior === 'allow' ? pick(['allow_once', 'allow_always']) : pick(['reject_once', 'reject_always']);
    p.resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
    this.emit('permissionResolved', requestId);
    if (this.pending.size === 0) this.setState('running');
    return true;
  }

  send(text: string, images?: { mediaType: string; data: string }[], _steer = false, uuid?: string, attachments?: AttachmentRef[]) {
    let body = text;
    for (const a of attachments ?? []) body += a.kind === 'text' && a.text ? `\n\n<attached name="${a.name}">\n${a.text}\n</attached>` : `\n\n<attached kind="${a.kind}" name="${a.name}" path="${a.path ?? ''}" />`;
    const user = this.synth.user(body, uuid, images);
    this.record(user); // the web client already echoed it locally; keep it for transcripts / resume only
    this.emit('sent', user);
    this.queue.push({ text: body, images });
    this.flush();
  }

  private flush() {
    if (this.turnActive || this.state === 'starting' || this.state === 'error' || !this.rpc || !this.acpSessionId) return;
    const next = this.queue.shift();
    if (!next) return;
    this.turnActive = true;
    this.setState('running');
    this.synth.beginTurn();
    const prompt: any[] = [{ type: 'text', text: next.text }];
    for (const im of next.images ?? []) prompt.push({ type: 'image', mimeType: im.mediaType, data: im.data });
    this.rpc.request('session/prompt', { sessionId: this.acpSessionId, prompt }, 0).then((r) => {
      this.pushAll(this.synth.endTurn({ ok: r?.stopReason !== 'refusal', stopReason: r?.stopReason, error: r?.stopReason === 'refusal' ? 'refused' : undefined }));
    }, (e) => {
      this.pushAll(this.synth.endTurn({ ok: false, error: e.message }));
    }).finally(() => {
      this.turnActive = false;
      if (!this.closed && this.state !== 'error') { this.setState('idle'); this.flush(); }
    });
  }

  async interrupt() {
    this.queue = [];
    for (const [id, p] of this.pending) { p.resolve({ outcome: { outcome: 'cancelled' } }); this.pending.delete(id); this.emit('permissionResolved', id); }
    if (this.rpc && this.acpSessionId && this.turnActive) this.rpc.notify('session/cancel', { sessionId: this.acpSessionId });
  }
  async setPermissionMode(mode: PermissionMode) {
    this.permissionMode = mode;
    this.autoApprove = mode === 'bypassPermissions' || mode === 'acceptEdits' || mode === 'auto' || mode === 'dontAsk';
    this.info.permissionMode = mode;
    this.emit('info', this.info);
  }
  async setModel(model: string) {
    this.model = model;
    this.synth.setModel(model);
    this.info.model = model;
    if (this.rpc && this.acpSessionId) await this.rpc.request('session/set_model', { sessionId: this.acpSessionId, modelId: model }, 30_000).catch((e) => { throw new Error(`该 agent 不支持切换模型：${e.message}`); });
    this.emit('info', this.info);
  }
  async close() {
    this.closed = true;
    await this.interrupt();
    this.rpc?.kill();
    this.setState('closed');
  }
}
