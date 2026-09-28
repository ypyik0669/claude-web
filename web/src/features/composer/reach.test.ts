import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PERMISSION_MODE_ORDER } from '@/ui/terms';
import { buildModelMenu } from '@/features/models/menu';
import { FEATURE_KEYS, plusMenuIds } from './capabilities';
import { BAR_ID, MODEL_MENU_ID, PLUS_ID, PROJECT_MENU_ID, idSel } from './ids';
import { COMPOSER_REACH, PLACE_CONTAINER, PLACE_OPENER } from './reach';

const at = (place: string) => COMPOSER_REACH.filter((r) => r.place === place).map((r) => r.sel);
const ids = (place: string) => at(place).map((s) => /^\[data-id="([^"]+)"\]$/.exec(s)?.[1]).filter((x): x is string => !!x);

describe('every control of the old composer is reachable (spec §4.2, phase 3 acceptance)', () => {
  it('the old 「功能」 menu, attachments and goal: all in +, and every + id is one the menu renders', () => {
    for (const k of [...FEATURE_KEYS, 'channels', 'goal', 'files', 'folder', 'reference']) expect(ids('plus')).toContain(k);
    for (const id of ids('plus')) expect(plusMenuIds()).toContain(id);
  });
  it('permission: all six modes', () => {
    expect(at('permission')).toEqual(PERMISSION_MODE_ORDER.map((m) => `[data-mode="${m}"]`));
  });
  it('effort, 深度编排, add / manage / refresh are the model menu\'s own ids; every one of them is listed', () => {
    expect(ids('model').sort()).toEqual(Object.values(MODEL_MENU_ID).sort());
  });
  it('the agent choice really is a section of the flat menu (data-sec="agent:<kind>")', () => {
    const m = buildModelMenu({ agent: 'claude', providers: [], settings: {}, otherAgents: [{ kind: 'codex', name: 'Codex', installed: true }] });
    const sec = m.sections.find((s) => s.kind === 'agent');
    expect(sec?.id).toBe('agent:codex');
    expect(at('model')).toContain('[data-sec^="agent:"]');
  });
  it('project chip, the row, the stats ring', () => {
    expect(ids('project').sort()).toEqual(Object.values(PROJECT_MENU_ID).sort());
    expect(ids('bar').sort()).toEqual([BAR_ID.mic, BAR_ID.send, BAR_ID.steer].sort());
    expect(at('meter')).toEqual([idSel(BAR_ID.meter)]);
  });
  it('every place has a container, every menu an opener; no selector twice', () => {
    for (const r of COMPOSER_REACH) expect(PLACE_CONTAINER[r.place]).toBeTruthy();
    for (const p of ['plus', 'project', 'model', 'permission'] as const) expect(PLACE_OPENER[p]).toBeTruthy();
    const keys = COMPOSER_REACH.map((r) => `${r.place} ${r.sel}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('Brief and 频道 need 「Brief、频道…」 expanded; the row that expands them is listed too', () => {
    expect(COMPOSER_REACH.filter((r) => r.when === 'more').map((r) => r.sel)).toEqual([idSel('brief'), idSel(PLUS_ID.channels)]);
    expect(at('plus')).toContain(idSel(PLUS_ID.more));
  });
});

// the ids above are only worth something if the components draw their rows with them: no hand-written data-id
// in the menus, every table value used by the component that owns it
describe('the menus render their data-id from the id tables (review 3 #11)', () => {
  const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const OWNERS: [string, string, Record<string, string>][] = [
    ['./PlusMenu.tsx', 'PLUS_ID', PLUS_ID],
    ['../models/ModelMenu.tsx', 'MODEL_MENU_ID', MODEL_MENU_ID],
    ['./Composer.tsx', 'BAR_ID', { mic: BAR_ID.mic, steer: BAR_ID.steer, send: BAR_ID.send }],
    ['./ContextMeter.tsx', 'BAR_ID', { meter: BAR_ID.meter }],
  ];
  it.each(OWNERS)('%s', (file, table, values) => {
    const s = src(file);
    expect(s).not.toMatch(/data-id="/);
    for (const k of Object.keys(values)) expect(s).toContain(`${table}.${k}`);
  });
  it('the project menu (DirPicker + ProjectChip)', () => {
    const s = src('./DirPicker.tsx') + src('./ProjectChip.tsx');
    expect(s).not.toMatch(/data-id="/);
    for (const k of Object.keys(PROJECT_MENU_ID)) expect(s).toContain(`PROJECT_MENU_ID.${k}`);
  });
  it('the + menu draws the capability rows from CAPABILITIES (data-id = the feature key)', () => {
    expect(src('./PlusMenu.tsx')).toMatch(/data-id=\{k\}/);
  });
});
