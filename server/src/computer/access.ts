import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PermissionRequestEvent, PermissionResponse } from '../protocol.js';

/**
 * Who says yes to 操控电脑 — the user, in a window of this app, every time.
 *
 * The `computer` MCP server grants nothing by itself: its `request_access` comes here (POST /api/computer/ask,
 * computer/http.ts), and this raises the same permission card a tool call does, for that conversation. It is NOT the
 * agent's own permission prompt, on purpose: in 「完全放开」 (bypassPermissions) or 「自动判断」 a tool call is never
 * shown to the user, and an agent that could approve its own access to the whole desktop would have it. So the
 * answer does not depend on the conversation's permission mode, nor on which agent it is.
 *
 * A request nobody answers is a no after ASK_TIMEOUT_MS; so is one whose conversation is not open here.
 * IM bots are not asked (they listen to the pool's own permission events): control of the desktop is approved from
 * a window of the app.
 */

/** The server's name as agents are told it — `computer-use` is reserved by Claude Code (both engines refuse it). */
export const COMPUTER_SERVER = 'computer';
/** The tool the card is shown for, by the name the model called. */
export const ACCESS_TOOL = `mcp__${COMPUTER_SERVER}__request_access`;
/** Shorter than the five minutes Node's fetch waits for an answer's headers: the MCP process hears the no from us. */
export const ASK_TIMEOUT_MS = 4 * 60_000;

export interface AccessRequest { apps: string[]; reason: string; clipboardRead?: boolean; clipboardWrite?: boolean; systemKeyCombos?: boolean }
export type AccessAnswer = { granted: true } | { granted: false; message: string };

interface Waiting { event: PermissionRequestEvent; resolve: (a: AccessAnswer) => void; timer: NodeJS.Timeout }

export interface AccessDeps {
  /** is this conversation open in this server? (a request for one that is not is refused unasked) */
  knows?: (sessionId: string) => boolean;
  timeoutMs?: number;
}

/** What the card shows, made sure of: a few short names and one sentence. Null: not a request. */
export function cleanRequest(body: unknown): AccessRequest | null {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (!Array.isArray(o.apps)) return null;
  const apps = [...new Set(o.apps.filter((a): a is string => typeof a === 'string').map((a) => a.replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean))].slice(0, 20);
  if (!apps.length) return null;
  const reason = typeof o.reason === 'string' ? o.reason.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  return {
    apps,
    reason,
    ...(o.clipboardRead === true ? { clipboardRead: true } : {}),
    ...(o.clipboardWrite === true ? { clipboardWrite: true } : {}),
    ...(o.systemKeyCombos === true ? { systemKeyCombos: true } : {}),
  };
}

export class ComputerAccess extends EventEmitter {
  /** What a `computer` MCP process must present to /api/computer/ask: made anew at every start, never stored. */
  readonly token = randomBytes(32).toString('hex');
  private waiting = new Map<string, Waiting>();

  constructor(private d: AccessDeps = {}) {
    super();
  }

  tokenOk(presented: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Ask the user. Resolves when a window answers, when `signal` aborts (the MCP process went away) or after the
   * time limit. `cancel` in the result: withdraw the card (the caller is gone).
   */
  ask(sessionId: string, req: AccessRequest, signal?: AbortSignal): Promise<AccessAnswer> {
    if (!sessionId || (this.d.knows && !this.d.knows(sessionId))) {
      return Promise.resolve({ granted: false, message: 'This conversation is not open in Claude Web, so the user cannot be asked. Nothing was granted.' });
    }
    if (signal?.aborted) return Promise.resolve({ granted: false, message: 'cancelled' });
    const requestId = randomUUID();
    const event: PermissionRequestEvent = { requestId, sessionId, toolName: ACCESS_TOOL, input: { ...req } };
    return new Promise<AccessAnswer>((resolve) => {
      const done = (a: AccessAnswer) => {
        const w = this.waiting.get(requestId);
        if (!w) return;
        this.waiting.delete(requestId);
        clearTimeout(w.timer);
        resolve(a);
        this.emit('permissionResolved', requestId, sessionId);
      };
      const timer = setTimeout(() => done({ granted: false, message: 'The user did not answer the request in time, so nothing was granted. Tell the user what you need and ask again when they are there.' }), this.d.timeoutMs ?? ASK_TIMEOUT_MS);
      timer.unref?.();
      this.waiting.set(requestId, { event, resolve: done, timer });
      signal?.addEventListener('abort', () => done({ granted: false, message: 'cancelled' }), { once: true });
      this.emit('permission', event);
    });
  }

  /** The requests of a conversation that are still open (a window opening it later shows them). */
  pendingFor(sessionId: string): PermissionRequestEvent[] {
    return [...this.waiting.values()].filter((w) => w.event.sessionId === sessionId).map((w) => w.event);
  }

  /** A window's answer. False: not one of ours (or answered already). */
  respond(requestId: string, r: PermissionResponse): boolean {
    const w = this.waiting.get(requestId);
    if (!w) return false;
    if (r.behavior === 'allow') w.resolve({ granted: true });
    else w.resolve({ granted: false, message: `The user declined${r.message?.trim() ? `: ${r.message.trim().slice(0, 500)}` : ''}. Nothing was granted. Do not ask again unless the user tells you to.` });
    return true;
  }

  /** The conversation is gone: what it asked is withdrawn. */
  drop(sessionId: string): void {
    for (const w of [...this.waiting.values()]) if (w.event.sessionId === sessionId) w.resolve({ granted: false, message: 'The conversation was closed.' });
  }
}
