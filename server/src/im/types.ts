import type { EventEmitter } from 'node:events';
import type { ImKind } from '../protocol.js';

export interface InboundMessage {
  chatId: string; // channel / chat / conversation id the reply goes to
  userId: string;
  userName: string;
  text: string;
  callback?: string; // button press payload (perm:<id>:allow …)
  messageId?: string;
  raw?: unknown;
}

export interface OutboundOptions {
  buttons?: { id: string; label: string; danger?: boolean }[]; // one row of buttons
  markdown?: boolean;
}

export type AdapterState = 'stopped' | 'starting' | 'running' | 'error';

/** One chat platform connection. Emits 'message' (InboundMessage) and 'state'. */
export interface ImAdapter extends EventEmitter {
  readonly kind: ImKind;
  readonly maxLen: number; // platform text limit per message
  readonly inbound: boolean; // false = notify-only (webhook bots)
  state: AdapterState;
  error: string;
  botName: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, text: string, o?: OutboundOptions): Promise<void>;
}

/** Split long replies at paragraph / line boundaries so each chunk fits the platform limit. */
export function chunk(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.3) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

export async function jsonFetch<T = any>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), init.timeoutMs ?? 30_000);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    const text = await r.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 200)}`);
    return body as T;
  } finally { clearTimeout(t); }
}
