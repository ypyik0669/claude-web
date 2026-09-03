import type { CanonicalEvent } from '../session/canonical.js';
import type { MemoryService } from './service.js';

/**
 * Harvest memories from a finished session's canonical timeline.
 *
 * Deliberately conservative. An agent that records everything produces a store nobody can search,
 * so this only takes three things the code and git history do NOT already say:
 *
 *  - **dead ends** — a command or edit that failed. Git shows what landed, never what was tried.
 *  - **decisions** — sentences where the agent said it chose one option over another, with a reason.
 *  - **constraints** — sentences stating something must / cannot be done a certain way.
 *
 * Everything else (which files changed, what the tests are) is better re-read from disk than
 * remembered, so it is left alone.
 */

const DECISION = /(?:决定|选择了?|改用|最终用|采用|不用|放弃)[^。\n]{4,120}(?:，|,|因为|since|because)[^。\n]{4,160}/g;
const DECISION_EN = /\b(?:decided|chose|switched|went with|settled on)\b[^.\n]{4,160}\b(?:because|since|so that)\b[^.\n]{4,160}/gi;
const CONSTRAINT = /(?:必须|不能|不要|一定要|只能|禁止)[^。\n]{6,140}/g;
const CONSTRAINT_EN = /\b(?:must not|must always|cannot|can't|never|always)\b[^.\n]{8,150}/gi;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/^[-*\d.\s]+/, '');
const cmdOf = (input: Record<string, unknown>) => (typeof input.command === 'string' ? input.command : '');
const fileOf = (input: Record<string, unknown>) => (typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : '');

export interface HarvestResult {
  written: number;
  skipped: number;
}

export function harvest(mem: MemoryService, events: CanonicalEvent[], ctx: { cwd: string; sessionId: string; agent?: string }): HarvestResult {
  const out: { kind: 'decision' | 'constraint' | 'deadend'; text: string }[] = [];

  for (const e of events) {
    if (e.kind === 'tool' && e.ok === false) {
      const cmd = cmdOf(e.input);
      const file = fileOf(e.input);
      const what = cmd ? `\`${clean(cmd).slice(0, 120)}\`` : file ? `${e.name} ${file}` : e.name;
      const why = clean(e.result ?? '').slice(0, 160);
      if (why) out.push({ kind: 'deadend', text: `${what} 失败了：${why}` });
      continue;
    }
    if (e.kind !== 'assistant') continue;
    const t = e.text;
    for (const re of [DECISION, DECISION_EN]) {
      re.lastIndex = 0;
      for (const m of t.matchAll(re)) out.push({ kind: 'decision', text: clean(m[0]).slice(0, 300) });
    }
    for (const re of [CONSTRAINT, CONSTRAINT_EN]) {
      re.lastIndex = 0;
      for (const m of t.matchAll(re)) out.push({ kind: 'constraint', text: clean(m[0]).slice(0, 300) });
    }
  }

  // one session should not be able to flood the store
  const seen = new Set<string>();
  let written = 0;
  let skipped = 0;
  for (const item of out) {
    const key = item.text.toLowerCase();
    if (seen.has(key) || item.text.length < 12) { skipped++; continue; }
    seen.add(key);
    if (written >= 12) { skipped++; continue; }
    mem.write({ scope: 'project', key: ctx.cwd, kind: item.kind, text: item.text, sourceSession: ctx.sessionId, sourceAgent: ctx.agent, tags: ['auto'] });
    written++;
  }
  return { written, skipped };
}
