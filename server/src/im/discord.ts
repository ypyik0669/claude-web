import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { chunk, jsonFetch, type AdapterState, type ImAdapter, type OutboundOptions } from './types.js';

const API = 'https://discord.com/api/v10';
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15); // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT

/** Discord bot over the Gateway (websocket) — DMs and channel messages; buttons are message components. */
export class DiscordAdapter extends EventEmitter implements ImAdapter {
  readonly kind = 'discord' as const;
  readonly maxLen = 1900;
  readonly inbound = true;
  state: AdapterState = 'stopped';
  error = '';
  botName = '';
  private ws: WebSocket | null = null;
  private hb: NodeJS.Timeout | null = null;
  private seq: number | null = null;
  private running = false;
  private wanted = false; // between start() and stop(): a dropped connection should come back
  private connected = false;
  private retry: NodeJS.Timeout | null = null;
  private botId = '';
  constructor(private token: string) { super(); }
  private rest(path: string, body?: unknown, method = 'POST') {
    return jsonFetch<any>(`${API}${path}`, { method, headers: { authorization: `Bot ${this.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  }
  private setState(s: AdapterState, err = '') { this.state = s; this.error = err; this.emit('state', s, err); }

  async start() {
    if (this.running) return;
    this.running = true;
    this.wanted = true;
    this.setState('starting');
    try {
      const g = await this.rest('/gateway/bot', undefined, 'GET');
      this.connect(`${g.url}/?v=10&encoding=json`);
    } catch (e: any) { this.setState('error', e.message); this.running = false; if (this.connected) this.scheduleReconnect(30_000); }
  }

  /** Reconnect later unless stop() was called; one pending retry at most. */
  private scheduleReconnect(ms: number) {
    if (!this.wanted || this.retry) return;
    this.retry = setTimeout(() => { this.retry = null; if (this.wanted) void this.start().catch(() => {}); }, ms);
  }

  private connect(url: string) {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('message', (raw) => {
      let p: any;
      try { p = JSON.parse(String(raw)); } catch { return; }
      if (p.s) this.seq = p.s;
      switch (p.op) {
        case 10: { // hello
          const interval = p.d.heartbeat_interval;
          if (this.hb) clearInterval(this.hb);
          this.hb = setInterval(() => { try { ws.send(JSON.stringify({ op: 1, d: this.seq })); } catch { /* closed */ } }, interval);
          ws.send(JSON.stringify({ op: 2, d: { token: this.token, intents: INTENTS, properties: { os: process.platform, browser: 'claude-web', device: 'claude-web' } } }));
          break;
        }
        case 7: case 9: ws.close(); break; // reconnect / invalid session
        case 0: this.dispatch(p.t, p.d); break;
        default: break;
      }
    });
    ws.on('close', () => { if (ws !== this.ws) return; if (this.hb) clearInterval(this.hb); this.hb = null; if (this.running) { this.running = false; this.setState('error', '连接断开，重连中…'); this.scheduleReconnect(5000); } });
    ws.on('error', (e) => this.setState('error', e.message));
  }

  private dispatch(t: string, d: any) {
    if (t === 'READY') { this.connected = true; this.botId = d.user?.id ?? ''; this.botName = d.user?.username ? `@${d.user.username}` : ''; this.setState('running'); return; }
    if (t === 'MESSAGE_CREATE') {
      if (!d.author || d.author.bot) return;
      let text: string = d.content ?? '';
      if (this.botId) text = text.replace(new RegExp(`<@!?${this.botId}>`, 'g'), '').trim();
      if (!text) return;
      this.emit('message', { chatId: d.channel_id, userId: d.author.id, userName: d.author.global_name ?? d.author.username ?? '', text, messageId: d.id, raw: d });
      return;
    }
    if (t === 'INTERACTION_CREATE' && d.type === 3) {
      void this.rest(`/interactions/${d.id}/${d.token}/callback`, { type: 6 }).catch(() => {});
      const user = d.member?.user ?? d.user ?? {};
      if (d.message?.id) void this.rest(`/channels/${d.channel_id}/messages/${d.message.id}`, { components: [] }, 'PATCH').catch(() => {});
      this.emit('message', { chatId: d.channel_id, userId: user.id ?? '', userName: user.global_name ?? user.username ?? '', text: '', callback: d.data?.custom_id, raw: d });
    }
  }

  async stop() { this.running = false; this.wanted = false; if (this.retry) clearTimeout(this.retry); this.retry = null; if (this.hb) clearInterval(this.hb); this.hb = null; try { this.ws?.close(); } catch { /* ignore */ } this.ws = null; this.setState('stopped'); }

  async send(chatId: string, text: string, o: OutboundOptions = {}) {
    const parts = chunk(text || '(空)', this.maxLen);
    for (let i = 0; i < parts.length; i++) {
      const body: any = { content: parts[i] };
      if (i === parts.length - 1 && o.buttons?.length) body.components = [{ type: 1, components: o.buttons.map((b) => ({ type: 2, style: b.danger ? 4 : 1, label: b.label.slice(0, 80), custom_id: b.id.slice(0, 100) })) }];
      await this.rest(`/channels/${chatId}/messages`, body);
    }
  }
}
