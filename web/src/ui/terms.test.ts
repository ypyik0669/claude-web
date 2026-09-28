import { describe, expect, it } from 'vitest';
import type { EffortLevel, PermissionMode } from '@shared';
import { EFFORT_DESC, EFFORT_LABEL, MODE_LABEL, PERMISSION_MODES, PERMISSION_MODE_ORDER, ULTRACODE, WORKBENCH_VIEW_LABEL, effortLabel, effortTitle } from './terms';
import { WORKBENCH_TABS } from '@/model/layout';

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
// words that must not reach a default screen (tooltips keep them)
const IMPL = /effort|ultracode|窗格|停靠|引擎|ACP|档案/i;

describe('effort → 智能程度', () => {
  it('maps every level to the spec wording', () => {
    expect(EFFORT_LABEL).toEqual({ low: '快', medium: '均衡', high: '深入', xhigh: '更深', max: '极限', ultra: '超限' });
    for (const l of EFFORTS) expect(EFFORT_DESC[l]).toBeTruthy();
  });

  it('labels are unique and free of implementation words', () => {
    expect(new Set(Object.values(EFFORT_LABEL)).size).toBe(EFFORTS.length);
    for (const l of EFFORTS) expect(effortLabel(l)).not.toMatch(IMPL);
  });

  it('unknown / empty values fall back to the scale name', () => {
    expect(effortLabel(undefined)).toBe('智能程度');
    expect(effortLabel(null)).toBe('智能程度');
    expect(effortLabel('turbo')).toBe('智能程度');
  });

  it('the tooltip keeps the raw value for old users', () => {
    expect(effortTitle('high')).toContain('effort: high');
    expect(effortTitle('high')).toContain('深入');
    expect(effortTitle(undefined, 'note')).toMatch(/note$/);
  });
});

describe('permission modes', () => {
  it('every mode has a label and a one-line consequence', () => {
    expect(PERMISSION_MODE_ORDER.slice().sort()).toEqual(MODES.slice().sort());
    for (const m of MODES) {
      expect(PERMISSION_MODES[m].label).toBeTruthy();
      expect(PERMISSION_MODES[m].desc.length).toBeGreaterThan(6);
      expect(MODE_LABEL[m]).toBe(PERMISSION_MODES[m].label);
    }
  });

  it('uses the spec wording (§5.4) and marks the recommended / dangerous ones', () => {
    expect(MODE_LABEL).toEqual({ default: '每步询问', acceptEdits: '自动改文件', plan: '只做计划', auto: '自动判断', dontAsk: '只做已允许的', bypassPermissions: '完全放开' });
    expect(PERMISSION_MODES.default.recommended).toBe(true);
    expect(PERMISSION_MODES.bypassPermissions.danger).toBe(true);
    expect(new Set(Object.values(MODE_LABEL)).size).toBe(MODES.length);
  });
});

describe('ultracode → 深度编排', () => {
  it('the visible label is the new word, the tooltip keeps the old one', () => {
    expect(ULTRACODE.label).toBe('深度编排');
    expect(ULTRACODE.label).not.toMatch(IMPL);
    expect(ULTRACODE.title).toContain('ultracode');
  });
});

describe('workbench views', () => {
  it('every workbench tab has a user-facing name', () => {
    for (const t of WORKBENCH_TABS) expect(WORKBENCH_VIEW_LABEL[t]).toBeTruthy();
    expect(WORKBENCH_VIEW_LABEL.artifacts).toBe('生成的文件');
  });
});
