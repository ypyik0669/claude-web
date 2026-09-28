// Failover policy for gateway groups: which member to try next, what an upstream failure means, and how
// long a member cools down. Pure functions + a small state table so it can be unit-tested without HTTP.
import type { GatewayGroup, GatewayMember } from './types.js';

export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 30 * 60_000;
/** 5xx / network / timeout: skip the member briefly so every request doesn't hit it first. */
export const TRANSIENT_COOLDOWN_MS = 15_000;

export interface MemberRuntime {
  strikes: number; // consecutive rate-limit / quota hits → exponential backoff
  cooldownUntil: number;
  cooldownKind?: 'rate' | 'transient';
  disabled: boolean;
  lastError?: string;
  lastStatus?: number;
  lastOkAt?: number;
  lastUsedAt?: number;
  lastFailAt?: number; // when the latest failure was recorded (orders concurrent outcomes)
}

export type Verdict =
  | { action: 'final' } // the client's problem (400/404/413/422…): do not switch, return as is
  | { action: 'switch'; kind: 'rate'; cooldownMs: number } // 429 / quota exhausted
  | { action: 'switch'; kind: 'transient' } // 5xx / 529 / network / timeout
  | { action: 'switch'; kind: 'auth' }; // 401 / 403: member disabled until the user resets it

/** Error text that means "this account is out of money / quota", whatever the status code. */
const QUOTA_RE = /quota|insufficient[_ ]?(balance|funds|credit)|credit balance|billing|余额|额度|用尽|欠费|exceeded your current|out of credits|payment required|usage limit/i;

type Headers = Record<string, string | string[] | undefined>;
const h1 = (h: Headers, k: string) => { const v = h[k]; return Array.isArray(v) ? v[0] : v; };

/** `6m0s`, `1.5s`, `20ms`, `2h` (OpenAI x-ratelimit-reset-*) → ms. */
export function parseDuration(s: string): number | null {
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let hit = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) { hit = true; total += Number(m[1]) * (m[2] === 'ms' ? 1 : m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : 3_600_000); }
  return hit ? total : null;
}

/** How long a rate-limited member should rest, from `retry-after` / `anthropic-ratelimit-*-reset` / `x-ratelimit-reset-*`. */
export function cooldownFromHeaders(h: Headers, now = Date.now()): number | null {
  const ra = h1(h, 'retry-after');
  if (ra) {
    if (/^\d+(\.\d+)?$/.test(ra.trim())) return Math.max(0, Number(ra) * 1000);
    const t = Date.parse(ra);
    if (!Number.isNaN(t)) return Math.max(0, t - now);
  }
  const exhausted: number[] = [];
  const all: number[] = [];
  for (const kind of ['requests', 'tokens', 'input-tokens', 'output-tokens']) {
    const reset = h1(h, `anthropic-ratelimit-${kind}-reset`);
    if (reset) {
      const t = Date.parse(reset);
      if (!Number.isNaN(t)) { all.push(t - now); if (h1(h, `anthropic-ratelimit-${kind}-remaining`) === '0') exhausted.push(t - now); }
    }
    const oai = h1(h, `x-ratelimit-reset-${kind}`);
    if (oai) {
      const d = parseDuration(oai);
      if (d !== null) { all.push(d); if (h1(h, `x-ratelimit-remaining-${kind}`) === '0') exhausted.push(d); }
    }
  }
  if (exhausted.length) return Math.max(0, Math.max(...exhausted));
  if (all.length) return Math.max(0, Math.min(...all));
  return null;
}

export const backoffMs = (strikes: number) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, strikes));

/** Classify an upstream HTTP failure. `strikes` = the member's consecutive rate-limit hits so far. */
export function classify(status: number, headers: Headers, bodyText: string, strikes: number): Verdict {
  const quota = QUOTA_RE.test(bodyText);
  if (status === 429 || status === 402 || (quota && status >= 400 && status < 500)) {
    const fromHeaders = status === 429 ? cooldownFromHeaders(headers) : null;
    return { action: 'switch', kind: 'rate', cooldownMs: fromHeaders ?? backoffMs(strikes) };
  }
  if (status === 401 || status === 403) return { action: 'switch', kind: 'auth' };
  if (status >= 500 || status === 408) return { action: 'switch', kind: 'transient' };
  return { action: 'final' };
}

/** Mutable per-member runtime state, keyed by group + provider. */
export class MemberStates {
  private map = new Map<string, MemberRuntime>();
  private rr = new Map<string, Map<string, number>>(); // smooth weighted round-robin current weights
  get(groupId: string, providerId: string): MemberRuntime {
    const k = `${groupId}\u0000${providerId}`;
    let s = this.map.get(k);
    if (!s) { s = { strikes: 0, cooldownUntil: 0, disabled: false }; this.map.set(k, s); }
    return s;
  }
  peek(groupId: string, providerId: string): MemberRuntime | undefined {
    return this.map.get(`${groupId}\u0000${providerId}`);
  }
  reset(groupId: string, providerId?: string) {
    for (const k of [...this.map.keys()]) if (k.startsWith(`${groupId}\u0000`) && (!providerId || k === `${groupId}\u0000${providerId}`)) this.map.delete(k);
    if (!providerId) this.rr.delete(groupId);
  }

  available(groupId: string, m: GatewayMember, now = Date.now()) {
    const s = this.peek(groupId, m.providerId);
    return !s || (!s.disabled && s.cooldownUntil <= now);
  }

  /**
   * Members to try for one request, in order. Cooling / disabled members are left out. `failover`
   * keeps the configured order; `round-robin` picks the first by smooth weighted round-robin and
   * then falls back through the rest in configured order.
   */
  order(g: GatewayGroup, now = Date.now()): GatewayMember[] {
    const avail = g.members.filter((m) => this.available(g.id, m, now));
    if (g.strategy !== 'round-robin' || avail.length < 2) return avail;
    let cw = this.rr.get(g.id);
    if (!cw) { cw = new Map(); this.rr.set(g.id, cw); }
    let total = 0;
    let best: GatewayMember | null = null;
    for (const m of avail) {
      const w = Math.max(1, Math.floor(m.weight ?? 1));
      total += w;
      const v = (cw.get(m.providerId) ?? 0) + w;
      cw.set(m.providerId, v);
      if (!best || v > (cw.get(best.providerId) ?? 0)) best = m;
    }
    cw.set(best!.providerId, (cw.get(best!.providerId) ?? 0) - total);
    return [best!, ...avail.filter((m) => m !== best)];
  }

  /**
   * Record a failed attempt and apply the verdict (cooldown / disable). `sentAt` is when that attempt was
   * sent: if the member was already put on cooldown after it went out, a concurrent request got there
   * first — this one only refreshes the error text, it must not add a backoff strike on top.
   */
  fail(groupId: string, providerId: string, v: Verdict | { action: 'switch'; kind: 'transient' }, status: number | undefined, error: string, now = Date.now(), sentAt = now): void {
    const s = this.get(groupId, providerId);
    s.lastStatus = status;
    s.lastError = error.slice(0, 300);
    s.lastUsedAt = now;
    if (v.action !== 'switch') return;
    const already = s.cooldownUntil > sentAt;
    s.lastFailAt = now;
    if (v.kind === 'rate') {
      if (already) { s.cooldownUntil = Math.max(s.cooldownUntil, now + v.cooldownMs); if (s.cooldownKind !== 'rate') s.cooldownKind = 'rate'; return; }
      s.cooldownUntil = now + v.cooldownMs; s.cooldownKind = 'rate'; s.strikes++;
    }
    else if (v.kind === 'transient') { if (!already) { s.cooldownUntil = now + TRANSIENT_COOLDOWN_MS; s.cooldownKind = 'transient'; } }
    else s.disabled = true;
  }

  /** A success from an attempt sent at `sentAt`; an older request finishing late must not clear a newer cooldown. */
  ok(groupId: string, providerId: string, now = Date.now(), sentAt = now) {
    const s = this.get(groupId, providerId);
    if (s.lastFailAt !== undefined && s.lastFailAt > sentAt) { s.lastOkAt = now; s.lastUsedAt = now; return false; }
    const changed = s.strikes > 0 || s.cooldownUntil > 0 || !!s.lastError || !s.lastOkAt;
    s.strikes = 0;
    s.cooldownUntil = 0;
    s.cooldownKind = undefined;
    s.lastError = undefined;
    s.lastStatus = 200;
    s.lastOkAt = now;
    s.lastUsedAt = now;
    return changed;
  }

  /** Soonest time any member of the group becomes usable again (for retry-after), or null. */
  nextAvailable(g: GatewayGroup): { at: number; rate: boolean } | null {
    let best: { at: number; rate: boolean } | null = null;
    for (const m of g.members) {
      const s = this.peek(g.id, m.providerId);
      if (!s || s.disabled) continue;
      if (!best || s.cooldownUntil < best.at) best = { at: s.cooldownUntil, rate: s.cooldownKind === 'rate' };
    }
    return best;
  }
}

/** Outbound model for a member: member pin > exact modelMap > wildcard modelMap > unchanged. */
export function mapModel(g: GatewayGroup, m: GatewayMember, model: string): string {
  if (m.model?.trim()) return m.model.trim();
  const map = g.modelMap ?? {};
  if (map[model]) return map[model];
  for (const [k, v] of Object.entries(map)) {
    if (!k.includes('*') || !v) continue;
    const re = new RegExp(`^${k.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
    if (re.test(model)) return v;
  }
  return model;
}
