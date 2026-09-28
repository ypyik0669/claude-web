import { describe, expect, it } from 'vitest';
import { PANELS } from '@/model/layout';
import { MAX_NAME_HITS, clusterByGroup, commandHits, type Filterable } from './filter';

const panels = PANELS.map((p) => ({ label: `打开${p.title}面板`, group: '面板' }));
const others = Array.from({ length: 12 }, (_, i) => ({ label: `隐藏右侧面板 ${i}`, group: '工作台' }));
const chat = [{ label: '新对话', group: '对话' }, { label: '打开项目文件夹…', group: '对话' }, { label: '置顶当前对话', group: '当前对话' }, { label: '导出为 HTML', group: '当前对话' }];

/** The group titles as the palette draws them: named, the conversations (one 匹配的对话 block), grouped. */
const titles = (h: { named: Filterable[]; grouped: Filterable[] }, sessions = 3) => {
  const rows = [...h.named.map((c) => c.group), ...Array(sessions).fill('匹配的对话'), ...h.grouped.map((c) => c.group)];
  return rows.filter((g, i) => g !== rows[i - 1]);
};

describe('palette command filter', () => {
  it('a query naming a group (2+ characters) lists the whole group, uncut, in one block after the conversations', () => {
    const { named, grouped } = commandHits([...others, ...panels], '面板');
    expect(grouped).toEqual(panels); // all of them, in their order, none of them among the name hits
    expect(named).toEqual(others.slice(0, MAX_NAME_HITS));
    expect(named.some((c) => c.group === '面板')).toBe(false);
  });

  it('every group title shows once — a matched group is not split around the conversation hits (re-review M-c)', () => {
    // the reviewer's case: workbench commands whose labels say 面板 come first in the list, then the panels
    const cmds = [...others.slice(0, 3), ...panels, ...others.slice(3)];
    const h = commandHits(cmds, '面板');
    const t = titles(h);
    expect(t).toEqual(['工作台', '匹配的对话', '面板']);
    expect(new Set(t).size).toBe(t.length);
    // two groups named at once (「对话」 is in 对话 and 当前对话): each one block
    const t2 = titles(commandHits([chat[0], chat[2], chat[1], chat[3]], '对话'));
    expect(t2).toEqual(['匹配的对话', '对话', '当前对话']);
  });

  it('name hits from interleaved groups are gathered by group (a title shows once there too)', () => {
    const cmds = [{ label: 'a x', group: 'A' }, { label: 'b x', group: 'B' }, { label: 'a2 x', group: 'A' }];
    expect(commandHits(cmds, 'x').named.map((c) => c.label)).toEqual(['a x', 'a2 x', 'b x']);
    expect(clusterByGroup(cmds).map((c) => c.group)).toEqual(['A', 'A', 'B']);
  });

  it('one character does not list whole groups (「对」 on the way to 「对话」): only name hits', () => {
    const { named, grouped } = commandHits(chat, '对');
    expect(grouped).toEqual([]);
    expect(named.map((c) => c.label)).toEqual(['新对话', '置顶当前对话']);
  });

  it('…unless it is the whole group name', () => {
    const cmds = [{ label: 'a', group: 'x' }, { label: 'b', group: 'x' }, { label: 'x marks', group: 'y' }];
    const h = commandHits(cmds, 'x');
    expect(h.grouped.map((c) => c.label)).toEqual(['a', 'b']);
    expect(h.named.map((c) => c.label)).toEqual(['x marks']);
  });

  it('name matches are cut to the first 8, in their own order; no query shows everything', () => {
    const { named, grouped } = commandHits(others, '隐藏');
    expect(named).toEqual(others.slice(0, MAX_NAME_HITS));
    expect(grouped).toEqual([]);
    expect(commandHits(others, '').named).toEqual(others);
  });

  it('a panel is found by its own name', () => {
    expect(commandHits(panels, '审阅').named.map((c) => c.label)).toEqual(['打开审阅面板']);
  });
});
