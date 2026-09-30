import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { proxyAgentFor } from '../net/proxy.js';
import { chunk, jsonFetch, type AdapterState, type ImAdapter, type OutboundOptions } from './types.js';

/** Slack app in Socket Mode (app-level token xapp- for the socket, bot token xoxb- for posting). */
export class SlackAdapter extends EventEmitter implements ImAdapter {
  readonly kind = 'slack' as const;
  readonly maxLen = 3800;
  readonly inbound = true;
  state: AdapterState = 'stopped';
  error = '';
  botName = '';
  private ws: WebSocket | null = null;
  private running = false;
  private wanted = false; // between start() and stop(): a dropped connection should come back
  private connected = false;
  private retry: NodeJS.Timeout | null = null;
  private botUserId = '';
  constructor(private appToken: string, private botToken: string) { super(); }
  private api(method: string, body: unknown, token = this.botToken) {
    return jsonFetch<any>(`https://slack.com/api/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) }).then((r) => { if (r && r.ok === false) throw new Error(`${method}: ${r.error}`); return r; });
  }
  private setState(s: AdapterState, err = '') { this.state = s; this.error = err; this.emit('state', s, err); }

  async start() {
    if (this.running) return;
    this.running = true;
    this.wanted = true;
    this.setState('starting');
    try {
      const auth = await this.api('auth.test', {});
      this.botUserId = auth.user_id ?? '';
      this.botName = auth.user ? `@${auth.user}` : '';
      const open = await this.api('apps.connections.open', {}, this.appToken);
      this.connect(open.url);
    } catch (e: any) { this.setState('error', e.message); this.running = false; if (this.connected) this.scheduleReconnect(30_000); }
  }

  /** Reconnect later unless stop() was called; one pending retry at most. */
  private scheduleReconnect(ms: number) {
    if (!this.wanted || this.retry) return;
    this.retry = setTimeout(() => { this.retry = null; if (this.wanted) void this.start().catch(() => {}); }, ms);
  }

  private connect(url: string) {
    const ws = new WebSocket(url, { agent: proxyAgentFor(url) });
    this.ws = ws;
    ws.on('message', (raw) => {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'hello') { this.connected = true; this.setState('running'); return; }
      if (m.envelope_id) { try { ws.send(JSON.stringify({ envelope_id: m.envelope_id })); } catch { /* closed */ } }
      if (m.type === 'disconnect') { ws.close(); return; }
      if (m.type === 'events_api') {
        const ev = m.payload?.event ?? {};
        if ((ev.type === 'message' || ev.type === 'app_mention') && !ev.bot_id && !ev.subtype && ev.user !== this.botUserId) {
          if (ev.type === 'message' && ev.channel_type !== 'im' && !String(ev.text ?? '').includes(`<@${this.botUserId}>`)) return; // channels: only when mentioned (app_mention delivers those)
          if (ev.type === 'app_mention' && ev.channel_type === 'im') return;
          const text = String(ev.text ?? '').replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
          if (!text) return;
          this.emit('message', { chatId: ev.channel, userId: ev.user, userName: ev.user, text, messageId: ev.ts, raw: ev });
        }
      } else if (m.type === 'interactive') {
        const p = m.payload ?? {};
        if (p.type !== 'block_actions') return;
        const a = p.actions?.[0];
        if (!a) return;
        this.emit('message', { chatId: p.channel?.id ?? p.container?.channel_id ?? '', userId: p.user?.id ?? '', userName: p.user?.username ?? p.user?.name ?? '', text: '', callback: a.value ?? a.action_id, raw: p });
        if (p.channel?.id && p.message?.ts) void this.api('chat.update', { channel: p.channel.id, ts: p.message.ts, text: p.message.text ?? '…', blocks: [] }).catch(() => {});
      }
    });
    ws.on('close', () => { if (ws === this.ws && this.running) { this.running = false; this.setState('error', '连接断开，重连中…'); this.scheduleReconnect(4000); } });
    ws.on('error', (e) => this.setState('error', e.message));
  }

  async stop() { this.running = false; this.wanted = false; if (this.retry) clearTimeout(this.retry); this.retry = null; try { this.ws?.close(); } catch { /* ignore */ } this.ws = null; this.setState('stopped'); }

  async send(chatId: string, text: string, o: OutboundOptions = {}) {
    const parts = chunk(text || '(空)', this.maxLen);
    for (let i = 0; i < parts.length; i++) {
      const body: any = { channel: chatId, text: parts[i] };
      if (i === parts.length - 1 && o.buttons?.length) {
        body.blocks = [{ type: 'section', text: { type: 'mrkdwn', text: parts[i].slice(0, 2900) } }, { type: 'actions', elements: o.buttons.map((b) => ({ type: 'button', text: { type: 'plain_text', text: b.label.slice(0, 75) }, action_id: b.id.slice(0, 255), value: b.id.slice(0, 2000), ...(b.danger ? { style: 'danger' } : {}) })) }];
      }
      await this.api('chat.postMessage', body);
    }
  }
}
