import { EventEmitter } from 'node:events';
import os from 'node:os';
import WebSocket from 'ws';
import { chunk, jsonFetch, type AdapterState, type ImAdapter, type OutboundOptions } from './types.js';

/** DingTalk robot in Stream mode (websocket, no public callback URL). Replies go through the per-conversation sessionWebhook. */
export class DingTalkAdapter extends EventEmitter implements ImAdapter {
  readonly kind = 'dingtalk' as const;
  readonly maxLen = 4000;
  readonly inbound = true;
  state: AdapterState = 'stopped';
  error = '';
  botName = 'DingTalk';
  private ws: WebSocket | null = null;
  private running = false;
  private webhooks = new Map<string, { url: string; expiresAt: number }>();
  private accessToken: { token: string; expiresAt: number } | null = null;
  constructor(private clientId: string, private clientSecret: string) { super(); }
  private setState(s: AdapterState, err = '') { this.state = s; this.error = err; this.emit('state', s, err); }

  async start() {
    if (this.running) return;
    this.running = true;
    this.setState('starting');
    try {
      const r = await jsonFetch<any>('https://api.dingtalk.com/v1.0/gateway/connections/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: this.clientId, clientSecret: this.clientSecret, subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }], ua: 'claude-web/0.1', localIp: firstIp() }) });
      if (!r.endpoint || !r.ticket) throw new Error(`gateway: ${JSON.stringify(r).slice(0, 200)}`);
      this.connect(`${r.endpoint}?ticket=${encodeURIComponent(r.ticket)}`);
    } catch (e: any) { this.setState('error', e.message); this.running = false; }
  }

  private connect(url: string) {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('open', () => this.setState('running'));
    ws.on('message', (raw) => {
      let f: any;
      try { f = JSON.parse(String(raw)); } catch { return; }
      const h = f.headers ?? {};
      const reply = (data: unknown) => { try { ws.send(JSON.stringify({ code: 200, headers: { contentType: 'application/json', messageId: h.messageId }, message: 'OK', data: typeof data === 'string' ? data : JSON.stringify(data) })); } catch { /* closed */ } };
      if (f.type === 'SYSTEM') { if (h.topic === 'ping') reply(f.data ?? '{}'); else if (h.topic === 'disconnect') ws.close(); return; }
      if (f.type === 'CALLBACK' && h.topic === '/v1.0/im/bot/messages/get') {
        reply({ response: {} });
        let d: any;
        try { d = JSON.parse(f.data); } catch { return; }
        const chatId = d.conversationId ?? '';
        if (d.sessionWebhook) this.webhooks.set(chatId, { url: d.sessionWebhook, expiresAt: d.sessionWebhookExpiredTime ?? Date.now() + 60 * 60_000 });
        const text = (d.text?.content ?? '').trim();
        if (!text) return;
        this.emit('message', { chatId, userId: d.senderStaffId ?? d.senderId ?? '', userName: d.senderNick ?? '', text, messageId: d.msgId, raw: d });
      }
    });
    ws.on('close', () => { if (this.running) { this.running = false; this.setState('error', '连接断开，重连中…'); setTimeout(() => { void this.start().catch(() => {}); }, 5000); } });
    ws.on('error', (e) => this.setState('error', e.message));
  }

  async stop() { this.running = false; try { this.ws?.close(); } catch { /* ignore */ } this.ws = null; this.setState('stopped'); }

  private async token() {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) return this.accessToken.token;
    const r = await jsonFetch<any>('https://api.dingtalk.com/v1.0/oauth2/accessToken', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appKey: this.clientId, appSecret: this.clientSecret }) });
    this.accessToken = { token: r.accessToken, expiresAt: Date.now() + (r.expireIn ?? 7000) * 1000 - 60_000 };
    return r.accessToken as string;
  }

  async send(chatId: string, text: string, o: OutboundOptions = {}) {
    const body = o.buttons?.length ? `${text}\n\n${o.buttons.map((b, i) => `${i + 1}. ${b.label}`).join('  ')}\n（回复序号或 /allow /deny）` : text;
    const wh = this.webhooks.get(chatId);
    for (const part of chunk(body || '(空)', this.maxLen)) {
      if (wh && wh.expiresAt > Date.now()) {
        await jsonFetch(wh.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content: part } }) });
      } else {
        // webhook expired: proactive group message via the robot API (needs the app's robotCode = clientId)
        const tk = await this.token();
        await jsonFetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', { method: 'POST', headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': tk }, body: JSON.stringify({ robotCode: this.clientId, openConversationId: chatId, msgKey: 'sampleText', msgParam: JSON.stringify({ content: part }) }) });
      }
    }
  }
}

function firstIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}
