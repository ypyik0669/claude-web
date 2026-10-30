// The pure parts of 设置 › 通用 › 值班 Bot (BotsSection.tsx): budget parsing, what the duty switch shows, and
// 放开全部 / 收回 one bot after another.

/** 全局预算 text → what to store: a positive number, undefined (empty or 0 = no global budget), or an error. */
export function parseBudget(text: string): { ok: true; value: number | undefined } | { ok: false } {
  const t = text.trim();
  if (!t) return { ok: true, value: undefined };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n > 0 ? n : undefined };
}

/** The last duty change (meta.json `bots.duty.last`): `on` is the state it left, `ok` whether the change went through. */
export interface DutyResult { on: boolean; ok: boolean; detail: string; at: number }

/** The stored result of a change from `prevOn` to `want`: a failed change leaves the state where it was. */
export function dutyAfter(prevOn: boolean, want: boolean, r: { ok: boolean; detail: string }, at: number): DutyResult {
  return { on: r.ok ? want : prevOn, ok: r.ok, detail: r.detail, at };
}

/** The switch: what the system says when it answered (`installed`), else the last stored state. */
export function dutyShown(last: DutyResult | undefined, installed: boolean | null): boolean {
  return installed ?? !!last?.on;
}

/** Apply `call` to each target in turn; the first failure stops the rest. */
export async function eachUntilError<T>(targets: T[], call: (t: T) => Promise<unknown>): Promise<{ done: number; failed?: { target: T; error: unknown } }> {
  let done = 0;
  for (const target of targets) {
    try { await call(target); } catch (error) { return { done, failed: { target, error } }; }
    done++;
  }
  return { done };
}
