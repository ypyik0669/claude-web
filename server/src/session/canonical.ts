import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { dataDir } from '../files/service.js';
import type { AgentKind } from '../protocol.js';

/**
 * The canonical timeline: one provider-neutral record of what happened in a session, kept
 * alongside whatever native transcript the agent writes for itself.
 *
 * It exists because a session can outlive the agent that started it. Claude keeps its own JSONL,
 * Codex keeps rollouts, ACP agents keep nothing — none of those can be handed to another vendor.
 * So we mirror every session into one shape here and hand *that* to whoever picks the session up.
 *
 * What is deliberately NOT stored: thinking / reasoning. Claude's thinking blocks carry a
 * `signature` and Codex's reasoning items carry `encrypted_content`; neither validates outside its
 * origin provider, so no cross-agent scheme can carry them. OpenAI's own Claude importer drops them
 * too. Re-deriving reasoning is cheaper than the failure modes of faking it.
 */

export type CanonicalEvent =
  | { t: number; kind: 'user'; text: string; uuid?: string }
  | { t: number; kind: 'assistant'; text: string; uuid?: string }
  | { t: number; kind: 'tool'; name: string; input: Record<string, unknown>; ok?: boolean; result?: string; id: string }
  | { t: number; kind: 'system'; text: string; level?: 'info' | 'warning' | 'error' }
  | { t: number; kind: 'result'; ms?: number; costUsd?: number; inputTokens?: number; outputTokens?: number; error?: string }
  | { t: number; kind: 'switch'; agent?: AgentKind; agentName?: string; providerId?: string; providerName?: string; model?: string; note?: string };

interface Head { type: 'cw.canonical'; sessionId: string; createdAt: number; cwd: string }

const MAX_RESULT_CHARS = 600;
const MAX_TEXT_CHARS = 8000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…（截断 ${s.length - n} 字）` : s);

/** Text of an SDK content block list, ignoring thinking. */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('');
}

export class CanonicalLog {
  private dir = path.join(dataDir(), 'canonical');
  private writers = new Map<string, Promise<void>>();
  /** tool_use id → the event we already wrote, so the matching tool_result can patch it */
  private open = new Map<string, Map<string, CanonicalEvent & { kind: 'tool' }>>();

  file(sessionId: string) {
    return path.join(this.dir, `${sessionId}.jsonl`);
  }

  async ensure(sessionId: string, cwd: string) {
    await fs.mkdir(this.dir, { recursive: true });
    if (await this.exists(sessionId)) return;
    const head: Head = { type: 'cw.canonical', sessionId, createdAt: Date.now(), cwd };
    await fs.writeFile(this.file(sessionId), `${JSON.stringify(head)}\n`, 'utf8');
  }

  async exists(sessionId: string) {
    return !!(await fs.stat(this.file(sessionId)).catch(() => null));
  }

  private write(sessionId: string, e: CanonicalEvent) {
    const line = `${JSON.stringify(e)}\n`;
    const prev = this.writers.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        if (await this.exists(sessionId)) await fs.appendFile(this.file(sessionId), line, 'utf8');
      })
      .catch(() => { /* a broken mirror must never break the session */ });
    this.writers.set(sessionId, next);
  }

  /** Record an explicit marker (agent / provider switch). */
  mark(sessionId: string, e: Omit<Extract<CanonicalEvent, { kind: 'switch' }>, 't' | 'kind'>) {
    this.write(sessionId, { t: Date.now(), kind: 'switch', ...e });
  }

  /**
   * Mirror one SDK message. Every driver emits this shape (foreign agents go through
   * `MessageSynth` first), so this is the only place that has to know about message形状.
   */
  observe(sessionId: string, m: any) {
    if (!m || typeof m !== 'object') return;
    const t = Date.now();
    switch (m.type) {
      case 'user': {
        const content = m.message?.content;
        // a tool_result arrives as a user message — attach it to the tool event, don't log a turn
        if (Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result')) {
          const tools = this.open.get(sessionId);
          for (const b of content) {
            if (b?.type !== 'tool_result') continue;
            const ev = tools?.get(b.tool_use_id);
            if (!ev) continue;
            ev.ok = !b.is_error;
            ev.result = clip(blockText(b.content) || (b.is_error ? '失败' : '完成'), MAX_RESULT_CHARS);
            tools!.delete(b.tool_use_id);
            this.write(sessionId, ev);
          }
          return;
        }
        const text = blockText(content);
        if (text.trim()) this.write(sessionId, { t, kind: 'user', text: clip(text, MAX_TEXT_CHARS), uuid: m.uuid });
        return;
      }
      case 'assistant': {
        const content = m.message?.content;
        if (!Array.isArray(content)) return;
        const text = blockText(content);
        if (text.trim()) this.write(sessionId, { t, kind: 'assistant', text: clip(text, MAX_TEXT_CHARS), uuid: m.uuid });
        for (const b of content) {
          if (b?.type !== 'tool_use') continue;
          // held until the tool_result lands so one line carries the call and its outcome
          const ev: CanonicalEvent & { kind: 'tool' } = { t, kind: 'tool', name: String(b.name), input: (b.input ?? {}) as Record<string, unknown>, id: String(b.id) };
          let tools = this.open.get(sessionId);
          if (!tools) this.open.set(sessionId, (tools = new Map()));
          tools.set(ev.id, ev);
        }
        return;
      }
      case 'system': {
        if (m.subtype === 'init' || m.subtype === 'status') return;
        const text = typeof m.text === 'string' ? m.text : typeof m.message === 'string' ? m.message : '';
        if (text.trim()) this.write(sessionId, { t, kind: 'system', text: clip(text, 1000), level: m.level });
        return;
      }
      case 'result': {
        this.write(sessionId, {
          t,
          kind: 'result',
          ms: m.duration_ms,
          costUsd: m.total_cost_usd,
          inputTokens: m.usage?.input_tokens,
          outputTokens: m.usage?.output_tokens,
          error: m.is_error ? String(m.result ?? m.subtype ?? 'error').slice(0, 300) : undefined,
        });
        // any tool that never got a result is stranded — record it so the timeline isn't silently short
        const tools = this.open.get(sessionId);
        if (tools?.size) {
          for (const ev of tools.values()) this.write(sessionId, { ...ev, ok: false, result: '（没有返回结果）' });
          tools.clear();
        }
        return;
      }
      default:
        return; // stream_event / rate_limit_event / etc. add nothing the timeline needs
    }
  }

  async load(sessionId: string): Promise<CanonicalEvent[]> {
    const out: CanonicalEvent[] = [];
    if (!(await this.exists(sessionId))) return out;
    const rl = readline.createInterface({ input: createReadStream(this.file(sessionId), 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e?.type !== 'cw.canonical') out.push(e);
      } catch { /* skip a torn line */ }
    }
    return out;
  }

  async head(sessionId: string): Promise<Head | null> {
    try {
      const rl = readline.createInterface({ input: createReadStream(this.file(sessionId), 'utf8'), crlfDelay: Infinity });
      for await (const line of rl) {
        rl.close();
        const h = JSON.parse(line);
        return h?.type === 'cw.canonical' ? h : null;
      }
    } catch { /* missing */ }
    return null;
  }

  async remove(sessionId: string) {
    this.open.delete(sessionId);
    await fs.rm(this.file(sessionId), { force: true });
  }
}
