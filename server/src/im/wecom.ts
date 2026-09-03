import { EventEmitter } from 'node:events';
import { chunk, jsonFetch, type AdapterState, type ImAdapter, type OutboundOptions } from './types.js';

/**
 * WeCom (企业微信) group robot webhook — outbound notifications only: inbound messages need a public callback URL,
 * which a desktop app cannot offer. Use it to get "needs you" / "finished" pings; drive the session from another channel.
 */
export class WecomAdapter extends EventEmitter implements ImAdapter {
  readonly kind = 'wecom' as const;
  readonly maxLen = 1800; // 2048 bytes limit; CJK-safe margin
  readonly inbound = false;
  state: AdapterState = 'stopped';
  error = '';
  botName = '群机器人';
  constructor(private webhookUrl: string) { super(); }
  async start() { this.state = this.webhookUrl ? 'running' : 'error'; this.error = this.webhookUrl ? '' : '缺少 webhook 地址'; this.emit('state', this.state, this.error); }
  async stop() { this.state = 'stopped'; this.emit('state', 'stopped', ''); }
  async send(_chatId: string, text: string, o: OutboundOptions = {}) {
    const body = o.buttons?.length ? `${text}\n（请在电脑或其它 IM 上处理：${o.buttons.map((b) => b.label).join(' / ')}）` : text;
    for (const part of chunk(body || '(空)', this.maxLen)) {
      const r = await jsonFetch<any>(this.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content: part } }) });
      if (r && r.errcode) throw new Error(`wecom ${r.errcode}: ${r.errmsg}`);
    }
  }
}
