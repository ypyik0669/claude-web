import { describe, expect, it } from 'vitest';
import { PERMISSION_MODE_ORDER } from '@/ui/terms';
import { buildModelMenu } from '@/features/models/menu';
import { BAR_IDS, COMPOSER_REACH, MODEL_MENU_IDS, PROJECT_MENU_IDS, plusIds } from './reach';

const at = (place: string) => COMPOSER_REACH.filter((r) => r.place === place).map((r) => r.id);

describe('every control of the old composer is reachable (spec §4.2, phase 3 acceptance)', () => {
  it('the old 「功能」 menu: all of it is in +', () => {
    for (const id of ['chrome', 'computerUse', 'coordinator', 'proactive', 'brief', 'channels']) expect(at('plus')).toContain(id);
    for (const id of at('plus')) expect(plusIds()).toContain(id);
  });
  it('permission: all six modes', () => {
    expect(at('permission').sort()).toEqual([...PERMISSION_MODE_ORDER].sort());
  });
  it('agent choice, profiles, models, effort, 深度编排 are in the model menu', () => {
    for (const id of ['agent', 'model', 'effort', 'ultracode', 'add-provider', 'agents']) expect(at('model')).toContain(id);
    for (const id of at('model')) expect(MODEL_MENU_IDS).toContain(id);
  });
  it('the agent choice really is a section kind of the flat menu', () => {
    const m = buildModelMenu({ agent: 'claude', providers: [], settings: {}, otherAgents: [{ kind: 'codex', name: 'Codex', installed: true }] });
    expect(m.sections.some((s) => s.kind === 'agent' && s.agent === 'codex')).toBe(true);
  });
  it('project chip, the row, the stats', () => {
    for (const id of at('project')) expect(PROJECT_MENU_IDS).toContain(id);
    for (const id of at('bar')) expect(BAR_IDS).toContain(id);
    expect(at('meter')).toEqual(['usage']);
  });
  it('no id twice', () => {
    const ids = COMPOSER_REACH.map((r) => `${r.place}:${r.id}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
