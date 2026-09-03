import { EventEmitter } from 'node:events';
import { chunk, jsonFetch, type AdapterState, type ImAdapter, type OutboundOptions } from './types.js';

/** Telegram Bot API over long polling (no public URL needed). Buttons are inline keyboards → callback_query. */
export class TelegramAdapter extends EventEmitter implements ImAdapter {
  readonly kind = 'telegram' as const;
  readonly maxLen = 4000;
  readonly inbound = true;
  state: AdapterState = 'stopped';
  error = '';
  botName = '';
  private offset = 0;
  private ac: AbortController | null = null;
  private running = false;
  constructor(private token: string) { super(); }
  private api(method: string, body?: unknown, timeoutMs = 30_000) {
    return jsonFetch<any>(`https://api.telegram.org/bot${this.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, timeoutMs, signal: this.ac?.signal as any });
  }
  private setState(s: AdapterState, err = '') { this.state = s; this.error = err; this.emit('state', s, err); }

  async start() {
    if (this.running) return;
    this.running = true;
    this.ac = new AbortController();
    this.setState('starting');
    try {
      const me = await this.api('getMe');
      this.botName = me.result?.username ? `@${me.result.username}` : me.result?.first_name ?? '';
      this.setState('running');
      void this.loop();
    } catch (e: any) { this.setState('error', e.message); this.running = false; }
  }

  private async loop() {
    while (this.running) {
      try {
        const r = await this.api('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 40_000);
        for (const u of r.result ?? []) {
          this.offset = u.update_id + 1;
          if (u.message) {
            const m = u.message;
            const text = m.text ?? m.caption ?? '';
            if (!text) continue;
            this.emit('message', { chatId: String(m.chat.id), userId: String(m.from?.id ?? ''), userName: m.from?.username ?? m.from?.first_name ?? '', text, messageId: String(m.message_id), raw: m });
          } else if (u.callback_query) {
            const q = u.callback_query;
            void this.api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
            if (q.message) void this.api('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
            this.emit('message', { chatId: String(q.message?.chat.id ?? q.from.id), userId: String(q.from.id), userName: q.from.username ?? q.from.first_name ?? '', text: '', callback: q.data, raw: q });
          }
        }
        if (this.state !== 'running') this.setState('running');
      } catch (e: any) {
        if (!this.running) break;
        this.setState('error', e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async stop() { this.running = false; this.ac?.abort(); this.ac = null; this.setState('stopped'); }

  async send(chatId: string, text: string, o: OutboundOptions = {}) {
    const parts = chunk(text || '(空)', this.maxLen);
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const body: any = { chat_id: chatId, text: parts[i], disable_web_page_preview: true };
      if (last && o.buttons?.length) body.reply_markup = { inline_keyboard: [o.buttons.map((b) => ({ text: b.label, callback_data: b.id.slice(0, 64) }))] };
      await this.api('sendMessage', body);
    }
  }
}
