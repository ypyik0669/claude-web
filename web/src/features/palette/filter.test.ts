import { describe, expect, it } from 'vitest';
import { PANELS } from '@/model/layout';
import { MAX_NAME_HITS, commandHits } from './filter';

const panels = PANELS.map((p) => ({ label: `打开${p.title}面板`, group: '面板' }));
const others = Array.from({ length: 12 }, (_, i) => ({ label: `隐藏右侧面板 ${i}`, group: '工作台' }));

describe('palette command filter', () => {
  it('a query naming a group lists the whole group, uncut (「面板」 → every panel)', () => {
    const hits = commandHits([...others, ...panels], '面板');
    expect(hits.filter((c) => c.group === '面板')).toHaveLength(PANELS.length);
    // the name-only matches around it are still cut
    expect(hits.filter((c) => c.group !== '面板')).toHaveLength(MAX_NAME_HITS);
  });

  it('name matches are cut to the first 8, in their own order; no query shows everything', () => {
    const hits = commandHits(others, '隐藏');
    expect(hits).toEqual(others.slice(0, MAX_NAME_HITS));
    expect(commandHits(others, '')).toBe(others);
  });

  it('a panel is found by its own name', () => {
    expect(commandHits(panels, '审阅').map((c) => c.label)).toEqual(['打开审阅面板']);
  });
});
