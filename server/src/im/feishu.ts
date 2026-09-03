import { EventEmitter } from 'node:events';
import { chunk, type AdapterState, type ImAdapter, type OutboundOptions } from './types.js';

/** Feishu / Lark bot over the SDK's long connection (no public URL). Buttons are interactive cards → card.action.trigger. */
export class FeishuAdapter extends EventEmitter implements ImAdapter {
  readonly kind = 'feishu' as const;
  readonly maxLen = 4000;
  readonly inbound = true;
  state: AdapterState = 'stopped';
  error = '';
  botName = 'Feishu';
  private client: any = null;
  private wsClient: any = null;
  private running = false;
  constructor(private appId: string, private appSecret: string, private lark = false) { super(); }
  private setState(s: AdapterState, err = '') { this.state = s; this.error = err; this.emit('state', s, err); }

  async start() {
    if (this.running) return;
    this.running = true;
    this.setState('starting');
    try {
      const Lark: any = await import('@larksuiteoapi/node-sdk');
      const domain = this.lark ? Lark.Domain.Lark : Lark.Domain.Feishu;
      this.client = new Lark.Client({ appId: this.appId, appSecret: this.appSecret, appType: Lark.AppType.SelfBuild, domain, loggerLevel: Lark.LoggerLevel.error });
      const dispatcher = new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: any) => {
          const m = data.message ?? {};
          if (m.message_type !== 'text') return;
          let text = '';
          try { text = JSON.parse(m.content ?? '{}').text ?? ''; } catch { /* ignore */ }
          text = text.replace(/@_user_\d+/g, '').trim();
          if (!text) return;
          const sender = data.sender?.sender_id ?? {};
          this.emit('message', { chatId: m.chat_id, userId: sender.open_id ?? sender.user_id ?? '', userName: '', text, messageId: m.message_id, raw: data });
        },
        'card.action.trigger': async (data: any) => {
          const id = data.action?.value?.id;
          if (!id) return {};
          this.emit('message', { chatId: data.context?.open_chat_id ?? '', userId: data.operator?.open_id ?? '', userName: '', text: '', callback: id, raw: data });
          return { toast: { type: 'success', content: '已收到' } };
        },
      });
      this.wsClient = new Lark.WSClient({ appId: this.appId, appSecret: this.appSecret, domain, loggerLevel: Lark.LoggerLevel.error });
      await this.wsClient.start({ eventDispatcher: dispatcher });
      try { const info = await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }); this.botName = info?.bot?.app_name ?? this.botName; } catch { /* optional */ }
      this.setState('running');
    } catch (e: any) { this.setState('error', e.message); this.running = false; }
  }

  async stop() {
    this.running = false;
    try { await this.wsClient?.close?.(); } catch { /* ignore */ }
    this.wsClient = null;
    this.setState('stopped');
  }

  async send(chatId: string, text: string, o: OutboundOptions = {}) {
    if (!this.client) throw new Error('未连接');
    const parts = chunk(text || '(空)', this.maxLen);
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      if (last && o.buttons?.length) {
        const card = { config: { wide_screen_mode: true }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: parts[i] } }, { tag: 'action', actions: o.buttons.map((b) => ({ tag: 'button', text: { tag: 'plain_text', content: b.label }, type: b.danger ? 'danger' : 'primary', value: { id: b.id } })) }] };
        await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) } });
      } else {
        await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: parts[i] }) } });
      }
    }
  }
}
