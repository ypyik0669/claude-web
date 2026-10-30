import { randomInt } from 'node:crypto';
import type { RunnerPool } from '../runtime/pool.js';
import type { MetaStore } from '../meta/store.js';
import type { SessionService } from '../sessions/service.js';
import type { ImAdapter, InboundMessage } from './types.js';
import type { AgentKind, ImBinding, ImGatewayConfig, PermissionRequestEvent } from '../protocol.js';
import { tr } from '../i18n/index.js';
import { isDispatchCommand, parseImDispatch } from '../dispatch/core.js';

const HELP = tr("Claude Web 命令：\n/new [目录] — 新会话（默认第一个工作区）\n/sessions — 最近会话\n/use <序号|id前缀> — 切换到某个会话\n/status — 当前会话状态\n/stop — 中断当前回合\n/allow · /deny — 处理最近的权限请求\n/mode <default|acceptEdits|bypassPermissions> — 权限模式\n/model <名字> — 切换模型\n/verbose on|off — 是否推送工具调用过程\n/help — 这份说明\n其它文字 = 直接发给当前会话");

/** ` · 供应商 X` in replies that name the session (people check which channel the bot uses); nothing on the account */
const channel = (i: { providerId?: string; providerName?: string }) => (i.providerName && i.providerId && i.providerId !== 'claude' ? tr(' · 供应商 {providerName}', { providerName: i.providerName }) : '');

export interface RouterDeps { pool: RunnerPool; meta: MetaStore; sessions: SessionService }

/**
 * Routes chat messages into sessions and session events back to chats. One binding per (gateway, chat).
 * Authorization: user ids on the gateway's allow list; a fresh pairing code (shown in settings) adds one via `/pair <code>`.
 */
export class ImRouter {
  private adapters = new Map<string, ImAdapter>();
  private configs = new Map<string, ImGatewayConfig>();
  private pairCodes = new Map<string, { code: string; expiresAt: number }>();
  private lastDenied = new Map<string, number>();
  private lastPermission = new Map<string, PermissionRequestEvent>(); // sessionId → latest pending
  private lastText = new Map<string, string>(); // sessionId → assistant text of the current turn
  constructor(private d: RouterDeps) {
    d.pool.on('message', (sid: string, m: any) => this.onSessionMessage(sid, m));
    d.pool.on('permission', (e: PermissionRequestEvent) => this.onPermission(e));
    d.pool.on('permissionResolved', (sid: string) => { this.lastPermission.delete(sid); });
    d.pool.on('state', (sid: string, state: string, err?: string) => { if (state === 'error' && err) void this.notify(sid, tr('⚠️ 会话出错：{v}', { v: err.split('\n')[0] })); });
  }

  attach(cfg: ImGatewayConfig, a: ImAdapter) {
    this.detach(cfg.id);
    this.adapters.set(cfg.id, a);
    this.configs.set(cfg.id, cfg);
    a.on('message', (m: InboundMessage) => { void this.onInbound(cfg.id, m).catch((e) => a.send(m.chatId, tr('出错：{message}', { message: e.message })).catch(() => {})); });
  }
  detach(id: string) { this.adapters.delete(id); this.configs.delete(id); }
  updateConfig(cfg: ImGatewayConfig) { this.configs.set(cfg.id, cfg); }

  newPairCode(gatewayId: string) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const rec = { code, expiresAt: Date.now() + 10 * 60_000 };
    this.pairCodes.set(gatewayId, rec);
    return rec;
  }
  pairCode(gatewayId: string) { const p = this.pairCodes.get(gatewayId); return p && p.expiresAt > Date.now() ? p : null; }

  private bindings(): ImBinding[] { return this.d.meta.imBindings(); }
  private bindingFor(gw: string, chatId: string) { return this.bindings().find((b) => b.gatewayId === gw && b.chatId === chatId); }
  private chatsFor(sessionId: string) { return this.bindings().filter((b) => b.sessionId === sessionId); }

  // ---- inbound ----
  private async onInbound(gw: string, m: InboundMessage) {
    const a = this.adapters.get(gw);
    const cfg = this.configs.get(gw);
    if (!a || !cfg) return;
    const reply = (t: string) => a.send(m.chatId, t);
    const text = (m.text ?? '').trim();
    const allowed = (cfg.allowUsers ?? []).includes(m.userId) || (cfg.allowUsers ?? []).length === 0 && cfg.openAccess === true;
    if (!allowed) {
      const pm = /^\/pair\s+(\d{6})$/.exec(text);
      const pc = this.pairCode(gw);
      if (pm && pc && pm[1] === pc.code) {
        this.pairCodes.delete(gw);
        const next = { ...cfg, allowUsers: [...(cfg.allowUsers ?? []), m.userId], allowNames: { ...(cfg.allowNames ?? {}), [m.userId]: m.userName || m.userId } };
        await this.d.meta.setImGateway(next);
        this.configs.set(gw, next);
        await reply(tr('✅ 已授权 {userName}。发 /help 看命令，或直接说要做什么。', { userName: m.userName || m.userId }));
        return;
      }
      const key = `${gw}:${m.userId}`;
      if (Date.now() - (this.lastDenied.get(key) ?? 0) > 60 * 60_000) { this.lastDenied.set(key, Date.now()); await reply(tr("未授权。请在电脑上 Claude Web → 设置 → IM 机器人 生成配对码，然后发送：/pair 123456\n（你的 id：{userId}）", { userId: m.userId })); }
      return;
    }
    if (m.callback) return this.onCallback(gw, m, reply);
    if (!text) return;
    if (text.startsWith('/')) return this.onCommand(gw, m, text, reply);
    // plain text → the bound session (create one if needed)
    const b = await this.ensureSession(gw, m.chatId, cfg);
    const r = this.d.pool.get(b.sessionId);
    if (!r) { await reply(tr('会话已关闭，用 /new 或 /use 重新绑定。')); return; }
    if (r.state === 'waiting') { const p = this.lastPermission.get(b.sessionId); if (p) await reply(tr('会话正在等你处理权限：{toolName}。用 /allow 或 /deny，或按上一条消息的按钮。', { toolName: p.toolName })); }
    this.d.pool.assertWritable?.(b.sessionId); // handed to another machine: read-only here (F4)
    r.send(text);
    this.lastText.set(b.sessionId, '');
  }

  private async onCallback(gw: string, m: InboundMessage, reply: (t: string) => Promise<void>) {
    const [kind, requestId, choice] = (m.callback ?? '').split(':');
    const extra = this.callbackHandlers.get(kind);
    if (extra) { await reply(await extra((m.callback ?? '').split(':').slice(1), { gatewayId: gw, chatId: m.chatId, sessionId: this.bindingFor(gw, m.chatId)?.sessionId }).catch((e) => tr('出错：{message}', { message: e.message }))); return; }
    if (kind === 'perm' || kind === 'ask') {
      const runner = this.d.pool.findPermission(requestId);
      const event = runner?.getPendingPermissions().find((p) => p.requestId === requestId);
      if (!runner || !event) { await reply(tr('这个请求已经处理过了。')); return; }
      if (kind === 'perm') runner.respondPermission(requestId, choice === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: tr('用户在 IM 上拒绝') });
      else {
        const q = (event.input as any)?.questions?.[0];
        const opt = q?.options?.[Number(choice)];
        runner.respondPermission(requestId, { behavior: 'allow', updatedInput: { ...(event.input as object), answers: { [q?.question ?? 'q']: opt?.label ?? choice } } } as any);
      }
      await reply(kind === 'perm' ? (choice === 'allow' ? tr('✅ 已允许') : tr('⛔ 已拒绝')) : tr('✅ 已选择：{choice}', { choice }));
    }
  }

  private async onCommand(gw: string, m: InboundMessage, text: string, reply: (t: string) => Promise<void>) {
    const cfg = this.configs.get(gw)!;
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();
    const b = this.bindingFor(gw, m.chatId);
    const runner = b ? this.d.pool.get(b.sessionId) : undefined;
    switch (isDispatchCommand(cmd) ? '/dispatch' : cmd.toLowerCase()) {
      case '/help': case '/start': return reply(`${HELP}\n${tr('/dispatch [项目名:] <任务> — 派活：在电脑上新开一个对话去做，做完在这里告诉你')}`);
      // 派活 (stage F3): a new conversation in the project (its own permission mode), bound to this chat, task sent
      case '/dispatch': { // also its Chinese alias (isDispatchCommand)
        const ws = this.d.meta.workspaces() as { id: string; name: string; path: string; permissionMode?: string }[];
        const parsed = parseImDispatch(text, ws);
        if (!parsed) return reply(tr('用法：/dispatch [项目名:] <任务>'));
        const w = parsed.workspaceId ? ws.find((x) => x.id === parsed.workspaceId) : undefined;
        const cwd = w?.path || cfg.defaultCwd || ws[0]?.path;
        if (!cwd) return reply(tr('没有工作区：/new <目录> 指定一个绝对路径。'));
        const r = this.openNew(cfg, cwd, w?.permissionMode);
        await this.d.meta.setImBinding({ gatewayId: gw, chatId: m.chatId, sessionId: r.sessionId, cwd, since: Date.now(), ...(cfg.agent ? { agent: cfg.agent } : {}) });
        if (typeof (this.d.meta as any).setSessionMeta === 'function') await this.d.meta.setSessionMeta(r.sessionId, { origin: 'dispatch', dispatchFrom: 'im', ...(w ? { workspaceId: w.id } : {}) });
        r.send(parsed.prompt);
        this.lastText.set(r.sessionId, '');
        return reply(tr('📨 已派出：新对话 {id} · {cwd}{channel}\n做完或需要你回答时会在这里告诉你。', { id: r.sessionId.slice(0, 8), cwd, channel: channel(r.info) }));
      }
      case '/new': {
        const cwd = arg || cfg.defaultCwd || this.d.meta.workspaces()[0]?.path;
        if (!cwd) return reply(tr('没有工作区：/new <目录> 指定一个绝对路径。'));
        const r = this.openNew(cfg, cwd);
        await this.d.meta.setImBinding({ gatewayId: gw, chatId: m.chatId, sessionId: r.sessionId, cwd, since: Date.now(), ...(cfg.agent ? { agent: cfg.agent } : {}) });
        return reply(tr("🆕 新会话 {sessionId} · {cwd}{channel}\n直接发消息即可。", { sessionId: r.sessionId.slice(0, 8), cwd, channel: channel(r.info) }));
      }
      case '/sessions': {
        const list = (await this.d.sessions.list(15));
        const live = new Set(this.d.pool.list().map((x) => x.sessionId));
        const lines = list.slice(0, 10).map((s, i) => `${i + 1}. ${live.has(s.sessionId) ? '●' : '○'} ${s.title.slice(0, 40)} (${s.sessionId.slice(0, 8)})`);
        return reply(lines.length ? tr("{lines}\n/use <序号> 切换", { lines: lines.join('\n') }) : tr('没有会话'));
      }
      case '/use': {
        if (!arg) return reply(tr('/use <序号|id前缀>'));
        const list = await this.d.sessions.list(15);
        const target = /^\d+$/.test(arg) ? list[Number(arg) - 1] : list.find((s) => s.sessionId.startsWith(arg));
        if (!target) return reply(tr('没找到'));
        let r = this.d.pool.get(target.sessionId);
        // on the session's own agent (a Codex session reopened without it would start Claude on that id); the pool
        // keeps the provider it was recorded with
        const agent = target.agent && target.agent !== 'claude' ? target.agent : undefined;
        if (!r) r = this.d.pool.open({ sessionId: target.sessionId, cwd: target.cwd, permissionMode: (cfg.permissionMode as any) ?? 'default', agent, drivenBy: 'im' });
        await this.d.meta.setImBinding({ gatewayId: gw, chatId: m.chatId, sessionId: r.sessionId, cwd: target.cwd, since: Date.now(), ...(agent ? { agent } : {}) });
        return reply(tr('已切换到 {title} ({sessionId})', { title: target.title.slice(0, 40), sessionId: r.sessionId.slice(0, 8) }));
      }
      case '/status': {
        if (!b) return reply(tr('这个聊天还没绑定会话：/new 或 /use'));
        const st = runner?.state ?? 'closed';
        const p = this.lastPermission.get(b.sessionId);
        return reply(tr("会话 {sessionId} · {st}{v}{channel}\n目录 {cwd}{v2}", { sessionId: b.sessionId.slice(0, 8), st, v: runner?.info.model ? ` · ${runner.info.model}` : '', channel: runner ? channel(runner.info) : '', cwd: b.cwd, v2: p ? tr("\n待处理权限：{toolName}", { toolName: p.toolName }) : '' }));
      }
      case '/stop': {
        // the hard stop also reaches the bots that report to this chat (值班 Bot): their runs stop
        const bots = await this.onStop?.(gw, m.chatId).catch((e) => { console.warn('[im] stopping the bots of this chat:', e); return undefined; });
        if (!runner) return reply(bots ?? tr('没有运行中的会话'));
        await runner.interrupt();
        return reply(bots ? `${tr('⏹ 已中断')}\n${bots}` : tr('⏹ 已中断'));
      }
      case '/allow': case '/deny': {
        if (!b) return reply(tr('没有绑定会话'));
        const p = this.lastPermission.get(b.sessionId) ?? runner?.getPendingPermissions().slice(-1)[0];
        if (!p || !runner) return reply(tr('没有待处理的权限请求'));
        runner.respondPermission(p.requestId, cmd === '/allow' ? { behavior: 'allow' } : { behavior: 'deny', message: tr('用户在 IM 上拒绝') });
        return reply(cmd === '/allow' ? tr('✅ 已允许') : tr('⛔ 已拒绝'));
      }
      case '/mode': if (!runner) return reply(tr('没有会话')); await runner.setPermissionMode(arg as any); return reply(tr('权限模式：{arg}', { arg }));
      case '/model': if (!runner) return reply(tr('没有会话')); await runner.setModel(arg); return reply(tr('模型：{arg}', { arg }));
      case '/verbose': { const next = { ...cfg, verbose: arg !== 'off' }; await this.d.meta.setImGateway(next); this.configs.set(gw, next); return reply(tr('工具过程推送：{v}', { v: next.verbose ? tr('开') : tr('关') })); }
      default: {
        // unknown slash command → forward to the session (Claude's own /commands)
        if (!b || !runner) return reply(tr('未知命令，/help 看说明'));
        this.d.pool.assertWritable?.(b.sessionId);
        runner.send(text);
        return;
      }
    }
  }

  /**
   * A new session for this gateway: its agent, and its provider — the one picked in settings → IM 机器人, else (the
   * pool decides) the new-conversation default, the same one a new conversation in the window gets. A picked
   * provider the agent cannot use (the agent was changed afterwards) falls back to that default.
   */
  private openNew(cfg: ImGatewayConfig, cwd: string, mode?: string) {
    const agent = (cfg.agent as AgentKind) || undefined;
    const picked = cfg.providerId || undefined;
    const providerId = picked && !this.d.pool.providerFitError?.(picked, agent) ? picked : undefined;
    return this.d.pool.open({ cwd, permissionMode: ((mode || cfg.permissionMode) as any) ?? 'default', agent, providerId, drivenBy: 'im' });
  }

  private async ensureSession(gw: string, chatId: string, cfg: ImGatewayConfig): Promise<ImBinding> {
    const b = this.bindingFor(gw, chatId);
    if (b && this.d.pool.get(b.sessionId)) return b;
    // handed to another machine (F4): say so, never quietly move the chat to a new conversation
    if (b) this.d.pool.assertWritable?.(b.sessionId);
    if (b) {
      // re-open the previous session so context continues
      // on its own agent; the pool keeps the provider it was recorded with
      try { this.d.pool.open({ sessionId: b.sessionId, cwd: b.cwd, permissionMode: (cfg.permissionMode as any) ?? 'default', agent: (b.agent as AgentKind) || undefined, drivenBy: 'im' }); return b; } catch { /* fall through to a new one */ }
    }
    const cwd = cfg.defaultCwd || this.d.meta.workspaces()[0]?.path;
    if (!cwd) throw new Error(tr('没有工作区，先 /new <目录>'));
    const r = this.openNew(cfg, cwd);
    const nb: ImBinding = { gatewayId: gw, chatId, sessionId: r.sessionId, cwd, since: Date.now(), ...(cfg.agent ? { agent: cfg.agent } : {}) };
    await this.d.meta.setImBinding(nb);
    return nb;
  }

  // ---- outbound ----
  /** `/stop` in a chat: also stops what else reports to it (the bots whose IM output it is); the reply says what stopped, if anything */
  onStop?: (gatewayId: string, chatId: string) => Promise<string | undefined>;

  /** Button callbacks with other prefixes (e.g. `orch:` for orchestration approvals); gets the chat and the session it is bound to, returns the reply text. */
  callbackHandlers = new Map<string, (parts: string[], ctx: { gatewayId: string; chatId: string; sessionId?: string }) => Promise<string>>();

  /** Push to every chat bound to any of these sessions, once per chat. */
  async announce(sessionIds: string[], text: string, o?: { buttons?: { id: string; label: string; danger?: boolean }[] }) {
    const seen = new Set<string>();
    for (const b of this.bindings().filter((x) => sessionIds.includes(x.sessionId))) {
      const key = `${b.gatewayId}|${b.chatId}`;
      const a = this.adapters.get(b.gatewayId);
      if (seen.has(key) || !a || a.state !== 'running') continue;
      seen.add(key);
      await a.send(b.chatId, text, o).catch(() => {});
    }
  }

  /** 值班 Bot: push to one chat of one gateway (a bot's output), buttons as inline keys where the platform has them */
  async sendTo(gatewayId: string, chatId: string, text: string, buttons?: { id: string; label: string; danger?: boolean }[]) {
    const a = this.adapters.get(gatewayId);
    if (!a || a.state !== 'running') throw new Error(tr('这个 IM 没在运行'));
    await a.send(chatId, text, buttons ? { buttons } : undefined);
  }

  private async notify(sessionId: string, text: string, o?: { buttons?: { id: string; label: string; danger?: boolean }[] }) {
    for (const b of this.chatsFor(sessionId)) {
      const a = this.adapters.get(b.gatewayId);
      if (!a || a.state !== 'running') continue;
      await a.send(b.chatId, text, o).catch(() => {});
    }
  }

  private onPermission(e: PermissionRequestEvent) {
    if (!this.chatsFor(e.sessionId).length) return;
    this.lastPermission.set(e.sessionId, e);
    const input: any = e.input ?? {};
    if (e.toolName === 'AskUserQuestion') {
      const q = input.questions?.[0];
      const opts: any[] = q?.options ?? [];
      void this.notify(e.sessionId, `❓ ${q?.question ?? tr('请选择')}\n${opts.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n')}`, { buttons: opts.slice(0, 5).map((o, i) => ({ id: `ask:${e.requestId}:${i}`, label: String(o.label).slice(0, 30) })) });
      return;
    }
    if (e.toolName === 'ExitPlanMode') { void this.notify(e.sessionId, tr('📋 计划已就绪，是否开始执行？'), { buttons: [{ id: `perm:${e.requestId}:allow`, label: tr('开始执行') }, { id: `perm:${e.requestId}:deny`, label: tr('继续讨论'), danger: true }] }); return; }
    const summary = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? JSON.stringify(input).slice(0, 200);
    void this.notify(e.sessionId, tr("🔐 {toolName} 请求权限\n{summary}", { toolName: e.toolName, summary: String(summary).slice(0, 600) }), { buttons: [{ id: `perm:${e.requestId}:allow`, label: tr('允许') }, { id: `perm:${e.requestId}:deny`, label: tr('拒绝'), danger: true }] });
  }

  private onSessionMessage(sid: string, m: any) {
    const chats = this.chatsFor(sid);
    if (!chats.length) return;
    if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) {
        if (c.type === 'text' && c.text) this.lastText.set(sid, c.text);
        if (c.type === 'tool_use') {
          const verbose = chats.some((b) => this.configs.get(b.gatewayId)?.verbose);
          if (verbose) { const inp: any = c.input ?? {}; void this.notify(sid, `🔧 ${c.name} ${String(inp.command ?? inp.file_path ?? inp.pattern ?? inp.url ?? inp.description ?? '').slice(0, 200)}`); }
        }
      }
    } else if (m.type === 'result') {
      const text = (m.is_error ? `❌ ${m.result || m.subtype}` : (this.lastText.get(sid) || m.result || tr('(完成，没有文字回复)'))).trim();
      const cost = m.total_cost_usd ? ` · $${Number(m.total_cost_usd).toFixed(3)}` : '';
      void this.notify(sid, `${text}\n\n— ${Math.round((m.duration_ms ?? 0) / 1000)}s${cost}`);
      this.lastText.delete(sid);
    } else if (m.type === 'system' && m.subtype === 'status' && m.level === 'error') {
      void this.notify(sid, `⚠️ ${m.note}`);
    }
  }
}
