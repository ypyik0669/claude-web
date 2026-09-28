// Codex `thread/tokenUsage/updated` → per-turn usage in the ledger's (Anthropic) terms.
// Shapes per `codex app-server generate-ts`: ThreadTokenUsage = { total, last, modelContextWindow }, each a
// TokenUsageBreakdown { totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens,
// reasoningOutputTokens }. `inputTokens` INCLUDES the cached / cache-write part (OpenAI convention), and
// `last` is only the most recent model call of the turn — so the turn is `total` at its end minus `total` at
// its start. Re-sent updates (Codex repeats the token count with rate-limit refreshes) then cost nothing.

export interface CodexBreakdown { totalTokens?: number; inputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number }
export interface TurnUsage { input: number; output: number; cacheRead: number; cacheWrite: number }

interface Counts { input: number; cached: number; write: number; output: number }
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const counts = (b: CodexBreakdown | undefined | null): Counts | null => (b ? { input: num(b.inputTokens), cached: num(b.cachedInputTokens), write: num(b.cacheWriteInputTokens), output: num(b.outputTokens) } : null);
const minus = (a: Counts, b: Counts): Counts => ({ input: a.input - b.input, cached: a.cached - b.cached, write: a.write - b.write, output: a.output - b.output });
const plus = (a: Counts, b: Counts): Counts => ({ input: a.input + b.input, cached: a.cached + b.cached, write: a.write + b.write, output: a.output + b.output });
const ZERO: Counts = { input: 0, cached: 0, write: 0, output: 0 };

export class CodexUsageMeter {
  /** Last cumulative total seen (across turns). */
  private total: Counts | null = null;
  /** Total when the current turn began (null until known). */
  private base: Counts | null = null;
  private seen = false;

  beginTurn() {
    this.base = this.total;
    this.seen = false;
  }

  update(u: { total?: CodexBreakdown | null; last?: CodexBreakdown | null } | null | undefined) {
    const total = counts(u?.total);
    const last = counts(u?.last);
    if (!total && !last) return;
    // a server without `total`: add each call up (cannot tell a re-send apart, but that is all it gives us)
    const next = total ?? plus(this.total ?? ZERO, last!);
    // first update ever (a resumed thread's total already holds earlier turns): the turn began at total − last
    if (!this.base) this.base = total && last ? minus(total, last) : total ? ZERO : this.total ?? ZERO;
    this.total = next;
    this.seen = true;
  }

  /** Usage of the current (or just finished) turn. */
  turn(): TurnUsage {
    if (!this.seen || !this.total || !this.base) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const d = minus(this.total, this.base);
    const cacheRead = Math.max(0, d.cached);
    const cacheWrite = Math.max(0, d.write);
    return { input: Math.max(0, d.input - cacheRead - cacheWrite), cacheRead, cacheWrite, output: Math.max(0, d.output) };
  }
}
