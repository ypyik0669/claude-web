import { describe, expect, it } from 'vitest';
import type { SlashCommandInfo } from '@shared';
import { buildCommands, groupOf, matchCommand, nameParts, slashMenu, typedExactly } from './slash';

const BTW: SlashCommandInfo = { name: 'btw', description: 'side question', argumentHint: 'question', source: 'builtin' };
const c = (name: string, source: SlashCommandInfo['source'], extra: Partial<SlashCommandInfo> = {}): SlashCommandInfo => ({ name, description: '', argumentHint: '', source, ...extra });

// what a running official binary reported (normalized by the server), cut down
const ENGINE: SlashCommandInfo[] = [
  c('agents', 'builtin'),
  c('list-agents', 'builtin', { aliases: ['peers'] }),
  c('usage', 'builtin', { aliases: ['cost', 'stats'] }),
  c('compact', 'builtin'),
  c('batch', 'builtin'),
  c('storage', 'user'),
  c('agent-desktop', 'user'),
  c('stickerwu-imagegen', 'user'),
  c('superpowers:subagent-driven-development', 'plugin', { owner: 'superpowers', aliases: ['subagent-driven-development'] }),
  c('superpowers:dispatching-parallel-agents', 'plugin', { owner: 'superpowers', aliases: ['dispatching-parallel-agents'] }),
  c('anthropic-skills:agent-desktop', 'plugin', { owner: 'anthropic-skills', aliases: ['agent-desktop'] }),
  c('cctool:install', 'plugin', { owner: 'cctool' }),
  c('review-pr', 'user'),
  c('rea:trace_crash (MCP)', 'mcp', { owner: 'rea' }),
  c('hud', 'other'),
];

describe('groupOf', () => {
  it('commands / skills / other', () => {
    expect(groupOf(c('compact', 'builtin'))).toBe('commands');
    expect(groupOf(c('simplify', 'bundled'))).toBe('commands');
    expect(groupOf({ name: 'help', description: '', argumentHint: '' })).toBe('commands'); // an old server / an ACP agent
    expect(groupOf(c('storage', 'user'))).toBe('skills');
    expect(groupOf(c('deploy', 'project'))).toBe('skills');
    expect(groupOf(c('superpowers:x', 'plugin'))).toBe('skills');
    expect(groupOf(c('review-pr', 'user', { kind: 'command' }))).toBe('other');
    expect(groupOf(c('rea:x (MCP)', 'mcp'))).toBe('other');
    expect(groupOf(c('hud', 'other'))).toBe('other');
  });
});

describe('buildCommands', () => {
  const disk = [c('storage', 'user', { kind: 'skill' }), c('review-pr', 'user', { kind: 'command' }), c('cctool:install', 'plugin', { owner: 'cctool', kind: 'command' }), c('only-on-disk', 'user', { kind: 'skill' })];
  it('the running process wins; the disk only says which rows are commands', () => {
    const l = buildCommands(ENGINE, disk, [BTW]);
    expect(l[0]).toBe(BTW);
    expect(l.find((x) => x.name === 'review-pr')?.kind).toBe('command');
    expect(l.find((x) => x.name === 'cctool:install')?.kind).toBe('command');
    expect(l.find((x) => x.name === 'storage')?.kind).toBe('skill');
    expect(l.some((x) => x.name === 'only-on-disk')).toBe(false);
  });
  it('not running (no list, or an empty one): the disk', () => {
    expect(buildCommands(undefined, disk, [BTW]).map((x) => x.name)).toEqual(['btw', 'storage', 'review-pr', 'cctool:install', 'only-on-disk']);
    expect(buildCommands([], disk, [BTW])).toHaveLength(5);
    expect(buildCommands(undefined, undefined, [BTW])).toEqual([BTW]);
  });
  it('ours is not doubled by an engine row of the same name; rows from an old server get their source', () => {
    const l = buildCommands([{ name: 'btw', description: 'theirs', argumentHint: '' }, { name: 'x', description: 'A skill (user)', argumentHint: '' }], undefined, [BTW]);
    expect(l.filter((x) => x.name === 'btw')).toEqual([BTW]);
    expect(l.find((x) => x.name === 'x')).toMatchObject({ source: 'user', description: 'A skill' });
  });
});

describe('matchCommand', () => {
  it('prefix of the name, of the part after plugin:, of an alias; a word start; anywhere', () => {
    expect(matchCommand(c('agents', 'builtin'), 'agent')).toEqual({ tier: 0, hit: [0, 5] });
    expect(matchCommand(c('anthropic-skills:agent-desktop', 'plugin'), 'agent')).toEqual({ tier: 0, hit: [17, 22] });
    expect(matchCommand(c('usage', 'builtin', { aliases: ['cost'] }), 'co')).toEqual({ tier: 0, hit: null, alias: 'cost', aliasHit: [0, 2] });
    expect(matchCommand(c('list-agents', 'builtin'), 'agent')).toEqual({ tier: 1, hit: [5, 10] });
    expect(matchCommand(c('superpowers:subagent-driven-development', 'plugin'), 'agent')).toEqual({ tier: 2, hit: [15, 20] });
    expect(matchCommand(c('usage', 'builtin'), 'age')).toEqual({ tier: 2, hit: [2, 5] });
    expect(matchCommand(c('compact', 'builtin'), 'agent')).toBeNull();
    expect(matchCommand(c('compact', 'builtin'), '')).toEqual({ tier: 0, hit: null });
  });
});

describe('slashMenu', () => {
  it('/agent: grouped, prefix hits before middle ones, then by name — what the other client found is all there', () => {
    const m = slashMenu(buildCommands(ENGINE, undefined, [BTW]), 'agent');
    expect(m.groups.map((g) => g.id)).toEqual(['commands', 'skills']);
    expect(m.groups[0].items.map((i) => i.cmd.name)).toEqual(['agents', 'list-agents']);
    expect(m.groups[1].items.map((i) => i.cmd.name)).toEqual([
      'agent-desktop', 'anthropic-skills:agent-desktop', // prefix (of the name / of the part after the plugin)
      'superpowers:dispatching-parallel-agents', // a word starts with it
      'superpowers:subagent-driven-development', // inside a word
    ]);
    expect(m.flat.map((i) => i.cmd.name)).toEqual([...m.groups[0].items, ...m.groups[1].items].map((i) => i.cmd.name));
  });
  it('/ alone: every row (no cap), the three groups in order, empty groups left out', () => {
    const many = Array.from({ length: 120 }, (_, i) => c(`skill-${String(i).padStart(3, '0')}`, 'user'));
    const disk = [c('review-pr', 'user', { kind: 'command' }), c('cctool:install', 'plugin', { owner: 'cctool', kind: 'command' })];
    const m = slashMenu(buildCommands([...ENGINE, ...many], disk, [BTW]), '');
    expect(m.flat).toHaveLength(1 + ENGINE.length + 120);
    expect(m.groups.map((g) => g.id)).toEqual(['commands', 'skills', 'other']);
    expect(m.groups[0].items.map((i) => i.cmd.name)).toEqual(['agents', 'batch', 'btw', 'compact', 'list-agents', 'usage']);
    expect(m.groups[2].items.map((i) => i.cmd.name)).toEqual(['cctool:install', 'hud', 'rea:trace_crash (MCP)', 'review-pr']);
    expect(slashMenu([c('compact', 'builtin')], 'zzz')).toEqual({ groups: [], flat: [] });
  });
  it('case does not matter', () => {
    expect(slashMenu([c('Compact', 'builtin')], 'COM').flat).toHaveLength(1);
  });
});

describe('nameParts / typedExactly', () => {
  it('splits around the hit', () => {
    expect(nameParts('list-agents', [5, 10])).toEqual([{ text: 'list-', hit: false }, { text: 'agent', hit: true }, { text: 's', hit: false }]);
    expect(nameParts('agents', [0, 6])).toEqual([{ text: 'agents', hit: true }]);
    expect(nameParts('usage', null)).toEqual([{ text: 'usage', hit: false }]);
  });
  it('the box already names the selected row (or one of its aliases)', () => {
    const item = slashMenu([c('usage', 'builtin', { aliases: ['cost'] })], 'cost').flat[0];
    expect(typedExactly('/cost', item)).toBe(true);
    expect(typedExactly('/usage', item)).toBe(true);
    expect(typedExactly('/us', item)).toBe(false);
    expect(typedExactly('/cost', undefined)).toBe(false);
  });
});
