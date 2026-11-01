import { describe, expect, it } from 'vitest';
import type { BotRun, BotTimelineEntry, InboxItem } from '@shared';
import { threadRows } from './thread-extras';

const e = (p: Partial<BotTimelineEntry> & { id: string; at: number }): BotTimelineEntry => ({ botId: 'b1', kind: 'system', ...p });
const item: InboxItem = { id: 'i1', kind: 'approval', botId: 'b1', at: 5, title: 't' };
const run: BotRun = { id: 'r1', botId: 'b1', routineId: 'x', at: 3, trigger: 'cron' };

describe('threadRows', () => {
  it('maps entries in time order, each with what it draws from', () => {
    const rows = threadRows([e({ id: 'c', at: 30, kind: 'approval', itemId: 'i1' }), e({ id: 'a', at: 10, text: 'hi' }), e({ id: 'b', at: 20, kind: 'run', runId: 'r1' })], [item], [run]);
    expect(rows.map((r) => r.key)).toEqual(['a', 'b', 'c']);
    expect(rows[1].run).toBe(run);
    expect(rows[2].item).toBe(item);
  });

  it('drops a card whose inbox item is unknown', () => {
    const rows = threadRows([e({ id: 'a', at: 1, kind: 'draft', itemId: 'nope' }), e({ id: 'b', at: 2, kind: 'proposal' })], [item], []);
    expect(rows).toEqual([]);
  });

  it('keeps a run card whose run is not loaded yet (it says the routine name)', () => {
    const rows = threadRows([e({ id: 'a', at: 1, kind: 'run', runId: 'r9', text: '早间简报' })], [], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].run).toBeUndefined();
  });
});

import { firstLine } from './BotRunCard';
describe('a run card\'s line: the report\'s start as plain text', () => {
  it('drops markdown marks and runs a bold title line into what follows (2026-11-01 real run)', () => {
    expect(firstLine('**仓库晨检（2026-11-01）**\n当前在 `main` 分支，工作区干净。\n- [ ] 修登录页')).toBe('仓库晨检（2026-11-01） 当前在 main 分支，工作区干净。 [ ] 修登录页');
    expect(firstLine('## 结论\n都没问题')).toBe('结论 都没问题');
    expect(firstLine(undefined)).toBe('');
    expect(firstLine('x'.repeat(400))).toHaveLength(160);
  });
});
