import { describe, expect, it } from 'vitest';
import { cachedDiffStat } from '@/model/diffstat';
import { onlyStreamed, settledVersion } from './streamed';

// 2026-11-17 「一跑任务就卡」: what re-renders for each frame of a stream and what waits for the next whole message
describe('onlyStreamed', () => {
  const conv = { items: [] };
  const base = { sessionId: 's', cwd: '/w', conv, version: 10, streamed: 4, state: 'running', pending: [] as unknown[] };

  it('a streamed frame (renderStreamed: version and streamed both +1, nothing else) is only streamed', () => {
    expect(onlyStreamed(base, { ...base, version: 11, streamed: 5 })).toBe(true);
    expect(onlyStreamed(base, { ...base, version: 13, streamed: 7 })).toBe(true); // several frames
    expect(onlyStreamed(base, base)).toBe(true);
  });

  it('a whole message (bump: version alone), a field that changed, or a frame plus a change is not', () => {
    expect(onlyStreamed(base, { ...base, version: 11 })).toBe(false);
    expect(onlyStreamed(base, { ...base, version: 12, streamed: 5 })).toBe(false);
    expect(onlyStreamed(base, { ...base, version: 11, streamed: 5, state: 'idle' })).toBe(false);
    expect(onlyStreamed(base, { ...base, version: 11, streamed: 5, pending: [] })).toBe(false); // a new array
    const { cwd: _drop, ...noCwd } = base;
    expect(onlyStreamed(base, { ...noCwd, version: 11, streamed: 5 } as typeof base)).toBe(false);
    expect(onlyStreamed(base, undefined)).toBe(false);
    expect(onlyStreamed(undefined, base)).toBe(false);
  });

  it('the settled version moves for whole messages only', () => {
    expect(settledVersion(base)).toBe(6);
    expect(settledVersion({ ...base, version: 11, streamed: 5 })).toBe(6);
    expect(settledVersion({ ...base, version: 11 })).toBe(7);
    expect(settledVersion(undefined)).toBe(-1);
  });
});

describe('cachedDiffStat', () => {
  const edit = (id: string, path: string, oldS: string, newS: string) => ({
    kind: 'assistant', id, streaming: false, parentToolUseId: null,
    blocks: [{ type: 'tool_use', id: `t${id}`, name: 'Edit', input: { file_path: path, old_string: oldS, new_string: newS }, children: [], status: 'done', result: { isError: false, content: 'ok' } }],
  });
  it('worked out once per settled version, again when it moves', () => {
    const conv = { items: [edit('a', '/w/a.ts', 'x', 'y\nz')] } as any;
    const first = cachedDiffStat(conv, 1);
    expect(first).toMatchObject({ files: 1 });
    conv.items.push(edit('b', '/w/b.ts', '', 'q'));
    expect(cachedDiffStat(conv, 1)).toBe(first); // same settled version: the same answer, not walked again
    expect(cachedDiffStat(conv, 2)).toMatchObject({ files: 2 });
  });
});
