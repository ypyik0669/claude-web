import { describe, expect, it } from 'vitest';
import { PANELS } from '@/model/layout';
import { MAX_NAME_HITS, commandHits } from './filter';

const panels = PANELS.map((p) => ({ label: `打开${p.title}面板`, group: '面板' }));
const others = Array.from({ length: 12 }, (_, i) => ({ label: `隐藏右侧面板 ${i}`, group: '工作台' }));
const chat = [{ label: '新对话', group: '对话' }, { label: '打开项目文件夹…', group: '对话' }, { label: '置顶当前对话', group: '当前对话' }, { label: '导出为 HTML', group: '当前对话' }];

describe('palette command filter', () => {
  it('a query naming a group (2+ characters) lists the whole group, uncut, after the name hits', () => {
    const { named, grouped } = commandHits([...others, ...panels], '面板');
    // every panel is there: some by name (in the first 8), the rest by group
    expect([...named, ...grouped].filter((c) => c.group === '面板')).toHaveLength(PANELS.length);
    expect(named).toHaveLength(MAX_NAME_HITS);
    expect(grouped.every((c) => c.group === '面板')).toBe(true);
  });

  it('one character does not list whole groups (「对」 on the way to 「对话」): only name hits', () => {
    const { named, grouped } = commandHits(chat, '对');
    expect(grouped).toEqual([]);
    expect(named.map((c) => c.label)).toEqual(['新对话', '置顶当前对话']);
  });

  it('…unless it is the whole group name', () => {
    const cmds = [{ label: 'a', group: 'x' }, { label: 'b', group: 'x' }, { label: 'x marks', group: 'y' }];
    expect(commandHits(cmds, 'x').grouped.map((c) => c.label)).toEqual(['a', 'b']);
  });

  it('name matches are cut to the first 8, in their own order; no query shows everything', () => {
    const { named, grouped } = commandHits(others, '隐藏');
    expect(named).toEqual(others.slice(0, MAX_NAME_HITS));
    expect(grouped).toEqual([]);
    expect(commandHits(others, '').named).toBe(others);
  });

  it('a panel is found by its own name', () => {
    expect(commandHits(panels, '审阅').named.map((c) => c.label)).toEqual(['打开审阅面板']);
  });
});
