import { describe, it, expect } from 'vitest';
import { entryForItem, entryForRun, eventsBlock, systemEntry } from './timeline.js';
import type { BotRun, InboxItem } from '../protocol.js';

const run = (p: Partial<BotRun> = {}): BotRun => ({ id: 'r_1', botId: 'b_1', routineId: 'morning', at: 100, trigger: 'cron', ok: true, endedAt: 200, said: '三个新 issue', ...p });
const item = (p: Partial<InboxItem> = {}): InboxItem => ({ id: 'i_1', kind: 'approval', botId: 'b_1', at: 300, title: 'git push origin main', ...p });
const hm = (at: number) => { const d = new Date(at); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

describe('timeline entries', () => {
  it('a run → one run entry with a stable id: as it starts at its start, finished at its end; skipped → none', () => {
    expect(entryForRun(run(), '早间简报')).toEqual({ id: 'run:r_1', botId: 'b_1', at: 200, kind: 'run', text: '早间简报', runId: 'r_1', routineId: 'morning' });
    expect(entryForRun(run({ skipped: true }), '早间简报')).toBeUndefined();
    expect(entryForRun(run({ endedAt: undefined, ok: undefined }), '早间简报')).toEqual({ id: 'run:r_1', botId: 'b_1', at: 100, kind: 'run', text: '早间简报', runId: 'r_1', routineId: 'morning' });
    const live = run({ endedAt: undefined, ok: undefined });
    expect(eventsBlock([entryForRun(live, '早间简报')!], new Map(), new Map([[live.id, live]]))).toContain('例行「早间简报」在跑');
  });

  it('approval / draft / proposal → an entry carrying the itemId; a finding → none', () => {
    expect(entryForItem(item())).toEqual({ id: 'item:i_1', botId: 'b_1', at: 300, kind: 'approval', itemId: 'i_1' });
    expect(entryForItem(item({ kind: 'draft', runId: 'r_1', routineId: 'morning' }))).toMatchObject({ id: 'item:i_1', kind: 'draft', itemId: 'i_1', runId: 'r_1', routineId: 'morning' });
    expect(entryForItem(item({ kind: 'proposal' }))?.kind).toBe('proposal');
    expect(entryForItem(item({ kind: 'finding' }))).toBeUndefined();
  });

  it('systemEntry: one line, an icon, a capped detail', () => {
    const e = systemEntry('b_1', '改名为「晨报」', 'rename', 'x'.repeat(3000));
    expect(e).toMatchObject({ botId: 'b_1', kind: 'system', text: '改名为「晨报」', icon: 'rename' });
    expect(e.id).toMatch(/^sys:/);
    expect(e.detail!.length).toBe(2000);
    expect(systemEntry('b_1', 'a', 'bot').detail).toBeUndefined();
    expect(systemEntry('b_1', 'a', 'bot').id).not.toBe(systemEntry('b_1', 'a', 'bot').id);
  });
});

describe('eventsBlock', () => {
  it('is empty when there is nothing to say', () => {
    expect(eventsBlock([], new Map(), new Map())).toBe('');
  });

  it('lists only the entries it is given, one line each', () => {
    const r = run();
    const done = item({ done: { at: 400, answer: 'approve' } });
    const entries = [entryForRun(r, '早间简报')!, entryForItem(done)!];
    const out = eventsBlock(entries, new Map([[done.id, done]]), new Map([[r.id, r]]));
    expect(out).toBe(`<cw-bot-events>\n- ${hm(200)} 例行「早间简报」完成：三个新 issue\n- ${hm(300)} 你批准了：git push origin main\n</cw-bot-events>\n\n`);
    expect(out).not.toContain('r_2');
  });

  it('says a failed run failed, a pending approval waits, and skips entries whose item / run it does not have', () => {
    const r = run({ ok: false, error: '超时' });
    const pending = item({ id: 'i_2' });
    const out = eventsBlock(
      [entryForRun(r, '早间简报')!, entryForItem(pending)!, entryForItem(item({ id: 'gone' }))!, systemEntry('b_1', '记住了：周五不发', 'memory')],
      new Map([[pending.id, pending]]), new Map([[r.id, r]]));
    expect(out).toContain('例行「早间简报」失败：超时');
    expect(out).toContain('等你批准：git push origin main');
    expect(out).toContain('记住了：周五不发');
    expect(out.split('\n').filter((l) => l.startsWith('- ')).length).toBe(3);
  });
});
