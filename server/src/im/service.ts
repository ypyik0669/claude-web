import { EventEmitter } from 'node:events';
import type { MetaStore } from '../meta/store.js';
import type { RunnerPool } from '../runtime/pool.js';
import type { SessionService } from '../sessions/service.js';
import type { SecretService } from '../secrets/service.js';
import type { ImGatewayConfig, ImGatewayInfo, ImKind } from '../protocol.js';
import { ImRouter } from './router.js';
import { TelegramAdapter } from './telegram.js';
import { DiscordAdapter } from './discord.js';
import { SlackAdapter } from './slack.js';
import { DingTalkAdapter } from './dingtalk.js';
import { FeishuAdapter } from './feishu.js';
import { WecomAdapter } from './wecom.js';
import type { ImAdapter } from './types.js';

export const IM_KINDS: { kind: ImKind; name: string; icon: string; inbound: boolean; fields: { key: string; label: string; secret?: boolean; hint?: string }[]; help: string }[] = [
  { kind: 'telegram', name: 'Telegram', icon: '✈️', inbound: true, fields: [{ key: 'botToken', label: 'Bot Token', secret: true, hint: '@BotFather 创建机器人后得到' }], help: '和 @BotFather 聊 /newbot 拿 token；私聊机器人或把它拉进群。长轮询，不需要公网。' },
  { kind: 'discord', name: 'Discord', icon: '🎮', inbound: true, fields: [{ key: 'botToken', label: 'Bot Token', secret: true, hint: 'Developer Portal → Bot → Token；需要打开 Message Content Intent' }], help: '在 Developer Portal 建应用 → Bot，开启 MESSAGE CONTENT INTENT，用 OAuth2 URL（scope bot，权限 Send Messages / Read Message History）邀请进服务器。' },
  { kind: 'slack', name: 'Slack', icon: '💬', inbound: true, fields: [{ key: 'appToken', label: 'App-Level Token (xapp-)', secret: true, hint: 'Socket Mode 用，scope connections:write' }, { key: 'botToken', label: 'Bot Token (xoxb-)', secret: true, hint: 'scopes: chat:write, app_mentions:read, im:history, im:read' }], help: '建 Slack App → 开启 Socket Mode → Event Subscriptions 订阅 message.im 与 app_mention → Interactivity 打开。私聊机器人或在频道 @它。' },
  { kind: 'feishu', name: '飞书 / Lark', icon: '🐦', inbound: true, fields: [{ key: 'appId', label: 'App ID' }, { key: 'appSecret', label: 'App Secret', secret: true }, { key: 'lark', label: 'Lark 国际版（true/false）', hint: '默认飞书国内' }], help: '开放平台建自建应用 → 添加机器人能力 → 事件订阅选「长连接」并订阅 im.message.receive_v1 与 card.action.trigger → 权限 im:message、im:message:send_as_bot → 发布版本。' },
  { kind: 'dingtalk', name: '钉钉', icon: '📌', inbound: true, fields: [{ key: 'clientId', label: 'Client ID (AppKey)' }, { key: 'clientSecret', label: 'Client Secret', secret: true }], help: '开放平台建应用 → 添加机器人 → 消息接收模式选 Stream → 发布。群里 @机器人 或单聊。' },
  { kind: 'wecom', name: '企业微信（仅通知）', icon: '🏢', inbound: false, fields: [{ key: 'webhookUrl', label: '群机器人 Webhook', secret: true }], help: '群设置 → 群机器人 → 添加 → 复制 Webhook。企业微信收消息需要公网回调地址，这里只做通知推送（需要你 / 完成 / 出错）。' },
];

/** Owns adapters for configured gateways, stores their configs (secrets protected), exposes status for the UI. */
export class ImService extends EventEmitter {
  router: ImRouter;
  private adapters = new Map<string, ImAdapter>();
  constructor(private meta: MetaStore, private secrets: SecretService, pool: RunnerPool, sessions: SessionService) {
    super();
    this.router = new ImRouter({ pool, meta, sessions });
  }

  async startAll() { for (const g of this.meta.imGateways()) if (g.enabled) await this.start(g).catch(() => {}); }

  private async revealed(g: ImGatewayConfig): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(g.config ?? {})) out[k] = typeof v === 'string' && v.startsWith('enc:') ? await this.secrets.reveal(v) : String(v ?? '');
    return out;
  }

  private async make(g: ImGatewayConfig): Promise<ImAdapter> {
    const c = await this.revealed(g);
    switch (g.kind) {
      case 'telegram': return new TelegramAdapter(c.botToken);
      case 'discord': return new DiscordAdapter(c.botToken);
      case 'slack': return new SlackAdapter(c.appToken, c.botToken);
      case 'feishu': return new FeishuAdapter(c.appId, c.appSecret, c.lark === 'true');
      case 'dingtalk': return new DingTalkAdapter(c.clientId, c.clientSecret);
      case 'wecom': return new WecomAdapter(c.webhookUrl);
      default: throw new Error(`未知网关类型 ${g.kind}`);
    }
  }

  async start(g: ImGatewayConfig) {
    await this.stop(g.id);
    const a = await this.make(g);
    a.on('state', () => this.emit('changed'));
    this.adapters.set(g.id, a);
    this.router.attach(g, a);
    await a.start();
    this.emit('changed');
  }

  async stop(id: string) {
    const a = this.adapters.get(id);
    if (!a) return;
    this.adapters.delete(id);
    this.router.detach(id);
    await a.stop().catch(() => {});
    this.emit('changed');
  }

  list(): ImGatewayInfo[] {
    return this.meta.imGateways().map((g) => {
      const a = this.adapters.get(g.id);
      const def = IM_KINDS.find((k) => k.kind === g.kind);
      const config: Record<string, string> = {};
      for (const [k, v] of Object.entries(g.config ?? {})) config[k] = def?.fields.find((f) => f.key === k)?.secret ? (v ? '••••••' : '') : String(v ?? '');
      const pc = this.router.pairCode(g.id);
      return { ...g, config, state: a?.state ?? 'stopped', error: a?.error ?? '', botName: a?.botName ?? '', inbound: def?.inbound ?? true, pairCode: pc?.code ?? '', pairExpiresAt: pc?.expiresAt ?? 0, bindings: this.meta.imBindings().filter((b) => b.gatewayId === g.id) };
    });
  }

  /** Create / update a gateway; secret fields that arrive masked keep their stored value. */
  async set(id: string, patch: Partial<ImGatewayConfig> | null): Promise<void> {
    if (patch === null) { await this.stop(id); await this.meta.removeImGateway(id); this.emit('changed'); return; }
    const prev = this.meta.imGateways().find((g) => g.id === id);
    const kind = (patch.kind ?? prev?.kind) as ImKind;
    const def = IM_KINDS.find((k) => k.kind === kind);
    if (!def) throw new Error('未知网关类型');
    const config: Record<string, string> = { ...(prev?.config ?? {}) };
    for (const [k, v] of Object.entries(patch.config ?? {})) {
      const f = def.fields.find((x) => x.key === k);
      if (f?.secret) { if (v && !/^•+$/.test(String(v))) config[k] = await this.secrets.protect(String(v).trim(), `im:${id}:${k}`); }
      else config[k] = String(v ?? '').trim();
    }
    const next: ImGatewayConfig = { id, kind, name: patch.name ?? prev?.name ?? def.name, enabled: patch.enabled ?? prev?.enabled ?? true, config, allowUsers: patch.allowUsers ?? prev?.allowUsers ?? [], allowNames: patch.allowNames ?? prev?.allowNames ?? {}, openAccess: patch.openAccess ?? prev?.openAccess ?? false, defaultCwd: patch.defaultCwd ?? prev?.defaultCwd ?? '', permissionMode: patch.permissionMode ?? prev?.permissionMode ?? 'default', agent: patch.agent ?? prev?.agent ?? '', verbose: patch.verbose ?? prev?.verbose ?? false };
    await this.meta.setImGateway(next);
    this.router.updateConfig(next);
    if (next.enabled) await this.start(next).catch(() => {}); else await this.stop(id);
    this.emit('changed');
  }

  /** Send a test message to every bound chat (or report there is none). */
  async test(id: string): Promise<string> {
    const a = this.adapters.get(id);
    if (!a) throw new Error('网关未启动');
    if (a.state !== 'running') throw new Error(a.error || `状态 ${a.state}`);
    const chats = this.meta.imBindings().filter((b) => b.gatewayId === id);
    if (!a.inbound) { await a.send('', '✅ Claude Web 测试消息'); return '已发送测试消息'; }
    if (!chats.length) return `已连接（${a.botName || a.kind}）。还没有聊天绑定：去 IM 里给机器人发 /pair <配对码>`;
    for (const c of chats) await a.send(c.chatId, '✅ Claude Web 测试消息');
    return `已向 ${chats.length} 个聊天发送测试消息`;
  }

  async stopAll() { for (const id of [...this.adapters.keys()]) await this.stop(id); }
}
