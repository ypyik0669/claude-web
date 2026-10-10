import { describe, expect, it } from 'vitest';
import { CORE_PANELS, PANELS } from '@/model/layout';
import { MAX_PINS, RAIL_MORE, RAIL_SECTIONS, railPanel, readPins, togglePin } from './rail-model';

describe('the icon rail: three sections, the other panels behind ···', () => {
  it('the sections are 对话 · 自动化 · 扩展, in that order', () => {
    expect(RAIL_SECTIONS.map((s) => s.id)).toEqual(['chat', 'automation', 'extensions']);
    expect(RAIL_SECTIONS.map((s) => s.label)).toEqual(['对话', '自动化', '扩展']);
  });
  it('··· lists real panels, none of them a fixed tab of the right panel', () => {
    const ids = PANELS.map((p) => p.id);
    for (const id of RAIL_MORE) {
      expect(ids).toContain(id);
      expect(CORE_PANELS).not.toContain(id);
      const p = railPanel(id);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.hint.length).toBeGreaterThan(0);
    }
    expect(new Set(RAIL_MORE).size).toBe(RAIL_MORE.length);
  });
  it('a panel is reachable from the rail or from the right panel itself', () => {
    // 目标 / 编排: the automation section and the right panel's own 更多; 详情: a click in a conversation
    const elsewhere = [...CORE_PANELS, 'goals', 'orchestra', 'inspector'];
    for (const p of PANELS) expect([...RAIL_MORE, ...elsewhere], p.id).toContain(p.id);
  });
});

describe('pins', () => {
  it('reads only what ··· lists, once each, at most four', () => {
    expect(readPins(undefined)).toEqual([]);
    expect(readPins('mission')).toEqual([]);
    expect(readPins(['mission', 'files', 'nope', 'mission', 7, 'usage'])).toEqual(['mission', 'usage']);
    expect(readPins(['mission', 'usage', 'memory', 'board', 'android', 'config'])).toHaveLength(MAX_PINS);
  });
  it('toggles; a fifth is refused', () => {
    expect(togglePin([], 'mission')).toEqual(['mission']);
    expect(togglePin(['mission', 'usage'], 'mission')).toEqual(['usage']);
    expect(togglePin(['mission', 'usage', 'memory', 'board'], 'android')).toBeNull();
    expect(togglePin(['mission', 'usage', 'memory', 'board'], 'board')).toEqual(['mission', 'usage', 'memory']);
  });
});
